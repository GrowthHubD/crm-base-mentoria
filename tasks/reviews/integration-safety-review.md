# Auditoria de segurança das integrações e isolamento de dados

**Data:** 2026-09-04
**Input avaliado:** código TypeScript, schema Drizzle, migrations, testes e documentação do projeto
**Escopo:** webhooks WhatsApp, ingestão de mensagens, identificação de leads, conexões, escopo por dono e unidade, eventos em tempo real e contratos que futuras otimizações não podem alterar
**Restrições:** análise somente leitura do código. Nenhuma correção foi implementada.

## Resumo executivo

Foram encontrados 7 problemas: 3 críticos, 3 altos e 1 médio. O defeito mais alinhado ao relato de leads de outro perfil aparecerem e depois desaparecerem está confirmado no backend: a identidade do lead é global por `(channel, externalContactId)`. Quando o mesmo contato conversa com números de WhatsApp de dois BDRs, o sistema reutiliza o mesmo lead e troca `connectionId` e `ownerId` para o último número que recebeu uma mensagem. Isso move o card entre perfis e mistura o histórico de duas relações comerciais.

O caminho uazapi usado em produção também reconhece o webhook com HTTP 200 antes de possuir uma cópia durável do evento. No regime Cloudflare, sem Redis, qualquer falha após a resposta fica somente no log e a mensagem não tem mecanismo de reprocessamento. Meta e Evolution já usam `webhook_events` com persistência antes do processamento, mas uazapi ainda mantém um pipeline paralelo e menos resiliente.

Qualquer otimização de consultas ou troca rápida de filtros deve ser feita depois de congelar contratos e criar testes de caracterização. Otimizar agora, sem corrigir a identidade e o roteamento, pode tornar a resposta mais rápida sem impedir a exposição e a movimentação indevida dos cards.

### Contagem de findings

| Severidade | Quantidade |
|---|---:|
| Crítico | 3 |
| Alto | 3 |
| Médio | 1 |
| Baixo | 0 |
| **Total** | **7** |

## Contratos externos verificados

- O exemplo oficial mantido pela Meta valida `x-hub-signature-256` e confirma o challenge do GET. Isso sustenta a necessidade de assinatura obrigatória no POST: [Meta WhatsApp API examples](https://github.com/fbsamples/whatsapp-api-examples).
- A documentação oficial da Evolution confirma configuração por instância, lista explícita de eventos e a alteração da URL quando `webhook_by_events` é habilitado: [Evolution webhook documentation](https://github.com/evolution-foundation/evolution-docs/blob/main/docs/02-Configuration/Webhooks.md).
- A documentação oficial atual da Evolution expõe `webhookByEvents`, `webhookBase64` e a lista de eventos no contrato de configuração: [Evolution Set Webhook](https://docs.evoapicloud.com/api-reference/webhook/set).

## Parte 1: findings

### Findings críticos

#### [FC-001] A identidade global do lead transfere cards entre perfis e mistura conversas

- **Categoria:** gap de tradução e OWASP API1, Broken Object Level Authorization
- **Localização:** `src/lib/db/schema/leads.ts:153-156`, `drizzle/0000_past_living_tribunal.sql:305`, `src/modules/leads/mutations.ts:95-119`, `src/modules/leads/mutations.ts:125-171`
- **Evidência:** o índice único e o lookup do upsert usam somente `channel` e `externalContactId`. `connectionId`, `ownerId` e `unitId` não fazem parte da identidade. Ao encontrar o contato, o código sobrescreve `connectionId` e, com `FEATURE_LEAD_OWNERSHIP=true`, também `ownerId`. Essa flag está ativa em `wrangler.jsonc:261` e `wrangler.acme.jsonc:44`.
- **Vetor concreto:** o mesmo telefone fala com o número do BDR A e depois com o número do BDR B. A segunda entrada reutiliza o card do A, muda sua conexão e seu dono para B e mantém as mensagens anteriores no mesmo `leadId`. O card some da carteira A e aparece em B. Uma nova mensagem pelo número A faz o movimento inverso.
- **Impacto:** exposição de histórico entre perfis, card oscilando entre filtros, envio posterior pela conexão errada e perda da noção de qual conversa pertence a qual número.
- **Correção proposta:** decidir e documentar a identidade de conversa antes de otimizar. Para carteira por dono ou múltiplos números, a chave segura deve incluir a fronteira operacional, preferencialmente `(connectionId, externalContactId)` para WhatsApp. Criar uma migration que remova o índice atual somente depois de separar registros já colididos e reassociar mensagens de forma auditável. Não fazer alteração automática de `ownerId` em um upsert cuja identidade não inclua o dono ou a conexão.
- **Regra modular:** concentrar a mudança em `modules/leads` e na migration. Parsers e adapters não devem conhecer a regra de identidade.

#### [FC-002] O webhook uazapi confirma recebimento antes de persistir e pode perder mensagens definitivamente

- **Categoria:** ponto cego de erro e perda de dados
- **Localização:** `src/app/api/webhooks/whatsapp/[connectionId]/route.ts:67-126`, `src/app/api/webhooks/whatsapp/route.ts:59-114`, `src/modules/webhook-events/service.ts:1-41`
- **Evidência:** as duas rotas uazapi fazem parse, tentam fila e, sem fila, iniciam `processInboundPayload` em background. Elas retornam `{ ok: true }` mesmo quando o processamento falha. Diferentemente das rotas Meta e Evolution, não chamam `persistEvent`, não gravam payload cru e não alimentam o sweeper. A documentação do projeto confirma que Cloudflare roda sem Redis.
- **Impacto:** falha transitória de banco, parser, storage ou lookup depois do HTTP 200 elimina a única cópia processável do evento. O provedor considera entregue, o CRM não cria a mensagem e não existe reprocessamento.
- **Correção proposta:** portar o pipeline persist-first já usado por Meta e Evolution para um módulo de ingestão uazapi. O handler deve autenticar, validar o limite do corpo, persistir uma chave estável, responder, processar em background e marcar `done` ou `pending/failed`. Manter a resposta pública e o parser compatíveis. Não introduzir chamada direta ao provedor fora do adapter.
- **Regra modular:** rota fina em `app/api`, persistência em `modules/webhook-events`, parser em `modules/channels/whatsapp` e regra comum em `process-inbound.ts`.

#### [FC-003] Socket.IO permite assinatura anônima da sala que transmite PII

- **Categoria:** autenticação e autorização
- **Localização:** `src/lib/socket.ts:8-20`, `src/lib/socket.ts:29-33`, `src/modules/leads/service.ts:33-34`, `src/modules/leads/service.ts:66-79`, `src/modules/messages/service.ts:42-82`, `server.ts:28-44`
- **Evidência:** o middleware do Socket chama `next()` sem validar sessão. Qualquer cliente pode emitir `join:empresa` com a string `crm`. Serviços publicam o lead completo e mensagens nessa sala única. A sala é controlada pelo cliente e não é derivada de identidade autenticada.
- **Vetor concreto:** um cliente Socket.IO sem login conecta ao servidor Node, emite `join:empresa` com `crm` e passa a receber novos leads e mensagens com PII.
- **Impacto:** vazamento em tempo real de dados pessoais e conversas. Se a interface passar a usar Socket.IO como otimização, o problema deixa de ser apenas uma superfície latente e vira o canal principal de exposição.
- **Correção proposta:** bloquear qualquer ativação de realtime até validar a sessão no handshake e calcular salas no servidor. Salas devem representar o escopo autorizado, por exemplo instância mais dono ou unidade, sem aceitar um identificador arbitrário do cliente. O payload também precisa ser mínimo e filtrado por escopo.
- **Regra modular:** autenticação e roteamento de salas pertencem a um boundary de realtime/autorização. Serviços de leads e mensagens publicam eventos de domínio sem decidir permissões.

### Findings altos

#### [FA-001] Falha de roteamento cai na primeira conexão e pode associar mensagem ao perfil errado

- **Categoria:** salto lógico
- **Localização:** `src/modules/channels/whatsapp/process-inbound.ts:211-249`
- **Evidência:** se o `connectionIdOverride` não existir, o código tenta resolver pelo `instanceName`. Se ainda falhar, seleciona a primeira conexão WhatsApp sem ordenação e, se não houver, cria uma conexão automática como `connected`.
- **Impacto:** payload com path incorreto, conexão removida ou parser incompleto não falha de forma fechada. A mensagem entra pelo primeiro número encontrado e herda seu dono. Isso produz lead no perfil errado e mascara erro de configuração.
- **Correção proposta:** rota com `connectionId` deve usar esse ID como autoridade e falhar para uma fila durável quando ele não existir. A rota legada pode resolver apenas por identificador inequívoco do payload. Remover fallback para a primeira conexão e auto-criação do hot path.

#### [FA-002] O isolamento por unidade não é ponta a ponta e o inbound não propaga `unitId`

- **Categoria:** gap de tradução e OWASP API1, Broken Object Level Authorization
- **Localização:** `src/modules/channels/whatsapp/process-inbound.ts:213-220`, `src/modules/channels/whatsapp/process-inbound.ts:258-277`, `src/modules/units/service.ts:85-103`, `src/lib/escopo-dono.ts:92-110`, `src/app/api/crm/search/route.ts:12-26`, `src/modules/pipeline/queries.ts:429-445`, `src/app/api/leads/[id]/route.ts:22-30`, `src/app/api/leads/[id]/messages/route.ts:43-68`
- **Evidência:** o lookup por override seleciona apenas `id` e `status`, mas depois lê `unitId` por cast. Nesse caminho `unitId` será sempre ausente. O filtro de unidade inclui registros `unit_id IS NULL`, portanto esses leads aparecem em qualquer unidade selecionada. Busca global e guards de detalhe protegem apenas por dono, sem checagem de unidade.
- **Impacto:** ao ligar `FEATURE_UNITS`, novos inbounds da rota canônica nascem sem unidade e ficam visíveis em várias filiais. IDs conhecidos e pesquisa textual permitem acesso cruzado quando o isolamento por dono não estiver habilitado ou não coincidir com unidades.
- **Correção proposta:** criar um único `AccessScope` composto e aplicá-lo nas queries de coleção e nos guards de recurso. Selecionar `connections.unitId` no ingest, exigir unidade válida para conexão quando o módulo estiver ativo e definir um plano de backfill. `IS NULL` pode existir apenas durante migração controlada e não como autorização permanente.

#### [FA-003] Assinaturas de webhook estão fail-open e o provisionamento uazapi não configura o segredo esperado

- **Categoria:** dependência fantasma e autenticação de webhook
- **Localização:** `src/app/api/webhooks/whatsapp/[connectionId]/route.ts:49-65`, `src/app/api/webhooks/whatsapp/route.ts:41-57`, `src/app/api/webhooks/meta/[connectionId]/route.ts:89-101`, `src/modules/channels/whatsapp/client.ts:344-360`, `.env.example:84`, `.env.example:123`
- **Evidência:** uazapi e Meta aceitam qualquer payload quando suas variáveis de segredo estão ausentes. Para uazapi, `setWebhook` envia URL, eventos e flags, mas não configura header customizado, enquanto o receptor espera `x-webhook-secret` ou `x-uazapi-secret`. O teste estrutural descreve incorretamente `connectionId` como validação em `src/__tests__/route-auth-guard.test.ts:32-33`.
- **Impacto:** ambiente mal configurado permite injeção de leads, automações e chamadas de IA. Se o segredo for simplesmente tornado obrigatório sem coordenar o provedor, mensagens reais podem parar de entrar.
- **Correção proposta:** tratar segredo como pré-condição validada no boot e no provisionamento. Primeiro provar em ambiente de homologação qual header a versão uazapi usada envia e configurar o mesmo valor dos dois lados. Depois mudar o handler para fail-closed. Para Meta, exigir `META_APP_SECRET` em produção. Preservar HTTP 200 para assinatura inválida apenas se esse for o contrato operacional escolhido, mas nunca processar nem persistir o payload inválido.

### Finding médio

#### [FM-001] O mesmo `jobId` pode deduplicar eventos semanticamente diferentes da uazapi

- **Categoria:** gap de tradução
- **Localização:** `src/app/api/webhooks/whatsapp/[connectionId]/route.ts:30-40`, `src/app/api/webhooks/whatsapp/[connectionId]/route.ts:73-84`, `src/app/api/webhooks/whatsapp/route.ts:25-36`, `src/app/api/webhooks/whatsapp/route.ts:67-78`, `src/modules/channels/whatsapp/process-inbound.ts:55-148`
- **Evidência:** `jobId` é derivado apenas do ID da mensagem. O mesmo ID participa do evento inicial e de eventos posteriores de status, edição ou reação. Jobs concluídos permanecem na fila até o limite de 200. BullMQ usa o ID como chave de deduplicação da fila.
- **Impacto:** um `messages_update` pode colidir com o job do evento `messages`, omitindo delivered/read, edição ou reação. O efeito é visual e pode parecer glitch de sincronização.
- **Correção proposta:** incluir o tipo do evento e, para status, o estado ou hash estável do conteúdo no `jobId`. A idempotência da mensagem continua no `external_id`; a do evento precisa distinguir transições válidas.

## Invariantes obrigatórios para qualquer correção ou otimização

1. Uma entrada autenticada deve ser associada exatamente à conexão indicada pela URL ou por um identificador inequívoco do payload. Nunca selecionar a primeira conexão como fallback.
2. A identidade de uma conversa deve incluir sua fronteira operacional. Mensagens do mesmo contato recebidas em conexões diferentes não podem transferir automaticamente o card nem compartilhar histórico sem uma regra explícita de merge.
3. HTTP 200 de webhook só pode significar uma destas condições: evento rejeitado por autenticação de forma consciente, evento duplicado já persistido ou evento novo persistido duravelmente.
4. `messages.external_id` continua sendo a proteção de idempotência da mensagem. A deduplicação de evento é separada e precisa preservar status, edições e reações.
5. Parsers de uazapi, Meta e Evolution continuam produzindo `ParsedInbound`. Regras de lead, automação e mensagem continuam comuns em `ingestParsedInbound`.
6. Nenhuma otimização pode mover chamadas específicas de provedor para regras de negócio. Envio, mídia, typing e limitações do canal permanecem nos adapters.
7. O caminho com Redis e o caminho Cloudflare sem Redis devem produzir o mesmo estado final observável.
8. Filtros visuais nunca são autorização. Listas, busca, detalhe, mensagens, mutações, conexões e realtime aplicam o mesmo escopo derivado da sessão.
9. Um response antigo de filtro não pode substituir o estado de um filtro mais novo. Esse invariante é de UI, mas deve ser testado com respostas fora de ordem sem alterar os contratos de API.
10. Tokens continuam criptografados e nenhum payload bruto, token, telefone ou conteúdo de conversa deve aparecer em logs de erro sem política explícita de mascaramento.

## Plano de correção, sem implementação nesta auditoria

### Fase 0: congelar comportamento e observabilidade

- Criar testes de caracterização dos três provedores com fixtures reais sanitizadas.
- Registrar métricas por `provider`, `connectionId`, `eventKey`, resultado de persistência e resultado de ingestão, sem PII.
- Definir SLO: nenhum 200 de evento autenticado sem registro durável, salvo duplicata comprovada.

### Fase 1: corrigir identidade e roteamento

- Formalizar a chave de conversa por conexão e contato.
- Auditar colisões existentes antes da migration.
- Separar leads colididos e reassociar mensagens por evidência de conexão, com relatório reversível.
- Remover fallback para primeira conexão e auto-criação durante inbound.
- Garantir que dono e unidade sejam derivados da conexão resolvida e não de parâmetros do navegador.

### Fase 2: unificar durabilidade de webhooks

- Criar ingest uazapi persist-first usando `webhook_events`.
- Manter rotas finas e preservar formatos públicos atuais.
- Fazer o sweeper reprocessar uazapi, Meta e Evolution pelo mesmo contrato de estado.
- Separar chave de evento de chave de mensagem.

### Fase 3: fechar autorização composta

- Criar helper único de escopo com dono e unidade.
- Aplicar o helper em kanban, busca, detalhe, mensagens, mutações e conexões.
- Autenticar Socket.IO no handshake e derivar salas no servidor antes de usá-lo para otimização.

### Fase 4: otimizar sem regressão

- Somente após as fases anteriores, corrigir cancelamento e ordenação de requests no cliente.
- Medir queries do kanban, payload e latência p50, p95 e p99.
- Otimizar índices e projeções sem mudar shapes de resposta nem regras de ingestão.

## Plano de testes de regressão

### Matriz de identidade e isolamento

| Cenário | Resultado obrigatório |
|---|---|
| Mesmo telefone, mesma conexão, rajada concorrente | Um lead, mensagens sem duplicata |
| Mesmo telefone, conexões de donos diferentes | Dois contextos de conversa, nenhum histórico cruzado |
| Mesmo telefone, unidades diferentes | Nenhum card ou mensagem visível fora da unidade autorizada |
| BDR tenta abrir ID de lead de outro dono | 404 |
| Usuário de unidade A tenta busca, detalhe e mensagens da unidade B | Nenhum resultado e 404 |
| Admin sem recorte seleciona todas | Visão completa, conforme regra documentada |

### Matriz de webhook

Executar para uazapi, Meta e Evolution:

1. Assinatura válida e payload válido.
2. Assinatura ausente, inválida e segredo ausente em produção.
3. Corpo inválido, corpo acima do limite e evento desconhecido.
4. Banco indisponível antes de persistir.
5. Falha depois de persistir e antes de gravar mensagem.
6. Reentrega do mesmo evento.
7. Lote com uma mensagem válida e uma inválida.
8. Execução com Redis ligado e desligado.
9. Conexão inexistente, removida e path que não corresponde ao payload.
10. Status, edição e reação do mesmo `externalId` depois da mensagem inicial.

Para cada caso, provar: status HTTP, quantidade de `webhook_events`, quantidade de mensagens, `connectionId`, `ownerId`, `unitId`, tentativas, estado final e ausência de efeitos duplicados.

### Concorrência e filtros

- Disparar requests A, B e C para filtros diferentes e responder na ordem C, A, B. A tela deve manter C.
- Trocar conexão e status rapidamente enquanto chega inbound de outro dono. O card fora do escopo nunca deve ser renderizado, nem por um frame.
- Rodar duas instâncias do cron/sweeper sobre o mesmo evento. Mensagem, automação e IA devem ocorrer uma vez.
- Simular 100 mensagens concorrentes do mesmo contato na mesma conexão e em duas conexões diferentes.

### Contratos de saída

- Snapshot dos payloads HTTP das rotas de leads, kanban e mensagens antes e depois.
- Contract tests dos métodos de `ChannelAdapter` para uazapi, Meta e Evolution.
- Teste de equivalência de estado final entre fila BullMQ e fallback Cloudflare.
- Teste que impede imports específicos de provedor fora de `modules/channels`.

## Verificação executada

- Revisão estática do grafo completo entre webhook, parser, persistência, conexão, upsert do lead, mensagem, filtros e realtime.
- Conferência do schema e da migration que materializa o índice único global.
- Conferência de flags de produção em `wrangler.jsonc` e `wrangler.acme.jsonc`.
- Pesquisa em documentação oficial de Meta e Evolution.
- Tentativa de executar testes focados com Vitest. A suíte não iniciou porque o Vite falhou ao criar subprocesso com `spawn EPERM`. Nenhum teste chegou a rodar, portanto isso é uma limitação do ambiente e não um resultado de teste do sistema.
- `tasks/lessons.md` não existe neste checkout. Não houve correção do usuário dirigida a esta auditoria, então nenhuma lição foi criada.

## Parte 2: perguntas estratégicas

### Identidade comercial

**P1:** quando o mesmo contato fala com dois números de BDR, o produto deseja duas conversas independentes ou um contato único com múltiplas conversas?

- **Contexto:** essa decisão define schema, migration e UX. O estado atual tenta ter um lead único, mas conserva apenas uma conexão e um dono.
- **Findings relacionados:** FC-001, FA-001

**P2:** existe transferência explícita de carteira entre BDRs? Se sim, ela precisa mover também mensagens anteriores ou apenas responsabilidade futura?

- **Contexto:** transferência explícita é diferente de troca automática causada por qualquer inbound.
- **Findings relacionados:** FC-001

### Webhooks

**P3:** a versão uazapi em produção suporta configurar headers customizados no webhook, ou o segredo precisa vir de outro mecanismo do provedor?

- **Contexto:** tornar o segredo obrigatório sem coordenar o emissor interromperia recebimento.
- **Findings relacionados:** FA-003

**P4:** eventos `failed` em `webhook_events` possuem hoje alerta e operação de reprocessamento acessível ao time?

- **Contexto:** persistir evita perda silenciosa, mas sem alerta a fila durável ainda pode acumular falhas invisíveis.
- **Findings relacionados:** FC-002

### Unidades

**P5:** leads históricos com `unit_id = null` devem pertencer a uma unidade de migração, ao admin ou ficar visíveis em todas temporariamente?

- **Contexto:** a regra atual de incluir nulos em toda unidade favorece migração, mas não oferece isolamento forte.
- **Findings relacionados:** FA-002

## Parte 3: scorecard

### Nota geral de integridade

**28/100, REPROVADO**

Cálculo: 100, menos 45 por 3 críticos, menos 24 por 3 altos, menos 3 por 1 médio.

| Categoria | Score | Observação |
|---|---:|---|
| Gaps de tradução | 35/100 | Identidade, unidade e eventos de atualização perdem contexto |
| Saltos lógicos | 35/100 | Roteamento assume que a primeira conexão é aceitável |
| Alucinações arquiteturais | 85/100 | Adapters e contratos externos estão majoritariamente coerentes |
| Dependências fantasma | 55/100 | Segredo uazapi esperado pelo receptor não é provisionado pelo emissor |
| Loops sem saída | 85/100 | Retentativas duráveis têm limite, mas concorrência do sweeper requer teste |
| Pontos cegos de erro | 30/100 | uazapi não tem persistência nem recuperação após 200 |
| Segurança e multi-tenant | 20/100 | Socket anônimo e escopo por unidade incompleto |

### Áreas não avaliadas

- Configuração real dos webhooks e secrets no painel dos provedores, pois não há acesso ao estado externo nesta auditoria.
- Dados de produção, portanto colisões existentes entre telefone, conexão e dono não foram quantificadas.
- Comportamento visual detalhado de requests fora de ordem, coberto por outra frente da revisão.
- Execução da suíte, bloqueada pelo `spawn EPERM` antes da coleta de testes.

### Critérios dinâmicos aplicados

- Equivalência entre Cloudflare sem Redis e Node com BullMQ.
- Durabilidade antes do reconhecimento HTTP.
- Identidade de conversa em múltiplos números e donos.
- Isolamento composto por dono e unidade em toda superfície de leitura e escrita.
- Idempotência separada para evento, mensagem e efeitos derivados.
- Independência da regra de negócio em relação ao provedor.

## Apêndice: grafo do pipeline

```text
Provedor
  -> rota pública por connectionId
  -> autenticação do webhook
  -> persistência do evento cru
  -> parser específico do provedor
  -> ParsedInbound
  -> resolução inequívoca da connection
  -> identidade da conversa
  -> upsert do lead com ownerId e unitId
  -> gravação idempotente da mensagem
  -> automações, follow-up e IA
  -> consultas escopadas
  -> UI e realtime autorizados

Desvios atuais:
  uazapi -> sem persistência durável [FC-002]
  resolução -> primeira conexão ou auto-criação [FA-001]
  identidade -> canal mais telefone, sem conexão [FC-001]
  unidade -> perdida no override e ausente em guards [FA-002]
  realtime -> sala controlada por cliente anônimo [FC-003]
```
