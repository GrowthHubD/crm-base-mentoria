# Gestão de colunas no board do CRM

Plano aprovado em 04/09/2026. Criar, excluir e mover coluna direto em `/crm`,
sem passar por `/configuracoes/kanban`. Backend já existia; o trabalho foi de
UI mais duas correções de borda.

## Itens

- [x] `stages.ts`: `seedStagesIfEmpty()` em `createCustomStage` e `replaceStages`
- [x] `stages.ts`: traduzir id sintético `padrao:<status>` no PUT
- [x] `types.ts`: `StageColumn` (nove campos), `STAGES_PADRAO` e `ETAPAS_BASE`
- [x] `stage-order.ts`: `colunasDaFaixa`, `moverColuna`, `moverVizinho`, `definirVisibilidade`, `paraPut`
- [x] `__tests__/stage-order.test.ts` (29 casos)
- [x] `hooks/useBoardColumns.ts`: estado, carregamento, mutações otimistas com volta atrás
- [x] `components/ColumnMenu.tsx`: mover, ocultar, excluir com confirmação inline
- [x] `components/NewColumnButton.tsx`: nome, cor, etapa base e as ocultas de volta
- [x] `crm/page.tsx`: hook, menu no cabeçalho, arraste de coluna, botão de criar
- [x] `npx tsc --noEmit` limpo · `vitest` 333 testes verdes · `next build` completo

## Review

**O que mudou para quem usa.** O admin agora arrasta o cabeçalho da coluna para
mudar a ordem, tem um menu de três pontos em cada coluna (mover, ocultar e,
nas personalizadas, excluir) e um cartão "Nova coluna" no fim da faixa, com o
formulário de nome, cor e etapa base. Esse cartão também lista as colunas
ocultas para trazer de volta com um clique. BDR não vê nada disso, e a tela de
`/configuracoes/kanban` continua existindo com o que não entrou no board
(renomear, recolorir e configurar escalação).

**Duas armadilhas que o board teria disparado, corrigidas na origem.**

1. `seedStagesIfEmpty` existia e nunca era chamada. Numa instalação com a tabela
   vazia, criar a primeira coluna deixaria a tabela só com linhas customizadas,
   e `listStages` devolveria as cinco de fábrica como invisíveis: Novos,
   Prioridade e Urgência sumiriam do quadro. No mesmo cenário, salvar a ordem
   não casava linha nenhuma e falhava em silêncio.
2. O `StageView` local da tela tinha sete campos, sem os dois de escalação. Como
   o PUT grava a lista inteira e o que não vem vira `null`, reordenar pelo board
   apagaria a escalação de todas as colunas. O tipo agora é um só, com nove
   campos, compartilhado por tela, menu e hook.

**Trava de segurança.** A edição só é liberada depois que a configuração real
chega do servidor (`pronto`). Sem isso, um arraste nos primeiros instantes da
tela salvaria os PADRÕES por cima do funil do cliente. Se a chamada falhar, o
quadro fica em leitura.

**Não verificado no navegador.** O repositório não traz `.env`, então não há
como subir o app local. A validação foi typecheck, os 333 testes e o `next build`
completo (rodado com um `.env` descartável, já removido). O roteiro de ponta a
ponta em `crm.seudominio.com.br` está no plano e depende de deploy aprovado.

## Deploy 04/09 — versão 77005de9

Publicado no worker `crm-acme` (conta Acme, `b9690355…`) com
`wrangler.acme.jsonc`. Versão anterior, para rollback: `ade04ee3`.

Verificado em produção: `/login` 200 com a marca Acme intacta · `/api/health`
com `database: true` e 150ms · rotas protegidas em 307 (middleware ativo, não
500) · chunk novo do `/crm` servindo 200.

Cuidado de build documentado em PENDENCIAS.md: o OpenNext assa o `.env` local
em `next-env.mjs`; foi usado um `.env` descartável só para o build passar e o
arquivo foi zerado antes do deploy. Nenhum valor de placeholder foi ao ar.

Falta: conferir no navegador, logado como admin. Não tenho credenciais.

## Ajuste 04/09 — botão na barra de cima (deploy 3fc83fdb)

"Nova coluna" saiu do fim da faixa e virou botão na barra horizontal, ao lado
dos Filtros, abrindo um painel com cor, nome, etapa base e os chips das colunas
ocultas. Um ponto de entrada só, sempre visível: no fim da faixa a ação ficava a
três telas de rolagem num funil longo. O botão mostra um contador quando existe
coluna oculta, que é o único aviso de que há coluna fora do quadro.

Verificado: typecheck limpo, 333 testes verdes, deploy `3fc83fdb` no ar com
`/api/health` em `database: true`.

## Auditoria de desempenho, glitches e isolamento visual, 04/09/2026

Escopo aprovado pelo pedido do usuário: revisar primeiro e produzir um plano de
correção depois, sem alterar nesta etapa os contratos das APIs nem o fluxo de
recebimento de mensagens.

### Checklist da revisão

- [x] Ler instruções do projeto, lições e skills obrigatórias
- [ ] Sincronizar instruções novas do `CLAUDE.md` global no `AGENTS.md` global
- [x] Mapear o fluxo UI, filtros, busca, cache, Socket.IO e atualizações de leads
- [x] Auditar queries, paginação, payloads, índices e renderizações custosas
- [x] Auditar isolamento por perfil, dono e unidade em UI, API e banco
- [x] Mapear e proteger invariantes de webhooks, filas e recebimento de mensagens
- [x] Rodar typecheck, testes e verificações direcionadas sem modificar produto
- [x] Consolidar findings por severidade, evidência e causa-raiz
- [x] Produzir plano faseado de correção com testes de regressão e rollback

### Restrições

- Não implementar correções nesta etapa.
- Não alterar contratos de API, adapters, parsers, webhooks ou ingestão.
- Preservar integralmente as mudanças locais já existentes no worktree.

### Review

Auditoria concluída em `tasks/reviews/`. A sincronização global continua
pendente porque o sandbox bloqueou escrita fora do workspace.

## Implementação do plano de desempenho e correção

- [x] Criar contexto de identidade autenticada para chaves de cache
- [x] Extrair leitura do board para hook modular com `scopeKey`
- [x] Impedir payload antigo durante troca de conexão
- [x] Coordenar polling com single-flight, aborto e sequência por request
- [x] Extrair busca com chave de consulta e cancelamento
- [x] Propagar unidade nas leituras do board e da busca
- [x] Aplicar paridade de escopo por dono e unidade nas queries de leitura
- [x] Reduzir trabalho repetido do chat e pausar polling invisível
- [x] Adicionar testes de concorrência, cache e isolamento
- [ ] Executar typecheck, testes, build e revisão de segurança
- [x] Avaliar a fase protegida de identidade e webhook somente após as travas

### Restrições da implementação

- Preservar o contrato externo das APIs.
- Não alterar adapters, parsers, envio ou recebimento no primeiro pacote.
- Preservar as alterações locais preexistentes de gestão de colunas.

### Review da implementação

Primeiro pacote aplicado sem alterar webhook, adapter, parser, envio ou
recebimento. O board agora rejeita respostas fora do escopo e fora de ordem,
a busca cancela consultas antigas, os caches são isolados por identidade,
unidade e conexão, e o detalhe repete o recorte de unidade das listagens.

O custo visual caiu com renderização progressiva de 60 cards por lista. O poll
do board passou de 2 para 4 segundos, ficou single-flight e deixou de acender
estado visual de refresh em toda leitura automática. O chat busca 100 mensagens
recentes, evita requests sobrepostos, preserva o array quando nada mudou e para
quando a aba fica invisível.

Verificação: `npm run typecheck` passou e o smoke do modelo de concorrência
passou. Vitest e Next build não iniciaram porque o ambiente recusou subprocessos
com `spawn EPERM`. `git diff --check` não encontrou erro de whitespace. A fase
de identidade de leads e durabilidade de webhook permanece separada, pois exige
auditoria e migração dos dados reais antes de tocar no recebimento.

Commit: tentativa realizada, mas a política do ambiente bloqueou escrita em
`.git/index.lock` com `Permission denied`. Nenhum arquivo foi perdido ou
descartado, e o worktree permanece pronto para commit.

## Otimização contínua, rodada 2

Objetivo: transformar a melhoria já aplicada em ganho mensurável e atacar o
maior gargalo remanescente sem ampliar o risco do fluxo de mensagens.

### Plano

- [x] Revalidar o estado atual com typecheck, suíte completa e compilação de produção
- [x] Medir tamanho das rotas e chunks do CRM no build atual
- [x] Inspecionar o read path quente e escolher o gargalo com maior evidência
- [x] Implementar a melhoria dentro do módulo proprietário
- [x] Ajustar a configuração de teste e rodar toda a regressão
- [x] Comparar antes e depois e registrar resultados verificáveis

### Restrições

- Não alterar contratos externos sem necessidade comprovada.
- Não tocar em webhook, parser, adapter ou ingestão nesta rodada.
- Não fazer commit, push ou deploy sem autorização explícita.

### Review da rodada 2

O carregamento inicial do CRM não baixa mais o modal completo, o chat, as abas
secundárias, o seletor de emoji nem o painel de nova coluna antes de serem
usados. Esses recursos passaram a chunks sob demanda. O chunk próprio da rota
`/crm` caiu de 66,8 KB para 58,1 KB, redução de 8,7 KB ou 13%. Ao abrir uma
conversa, o modal carrega seu bloco principal; Observações, Suporte IA,
Agendamentos e emoji continuam separados até o primeiro uso.

O `@import` da fonte foi movido para o topo de `globals.css`. Antes, o otimizador
avisava que a regra estava em posição inválida e ela podia ser descartada,
causando fallback e troca tardia de fonte.

A configuração do Vitest deixou de depender de `__dirname`, permitindo o
carregador ESM nativo neste ambiente. Resultado: 29 arquivos e 345 testes
passaram. `npm run typecheck` também passou. A compilação otimizada do Next
terminou em 38 segundos e gerou os chunks usados na comparação. A geração final
das páginas continua bloqueada pela política local de subprocessos: no modo
normal ocorre `spawn EPERM`; a alternativa experimental compila, mas falha em
page data com `DataCloneError`, por isso a configuração experimental foi
removida e não faz parte da entrega.

Próximo gargalo comprovado para a rodada seguinte: o poll quente ainda reconstrói
as filas ativa, Respondidos e Convertidos e relê conexões a cada quatro segundos.
Separar dados quentes dos estáveis deve reduzir banco, Worker e bytes por poll,
mas exige testes de merge para não atrasar movimentações entre filas.

## Otimização contínua, rodada 3

Objetivo: remover dados estáveis do poll quente sem alterar a resposta padrão da
API nem permitir mistura de conexão entre usuários, unidades ou filtros.

### Plano

- [x] Manter o contrato completo como padrão em `/api/crm/queues`
- [x] Permitir que polls internos omitam a consulta e o payload de conexões
- [x] Fazer merge imutável apenas com o snapshot do mesmo `scopeKey`
- [x] Atualizar conexões integralmente no primeiro load, refresh manual e por TTL
- [x] Cobrir merge, TTL, URL e compatibilidade da rota com testes
- [x] Rodar typecheck, 345+ testes e comparar consultas por ciclo

### Restrições

- Não reduzir a frequência de atualização das filas de leads.
- Não aceitar delta sem snapshot completo do mesmo escopo.
- Não alterar webhooks, mensagens, ingestão ou contratos de provedor.

### Review da rodada 3

O endpoint continua devolvendo `{ queues, connections }` por padrão, portanto
clientes existentes mantêm o mesmo contrato. O hook do CRM usa
`includeConnections=0` somente quando já há um snapshot completo da mesma chave
de usuário, unidade e conexão. O primeiro carregamento, o refresh manual e o
primeiro poll após 60 segundos atualizam a lista integralmente.

Uma resposta leve sem snapshot anterior é rejeitada. O merge troca apenas as
filas e preserva as conexões do mesmo cache autenticado; mudança de escopo segue
abortando o request e invalidando a sequência como antes.

Cada poll quente caiu de seis para cinco consultas ao banco, redução estrutural
de 16,7% por ciclo. Em regime contínuo de quatro segundos, são 76 consultas por
minuto no lugar de 90 para cada tela aberta, redução aproximada de 15,6%, além
de retirar a lista de conexões de 14 das 15 respostas do minuto.

As fontes também saíram do `@import` encadeado no CSS. A folha do Google Fonts
agora aparece diretamente no `<head>`, com preconnect para os dois hosts. O
navegador descobre a requisição mais cedo e a compilação deixou de emitir o
warning de import CSS em posição inválida.

Verificação: `npm run typecheck` passou; 29 arquivos e 351 testes passaram; o
Next concluiu a compilação de produção em modo `compile`, incluindo a rota do
CRM e seus chunks, sem o warning anterior de CSS. A configuração experimental usada apenas para contornar o
sandbox foi removida depois da verificação.

Próximo alvo: as três consultas de leads do board ainda são serializadas pela
conexão única do Worker. Consolidá-las em uma leitura com limites independentes
por faixa pode remover dois round trips por poll, mas precisa ser validado
contra um Postgres real para provar ordem, plano e equivalência dos resultados.

## Otimização contínua, rodada 4

Objetivo: impedir commits React do quadro inteiro quando a única diferença do
poll são os segundos transcorridos nos relógios dos cards.

### Plano

- [x] Remover segundos individuais da assinatura estrutural do board
- [x] Usar um bucket visual global de 10 segundos para esperas abaixo de 1 minuto
- [x] Usar um bucket visual global de 1 minuto para as demais esperas
- [x] Não adicionar ticker, timer ou assinatura por card
- [x] Cobrir os limites temporais e mudanças reais com testes
- [x] Rodar typecheck, suíte completa e compilação de produção

### Restrições

- Preservar polling de dados a cada quatro segundos.
- Mudança real em qualquer card deve continuar aparecendo no próximo poll.
- Não mexer em ingestão, mensagens, webhooks ou persistência.

### Review da rodada 4

`boardSignature` não inclui mais o segundo individual de cada lead. A assinatura
continua cobrindo nome, status, coluna, preview, leitura, responsável, dono, IA,
pausa, atendentes e conexões; qualquer mudança real nesses campos ainda troca o
snapshot no próximo poll.

O relógio passou a usar um único bucket visual para o quadro inteiro. Se existe
algum lead aguardando há menos de um minuto, o bucket avança a cada 10 segundos.
Fora desse caso, avança uma vez por minuto. Sem leads aguardando, a assinatura é
estática. Não foi criado timer adicional nem uma assinatura por card.

Em um quadro estável com esperas acima de um minuto, os commits React caem de até
15 por minuto para 1, redução de até 93,3%. Durante o primeiro minuto de uma nova
espera, o limite é 6 commits por minuto, redução de até 60%. O fetch de quatro
segundos permanece intacto para mudanças reais chegarem sem atraso adicional.

Verificação: typecheck passou; 29 arquivos e 354 testes passaram; a compilação
Next em modo de produção `compile` terminou com sucesso. A configuração
experimental temporária foi removida depois da validação.

## Otimização contínua, rodada 5

Objetivo: eliminar consultas duplicadas de identidade que o layout já resolveu
antes de renderizar o CRM.

### Plano

- [x] Ampliar o contexto autenticado com papel, visão de time e modo do kanban
- [x] Reusar os dados já carregados pelo layout, sem novo fetch ou cache de permissão
- [x] Remover `/api/me` da página do CRM e do modal de lead
- [x] Preservar gates visuais de admin, carteira e modo manual
- [x] Provar que o CRM não emite mais essas chamadas duplicadas
- [x] Rodar typecheck, testes e compilação de produção

### Restrições

- Não cachear autorização no Worker ou ampliar sua janela de validade.
- A autorização real continua obrigatoriamente nas rotas do servidor.
- Não remover `/api/me`, pois outras telas ainda podem depender da rota.

### Review da rodada 5

O layout autenticado já carregava o registro do usuário e calculava sua carteira.
Agora ele entrega `userId`, `role`, `veTudo` e `kanbanManual` por um contexto
memoizado. A página do CRM e o modal consomem esses valores diretamente, sem
buscar `/api/me` outra vez.

Isso remove uma requisição HTTP autenticada e ao menos uma consulta explícita à
tabela `users` em cada entrada no CRM. Remove a mesma dupla em toda abertura de
conversa. Abrir dez leads, por exemplo, deixa de produzir dez chamadas de
identidade e dez consultas redundantes. Nenhuma autorização foi cacheada: as
rotas continuam validando sessão, papel, dono e unidade normalmente.

A mudança também corrige o gate `kanbanManual`: a página esperava esse campo de
`/api/me`, mas a rota nunca o devolveu. Agora o valor vem diretamente de
`cardsSoPorArraste()` no servidor, refletindo a configuração real do deploy.

Verificação: busca estática confirma zero `fetch('/api/me')` na página e no
modal; typecheck passou; 30 arquivos e 356 testes passaram; a compilação Next de
produção em modo `compile` terminou com sucesso. O ajuste experimental do
sandbox foi removido após a validação.

## Otimização contínua, rodada 6

Objetivo: impedir uma consulta autenticada de respostas rápidas em toda abertura
de conversa, mantendo atualização imediata após alterações.

### Plano

- [x] Criar hook e invalidação no módulo `quick-replies`
- [x] Reusar cache isolado por identidade e unidade no composer
- [x] Remover fetch local e estado duplicado do `ChatPanel`
- [x] Invalidar o cache após criar, editar ou excluir resposta rápida
- [x] Provar que o modal não faz mais fetch direto a cada montagem
- [x] Rodar typecheck, testes e compilação de produção

### Restrições

- Não compartilhar cache entre usuários ou unidades.
- Alterações feitas pelo usuário devem aparecer sem esperar o TTL.
- Falha da feature opcional não pode bloquear o chat.

### Review da rodada 6

O `ChatPanel` passou a consumir respostas rápidas por um hook do módulo
`quick-replies`. O hook reutiliza o cache autenticado existente, que separa as
chaves por usuário e unidade, deduplica requisições simultâneas e mantém TTL de
30 segundos com revalidação silenciosa.

A primeira conversa continua carregando os textos normalmente. Abrir outras
conversas durante a janela do cache não repete a chamada autenticada nem a
consulta de listagem no banco. O CRUD invalida a chave logo após criar, editar
ou excluir, então a próxima leitura recebe os dados novos sem esperar o TTL.
Se a feature opcional falhar, o hook entrega uma lista vazia e o chat continua
funcionando.

Verificação: o teste específico passou; a busca estática confirma que não existe
mais fetch direto de respostas rápidas no `ChatPanel`; typecheck passou; 31
arquivos e 359 testes passaram; a compilação Next de produção em modo `compile`
terminou com sucesso. Os sinalizadores experimentais temporários foram removidos
após a validação.

## Otimização contínua, rodada 7

Objetivo: retirar embeddings de IA do caminho quente de leitura e polling do
histórico, pois esse dado volumoso não é renderizado pelo chat.

### Plano

- [x] Criar uma projeção de leitura de mensagens sem a coluna `embedding`
- [x] Manter todos os campos visuais e metadados usados pela conversa
- [x] Aplicar a projeção antes da transferência do banco para a aplicação
- [x] Provar que a listagem não seleciona nem serializa embeddings
- [x] Quantificar a redução potencial por janela e por minuto de polling
- [x] Rodar typecheck, testes e compilação de produção

### Restrições

- Não alterar persistência, geração ou busca semântica de embeddings.
- Não remover `metadata`, pois o chat usa esse campo para identificar canal.
- Não mudar paginação, ordem, status, reações ou frequência do polling.

### Review da rodada 7

A listagem do histórico agora usa uma projeção SQL própria do módulo `messages`
que contém todos os campos visuais, inclusive `metadata`, mas exclui
`embedding`. A remoção acontece no `SELECT`, antes de o JSONB sair do Postgres;
persistência, geração e leituras individuais continuam capazes de usar o campo.

Uma amostra conservadora de embedding com 1.536 números e oito casas decimais
ocupa 17,1 KiB em JSON. Em uma janela cheia de 100 mensagens, a projeção evita
aproximadamente 1,67 MiB por poll. Com a frequência atual de 15 polls por minuto,
isso representa até 25 MiB por minuto por conversa aberta quando todas as
mensagens possuem embedding, além de eliminar leitura e desserialização do JSONB
no banco, Worker e navegador.

Verificação: teste estrutural da projeção passou; typecheck passou; 32 arquivos
e 361 testes passaram; a compilação Next de produção em modo `compile` terminou
com sucesso. Os sinalizadores experimentais temporários foram removidos após a
validação.

## Otimização contínua, rodada 8

Objetivo: manter o polling responsivo de quatro segundos sem retransmitir e
desserializar a janela inteira quando a conversa não mudou.

### Plano

- [x] Gerar ETag determinístico para a janela completa de mensagens
- [x] Responder `304` sem corpo quando o cliente já possui a mesma janela
- [x] Isolar a revalidação por lead e preservar proteção contra respostas antigas
- [x] Atualizar o ETag após qualquer resposta nova da conversa
- [x] Cobrir conteúdo, status, reações, edição e exclusão nos testes do contrato
- [x] Rodar typecheck, testes e compilação de produção

### Restrições

- Manter o polling a cada quatro segundos e a carga inicial completa.
- Toda alteração visual deve mudar o ETag e aparecer no próximo poll.
- Não permitir cache compartilhado entre usuários, leads ou unidades.

### Review da rodada 8

O histórico agora gera um ETag SHA-256 a partir do JSON exato da janela depois
de autenticar o usuário e validar seu acesso ao lead. O `ChatPanel` guarda esse
identificador junto do `leadId` e o envia no poll seguinte. Se a janela continua
igual, a rota responde `304` sem corpo e o navegador não desserializa nem
reconcilia novamente as 100 mensagens.

O polling permanece a cada quatro segundos. Mensagem nova, conteúdo editado,
status, reação, exclusão, paginação e mudança de papel do remetente alteram o
JSON e, consequentemente, o ETag. O cache é privado, varia por cookie e a
referência do cliente só é reutilizada para o mesmo lead.

Em um minuto sem mudanças, a carga inicial é completa e os 14 polls seguintes
não carregam corpo, redução de até 93,3% nas transmissões da janela. O banco
continua consultado nesta etapa, mas Worker e navegador deixam de transferir,
interpretar e comparar conteúdo repetido.

Verificação: sete testes novos cobrem estabilidade, conteúdo, status, reação,
exclusão, lista de ETags e integração da resposta `304`; typecheck passou; 33
arquivos e 368 testes passaram; a compilação Next de produção em modo `compile`
terminou com sucesso. Os sinalizadores experimentais temporários foram removidos
após a validação.

## Otimização contínua, rodada 9

Objetivo: reduzir consultas agregadas e autenticações repetidas do dashboard sem
deixar os indicadores operacionais lentos.

### Plano

- [x] Manter KPIs operacionais atualizados a cada dez segundos
- [x] Atualizar gráficos analíticos a cada sessenta segundos
- [x] Pausar timeline e horário fora da aba Visão Geral
- [x] Pausar canais fora das abas que realmente exibem esse dado
- [x] Revalidar imediatamente ao reativar uma seção com cache vencido
- [x] Quantificar requisições por minuto em cada aba
- [x] Rodar typecheck, testes e compilação de produção

### Restrições

- Não alterar consultas, cálculos ou contratos das APIs.
- Não pausar os KPIs visíveis no cabeçalho do dashboard.
- Ao voltar para uma aba, pintar o cache existente e revalidar se necessário.

### Review da rodada 9

A política de atualização agora pertence ao módulo `dashboard`. Os KPIs do
cabeçalho continuam consultando a cada dez segundos. Timeline, distribuição por
canal e fluxo por horário, que fazem agregações históricas, passam a atualizar a
cada sessenta segundos e só permanecem ativas quando a aba realmente as usa.

O hook de dados já preserva o resultado por usuário, unidade e URL. Ao trocar de
aba, a seção reaparece imediatamente com o cache existente; se ele tiver mais de
30 segundos, a revalidação começa no mesmo instante. A aba invisível do navegador
continua suspendendo todos os timers como antes.

Na Visão Geral, as quatro APIs periódicas caem de 24 para 9 chamadas por minuto,
redução de 62,5%. Em Canais, caem de 24 para 7, redução de 70,8%. Em
Atendimentos, as três agregações ocultas ficam pausadas; considerando o polling
próprio da tabela, o total cai de 28 para 10 chamadas por minuto, redução de
64,3%. Cada chamada evitada também elimina sua autenticação e consulta agregada.

Verificação: quatro testes cobrem frequências e atividade por aba; typecheck
passou; 34 arquivos e 372 testes passaram; a compilação Next de produção em modo
`compile` terminou com sucesso. Os sinalizadores experimentais temporários foram
removidos após a validação.

## Criação manual de cards no CRM

Objetivo: permitir cadastrar um lead pelo CRM por uma ação geral ou diretamente
na coluna de destino, preservando escopo, unidade, dono e semântica do pipeline.

### Plano

- [x] Definir e testar o contrato normalizado de criação manual
- [x] Criar `POST /api/leads` com autenticação, escopo e validação de coluna
- [x] Permitir destino inicial por status e `stageId` na criação atômica
- [x] Criar modal no módulo `leads` com dados essenciais do card
- [x] Adicionar ação geral “Novo lead” no cabeçalho do CRM
- [x] Adicionar ação rápida em cada coluna operacional
- [x] Herdar conexão ativa quando a criação partir de uma coluna filtrada
- [x] Recarregar o quadro e abrir o lead criado após sucesso
- [x] Cobrir duplicidade, contato inválido e destino manipulado
- [x] Rodar typecheck, testes e compilação de produção

### Decisões de produto

- Nome e ao menos um contato, telefone ou e-mail, são obrigatórios.
- Com conexão selecionada, o card nasce como WhatsApp e exige telefone.
- Sem conexão, o card nasce como manual e ainda pode guardar telefone e e-mail.
- A criação geral inicia na primeira coluna operacional visível.
- Não será possível criar diretamente em Convertidos ou Perdidos, pois esses
  estados representam encerramento e exigem histórico próprio.

### Restrições

- O servidor nunca confia no status ou `stageId` enviados pelo navegador.
- Atendente com carteira cria lead para si; admin pode criar lead da casa.
- Unidade selecionada e conexão precisam respeitar o mesmo escopo das listagens.
- Webhooks e criação automática de leads devem manter o comportamento atual.

### Review da criação manual de cards

O CRM agora oferece “Novo lead” no cabeçalho e um botão de adição no cabeçalho
de cada coluna operacional. A ação da coluna abre o formulário já apontando para
ela; a ação geral usa a primeira coluna operacional visível. Se a tela está
filtrada por uma conexão, essa conexão também chega pré-selecionada.

O modal coleta nome, telefone, e-mail, coluna inicial, conexão, origem comercial
e observações internas. Nome e ao menos um contato são obrigatórios. Selecionar
uma conexão exige telefone e cria o lead no canal WhatsApp; sem conexão, o card
é manual. Após salvar, o quadro recarrega e a ficha criada abre imediatamente.

O `POST /api/leads` autentica a sessão, resolve a unidade pelo mesmo cabeçalho
das listagens, limita conexões ao escopo de unidade e dono e relê as colunas no
servidor. O `stageId` do navegador nunca decide sozinho: a rota encontra a
coluna real, usa seu status-base e recusa coluna inexistente, oculta ou de
encerramento. Conexão vinculada transfere unidade e dono ao card; sem conexão,
atendente cria para a própria carteira e admin cria lead da casa.

A criação automática permanece igual porque os novos campos de destino são
opcionais no contrato interno. Webhooks sem `status` ou `stageId` continuam
usando `new` e a coluna de entrada configurada. Telefone de WhatsApp duplicado
retorna conflito, incluindo proteção contra corrida pela restrição única do
banco.

Verificação: 12 testes novos cobrem normalização, contato obrigatório, WhatsApp,
destino padrão, coluna personalizada, coluna oculta, destino forjado,
encerramento, autenticação, escopo, retrocompatibilidade e duplicidade;
typecheck passou; 36 arquivos e 384 testes passaram; a compilação Next de
produção em modo `compile` terminou com sucesso. Os sinalizadores experimentais
temporários foram removidos após a validação.
