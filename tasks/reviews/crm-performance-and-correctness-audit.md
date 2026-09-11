# Auditoria consolidada do CRM

Data: 04/09/2026

Escopo: lentidao do CRM, troca rapida de filtros e conexoes, isolamento visual
entre perfis, consultas do quadro, busca, chat e riscos de regressao no
recebimento de mensagens.

Restricao principal: esta etapa nao altera codigo de produto, contratos de API,
adapters, parsers, webhooks, filas, envio ou recebimento de mensagens.

## Parecer executivo

O glitch relatado foi confirmado no codigo e possui reproducao deterministica.
Quando o usuario troca para uma conexao ainda sem cache, o estado `data` continua
contendo o quadro anterior. O componente liga `loading`, mas continua renderizando
os leads antigos ate a resposta nova chegar. A correcao recente com `connSeq`
impede uma resposta atrasada de outra aba de sobrescrever a aba atual, mas nao
impede que o payload antigo ja presente no estado continue visivel.

Ha tambem uma causa de backend mais grave. A identidade do lead e global por
`(channel, externalContactId)`. Se o mesmo telefone conversar com duas conexoes,
o upsert reutiliza o mesmo lead e troca `connectionId` e `ownerId`. O card pode
oscilar entre perfis, e as mensagens permanecem ligadas ao mesmo historico. Uma
correcao apenas visual elimina o flash de dados errados, mas nao resolve essa
transferencia real de propriedade.

A lentidao e estrutural no read path. Uma tela visivel busca o quadro completo a
cada 2 segundos. Cada resposta pode envolver ate 2.800 leads, pelo menos seis
consultas, ate 5.000 linhas de mensagens humanas e milhares de cards no DOM. No
Worker, as consultas compartilham uma unica conexao por request e sao
serializadas. O banco tambem nao declara indices de `leads` alinhados aos filtros
e ordenacoes quentes.

Conclusao: o modulo de leitura do CRM precisa ser reorganizado. Nao e necessario
reescrever o sistema nem tocar imediatamente no pipeline de mensagens. A primeira
entrega deve corrigir escopo, cache, concorrencia e custo das leituras. A mudanca
de identidade da conversa e a durabilidade do webhook ficam em uma fase
protegida, com testes e migracao reversivel.

## Findings criticos

### FC-001: identidade do lead mistura conexoes e donos

Localizacao:

- `src/lib/db/schema/leads.ts:153`
- `src/modules/leads/mutations.ts:95`
- `src/modules/leads/mutations.ts:125`

Evidencia: a chave unica e o lookup usam somente canal e contato. O update troca
a conexao e, quando a carteira por dono esta ativa, troca tambem o dono.

Impacto: card muda de perfil, historico de duas relacoes comerciais pode ser
misturado e um envio posterior pode escolher um contexto operacional incorreto.

Acao: fase protegida. Formalizar identidade por conexao e contato, auditar
colisoes existentes e migrar os dados antes de trocar o indice. Nao aplicar junto
com o primeiro pacote de performance.

### FC-002: busca nao aplica escopo de unidade

Localizacao:

- `src/app/api/crm/search/route.ts:12`
- `src/modules/pipeline/queries.ts:429`

Evidencia: a rota aplica dono, mas nao le `x-unit-id`. A query nao aceita
`unitId`. Nome, telefone e trecho de mensagem podem aparecer fora da unidade
selecionada.

Impacto: exposicao de PII entre unidades e resultados de outro perfil de
visualizacao.

Acao: aplicar o mesmo escopo composto das filas em busca, detalhe e mensagens.
Essa mudanca fica apenas em autorizacao e leitura.

### FC-003: caches autenticados nao incluem a identidade do usuario

Localizacao:

- `src/app/(dashboard)/crm/page.tsx:220`
- `src/app/(dashboard)/crm/page.tsx:389`
- `src/lib/useDados.ts:34`
- `src/components/Sidebar.tsx:150`

Evidencia: `boardCache` usa apenas a conexao. O cache generico usa URL e unidade.
Logout e login sao navegacoes client-side, portanto os mapas do modulo podem
sobreviver a troca de conta.

Impacto: a conta B pode ver por alguns instantes dados cacheados da conta A no
mesmo navegador.

Acao: usar uma `scopeKey` opaca que inclua identidade, unidade e filtro, e limpar
caches autenticados na mudanca de sessao.

### FC-004: webhook uazapi pode reconhecer antes de possuir copia duravel

Localizacao:

- `src/app/api/webhooks/whatsapp/[connectionId]/route.ts:67`
- `src/modules/webhook-events/service.ts:1`

Evidencia: no regime sem Redis, o processamento ocorre em background depois do
HTTP 200, sem persistencia previa em `webhook_events`. Falha posterior fica no
log e nao possui reprocessamento.

Impacto: perda silenciosa de mensagem autenticada.

Acao: nao alterar agora. Criar testes de caracterizacao e, numa fase protegida,
portar o padrao persist-first ja usado pelos outros provedores, preservando o
payload publico e o parser.

## Findings altos

### FA-001: payload anterior continua renderizado durante troca de conexao

Localizacao:

- `src/app/(dashboard)/crm/page.tsx:385`
- `src/app/(dashboard)/crm/page.tsx:763`
- `src/app/(dashboard)/crm/page.tsx:805`

Causa: o estado nao associa o payload ao escopo que o produziu. No cache miss,
somente `loading` muda, enquanto `data` permanece valido para o render.

Acao imediata: estado etiquetado por `scopeKey`. O quadro so pode renderizar um
payload cuja chave seja igual a chave ativa.

### FA-002: resultados antigos permanecem durante uma nova busca

Localizacao: `src/app/(dashboard)/crm/page.tsx:253` e
`src/app/(dashboard)/crm/page.tsx:795`.

Causa: `searchResults` nao inclui a chave da consulta e nao e limpo na mudanca de
conexao ou termo.

Acao imediata: resultado e loading pertencem a mesma `queryKey`; resultado de
outra chave nunca entra no render.

### FA-003: leituras concorrentes da mesma aba podem chegar fora de ordem

Localizacao: `src/app/(dashboard)/crm/page.tsx:344`,
`src/app/(dashboard)/crm/page.tsx:399`,
`src/app/(dashboard)/crm/page.tsx:665`.

Causa: polling, foco, refresh manual e refresh pos-movimento iniciam `load()` sem
single-flight. `connSeq` protege apenas mudanca de aba, nao ordena requests da
mesma aba.

Acao imediata: um coordenador de leitura no modulo `pipeline`, com single-flight
por escopo, `AbortController` para escopo abandonado e sequencia por request.
Validar a resposta antes de atualizar o cache.

### FA-004: snapshot integral e caro e repetido a cada 2 segundos

Localizacao:

- `src/app/(dashboard)/crm/page.tsx:106`
- `src/modules/pipeline/queries.ts:167`
- `src/modules/pipeline/queries.ts:215`
- `src/modules/pipeline/queries.ts:244`
- `src/lib/db/client.ts:229`

Causa: um agregado derivado de tabelas transacionais e reconstruido em alta
frequencia. Conexoes, previews e atendentes sao relidos mesmo quando nao mudam.

Acao: instrumentar por fase, impedir sobreposicao, reduzir frequencia, retirar
dados estaveis do poll e carregar arquivos fechados sob demanda. Preservar o
shape atual durante a primeira etapa.

### FA-005: consultas quentes de leads nao possuem indices alinhados

Localizacao: `src/lib/db/schema/leads.ts:152` e
`src/modules/pipeline/queries.ts:116`.

Causa: o unico indice declarado em `leads` serve para deduplicacao. O quadro
filtra por status, conexao, dono e unidade, e ordena por varios timestamps.

Acao: consultar `pg_indexes` e executar `EXPLAIN (ANALYZE, BUFFERS)` no banco
real. Criar somente os indices comprovados, com `CONCURRENTLY`, monitorando a
escrita de inbound.

### FA-006: ate 2.000 cards ativos sao montados sem janela virtual

Localizacao: `src/modules/pipeline/queries.ts:168` e
`src/app/(dashboard)/crm/page.tsx:1493`.

Causa: limite de seguranca do servidor virou orcamento de render do navegador.

Acao: extrair board e cards para `src/modules/pipeline/components/`, estabilizar
props e callbacks, depois aplicar virtualizacao por coluna ou paginacao
incremental compativel com drag and drop.

### FA-007: roteamento inbound possui fallback para a primeira conexao

Localizacao: `src/modules/channels/whatsapp/process-inbound.ts:211`.

Causa: se o override e o identificador do payload nao resolverem a conexao, o
fluxo escolhe a primeira conexao WhatsApp e pode criar uma conexao automatica.

Impacto: mensagem pode herdar dono incorreto e o erro de configuracao fica
mascarado.

Acao: fase protegida. Persistir o evento e falhar de forma recuperavel quando a
conexao nao for inequivoca. Nunca escolher a primeira conexao.

## Findings medios

- O chat busca ate 200 mensagens a cada 4 segundos enquanto o board continua
  buscando a cada 2 segundos. Ref: `src/components/crm/ChatPanel.tsx:220`.
- A busca usa `ILIKE '%termo%'` em tres colunas de mensagens e duas de leads,
  sem indice textual observado. Ref: `src/modules/pipeline/queries.ts:447`.
- A aba E-mail nao envia um filtro de canal para a busca. Ref:
  `src/app/(dashboard)/crm/page.tsx:262`.
- O indice composto de mensagens depende de script separado e pode faltar em
  instalacoes antigas. Ref: `scripts/create-messages-index.ts:39`.
- O `jobId` da uazapi usa apenas a mensagem e pode colidir entre evento inicial e
  atualizacao de status, edicao ou reacao.
- O Socket.IO do servidor Node nao autentica o handshake e aceita uma sala
  controlada pelo cliente. Na implantacao atual em Cloudflare essa superficie nao
  e o transporte principal, mas bloqueia qualquer ativacao futura de realtime
  sem correcao.

## Pontos positivos

- A query da ultima mensagem ja usa `DISTINCT ON`, evitando transferir o
  historico completo por lead.
- Existe indice composto adequado para ultima mensagem quando o script de
  provisionamento foi executado.
- O polling pausa quando a aba do navegador fica invisivel.
- `boardSig` evita parte dos commits React quando o snapshot e identico.
- `connSeq` resolveu uma corrida entre abas, embora nao resolva estado antigo nem
  concorrencia dentro da mesma aba.
- O servidor aplica recorte de dono na fila e na busca, e aplica unidade na fila.

## Plano de aplicacao

### Fase 0: baseline e trava de contratos

Objetivo: provar o comportamento atual antes de editar.

1. Criar fixtures sanitizadas e contract tests de filas, busca, chat, uazapi,
   Meta e Evolution.
2. Salvar snapshots dos payloads HTTP de leitura e dos resultados finais de
   ingestao.
3. Instrumentar `Server-Timing`, bytes por resposta, requests em voo e tempo por
   fase da query, sem PII.
4. Medir p50, p95 e p99, planos SQL, quantidade de nos DOM e commits React.
5. Registrar uma regra de CI que rejeite imports de provedor fora de adapters e
   parsers.

Saida: baseline repetivel e prova de que o primeiro pacote nao altera mensagens.

### Fase 1: corrigir glitches e isolamento visual

Objetivo: nenhum frame pode exibir dados de outro escopo.

1. Criar `src/modules/pipeline/hooks/useCrmBoardData.ts`.
2. Modelar estado como `{ scopeKey, payload, status }`.
3. Compor `scopeKey` com identidade opaca, unidade, conexao ou canal.
4. Renderizar somente payload correspondente ao escopo ativo.
5. Aplicar a mesma estrategia a busca com `queryKey`.
6. Limpar caches autenticados em logout e mudanca de sessao.
7. Adicionar single-flight, aborto de escopo abandonado e sequencia por request.

Saida: troca A, B, A sem flash, sem resposta fora de ordem e com no maximo uma
leitura ativa por escopo.

### Fase 2: fechar escopo das rotas de leitura

Objetivo: lista, busca e detalhe aplicam exatamente a mesma autorizacao.

1. Criar um helper de escopo composto no modulo de autorizacao.
2. Aplicar dono e unidade a filas, busca, detalhe, mensagens e conexoes.
3. Validar `channel=email` na busca da aba E-mail.
4. Adicionar testes negativos que esperam nenhum resultado ou HTTP 404 fora do
   escopo.

Saida: zero PII fora de unidade ou dono, sem tocar no recebimento.

### Fase 3: reduzir custo do read path

Objetivo: aliviar banco, Worker, rede e navegador sem mudar o contrato externo de
mensagens.

1. Confirmar indices reais e planos com volume de producao.
2. Criar indices comprovados com `CONCURRENTLY` e verificar `indisvalid`.
3. Garantir que `idx_messages_lead_id_timestamp` exista em toda instalacao.
4. Separar conexoes e configuracao do poll quente.
5. Carregar respondidos e convertidos sob demanda.
6. Reduzir o polling e usar refresh imediato apos mutacoes locais.
7. Introduzir versao do snapshot ou ETag antes de considerar um protocolo
   incremental.

Saida: reducao mensuravel de TTFB, bytes e tempo total de banco.

### Fase 4: reduzir custo de render e chat

Objetivo: manter interacao fluida mesmo com milhares de leads.

1. Mover componentes especificos do CRM para a vertical `modules/pipeline`.
2. Virtualizar cards por coluna com suporte testado a drag and drop.
3. Estabilizar props e callbacks antes de aplicar memoizacao.
4. Fazer carga inicial paginada do chat e polls posteriores apenas por novidade.
5. Pausar poll do chat quando invisivel e evitar trocar o array quando nada mudou.
6. Medir busca textual e adicionar trigram apenas se o plano real justificar.

Saida: nenhum long task relevante na troca de filtros e volume DOM limitado.

### Fase 5: corrigir identidade e durabilidade, fase protegida

Objetivo: eliminar a transferencia real de leads e a perda silenciosa de inbound.

Condicao: iniciar somente depois das fases 0 a 2 e com aprovacao explicita, pois
esta fase altera associacao interna de mensagens e exige migracao de dados.

1. Auditar colisoes por telefone, conexao, dono e unidade em producao.
2. Definir identidade por fronteira operacional.
3. Criar migracao reversivel que separa leads colididos e reassocia mensagens por
   evidencia de conexao.
4. Trocar a chave unica somente depois do backfill validado.
5. Remover fallback para primeira conexao.
6. Persistir webhook uazapi antes do HTTP 200 e reutilizar o sweeper existente.
7. Separar idempotencia do evento da idempotencia da mensagem.
8. Rodar matriz de equivalencia com Redis ligado e desligado.

Saida: mesmo telefone em duas conexoes gera contextos independentes, nenhuma
mensagem autenticada recebe 200 sem copia duravel e nenhum contrato externo muda.

## Criterios de aceite

1. Nenhum frame mostra payload cuja `scopeKey` difere do filtro ativo.
2. Logout da conta A e login da conta B nao reutiliza dado autenticado de A.
3. Requests A, B e C respondendo em C, A, B mantem C na tela.
4. Existe no maximo uma leitura do quadro em voo por escopo.
5. Busca, fila, detalhe e mensagens negam dono ou unidade divergente.
6. A primeira entrega nao modifica arquivos de webhook, adapter, parser,
   `process-inbound`, filas ou envio.
7. Snapshots de contratos HTTP permanecem compativeis.
8. Testes dos tres provedores e idempotencia continuam verdes.
9. O ganho de performance e demonstrado por baseline antes e depois, nao por
   percepcao subjetiva.
10. Toda migracao de dados possui dry-run, contagem, relatorio e rollback.

## Verificacao executada

- Leitura estatica do fluxo de UI, cache, busca, queries, schema, auth, unidade,
  dono, ingestao e realtime.
- Comparacao com o commit `d0d2b30`, que introduziu `connSeq` para a troca rapida.
- `npm run typecheck`: concluido com codigo 0.
- `npm audit --omit=dev --audit-level=high`: zero vulnerabilidades reportadas.
- `npm test`: nao iniciou. O Vitest falhou ao carregar a configuracao por
  `spawn EPERM`, antes de executar qualquer assertion.
- Browser autenticado e profiling do banco de producao: nao executados por falta
  de sessao de navegador e credenciais locais no workspace.

## Referencias tecnicas

- React recomenda que o cleanup aborte o fetch ou ignore respostas antigas para
  evitar race conditions: https://react.dev/learn/synchronizing-with-effects
- `AbortController` cancela fetch e consumo da resposta:
  https://developer.mozilla.org/en-US/docs/Web/API/AbortController/abort
- PostgreSQL `pg_trgm` suporta indices GiST e GIN para `LIKE` e `ILIKE`:
  https://www.postgresql.org/docs/17/pgtrgm.html
- Cloudflare Workers limita conexoes externas simultaneas e recomenda consumir ou
  cancelar respostas: https://developers.cloudflare.com/workers/platform/limits/
