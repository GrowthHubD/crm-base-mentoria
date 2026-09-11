# Revisão de performance do CRM

Escopo: leitura do quadro, troca de conexões, busca, abertura do lead e histórico de mensagens. Nenhum código de produto foi alterado. A auditoria considera o estado atual do worktree, que já contém mudanças não relacionadas na página do CRM.

Stack observada: Next.js 15, React 19, Drizzle, Postgres e Cloudflare Workers com Hyperdrive.

## Resumo executivo

A lentidão não vem de um único ponto. O caminho mais acessado combina quatro multiplicadores:

1. o navegador baixa o quadro completo a cada 2 segundos;
2. cada leitura pode retornar até 2.800 leads e executar pelo menos seis consultas;
3. no Worker, essas consultas acabam serializadas numa única conexão;
4. o cliente monta todos os cards das filas ativas sem paginação nem virtualização.

No limite explícito do código, uma única tela aberta pode receber 30 respostas de quadro por minuto, processando até 84.000 registros de lead por minuto, sem contar mensagens e atendentes. Com vários usuários, polling sobreposto e buscas, isso disputa banco e CPU com fluxos críticos. A ingestão e o envio de mensagens não precisam ser alterados para corrigir esse problema. A solução deve ficar nas rotas de leitura, índices e módulo visual do pipeline.

O glitch relatado também está confirmado: ao trocar para uma conexão sem cache, `data` continua contendo o quadro anterior. A tela mostra os leads antigos até a resposta nova chegar.

## HIGH

### 1. O quadro completo é recarregado a cada 2 segundos e as leituras podem se sobrepor

Problema: cada aba visível dispara `GET /api/crm/queues` a cada 2 segundos. Não existe single-flight, `AbortController` ou bloqueio enquanto outra leitura está em voo. Polling, foco da janela, atualização manual e refresh após uma mutação podem abrir leituras simultâneas.

Evidências:

- `src/app/(dashboard)/crm/page.tsx:106`: `REFRESH_INTERVAL_MS = 2_000`.
- `src/app/(dashboard)/crm/page.tsx:344-382`: cada `load` baixa e desserializa uma resposta completa.
- `src/app/(dashboard)/crm/page.tsx:399-418`: polling e eventos de foco podem iniciar novas leituras.
- `src/app/(dashboard)/crm/page.tsx:665` e `src/app/(dashboard)/crm/page.tsx:467`: refresh manual e refresh após movimentação criam outros disparos.
- `src/app/(dashboard)/crm/page.tsx:356`: `cache: 'no-store'` impede reaproveitamento HTTP.

Causa raiz: atualização em tempo real foi implementada como polling integral, sem coordenação de request e sem protocolo incremental.

Risco: saturação do banco e do Worker, respostas fora de ordem, banda alta, parse de JSON repetido e concorrência com webhooks e workers de mensagens. O risco cresce linearmente com o número de operadores conectados.

Correção objetiva `[FIX NOW]`: criar um coordenador de leitura em `src/modules/pipeline/hooks/`, com single-flight por escopo, invalidação da resposta antiga e intervalo adaptativo. Primeiro elevar o intervalo e atualizar imediatamente após mutações. Em seguida avaliar ETag ou versão do quadro, ou leitura incremental por `updatedAt`. Não alterar rotas de ingestão ou envio.

Como verificar:

1. DevTools Network por 60 segundos, medir quantidade, duração e bytes de `/api/crm/queues` antes e depois.
2. Simular latência maior que 2 segundos e provar que existe no máximo uma leitura em voo por escopo.
3. Medir `pg_stat_statements` por chamada, tempo total e linhas retornadas da rota.
4. Confirmar que mensagens recebidas durante o teste continuam sendo persistidas e aparecem após a próxima invalidação.

### 2. Cada poll refaz um read model caro e, no Worker, as consultas são serializadas

Problema: a rota consulta filas e conexões em paralelo no código, mas o client do Worker usa `max: 1`. Dentro de `getKanbanData`, três consultas de leads são iniciadas, depois vêm a última mensagem por lead e todo o histórico humano necessário para derivar atendentes. A rota também relê a lista de conexões em todo poll, embora ela mude raramente.

Evidências:

- `src/app/api/crm/queues/route.ts:25-28`: fila e conexões são solicitadas em toda resposta.
- `src/modules/pipeline/queries.ts:167-189`: três consultas de leads, com limites de 2.000, 500 e 300.
- `src/modules/pipeline/queries.ts:215-236`: consulta adicional da última mensagem para todos os leads retornados.
- `src/modules/pipeline/queries.ts:244-257`: consulta adicional de até 5.000 mensagens humanas para reconstruir atendentes.
- `src/lib/db/client.ts:229-250`: o Worker configura uma conexão por requisição e documenta que as consultas são serializadas.

Causa raiz: a tela pede um agregado derivado de tabelas transacionais em alta frequência. Informações de leitura, como preview da última mensagem e atendentes recentes, são recalculadas a partir de `messages` em cada chamada.

Risco: waterfall no banco, aumento de TTFB e alta variância conforme crescem leads e mensagens. O limite global de 5.000 mensagens humanas também pode produzir atendentes incompletos para leads menos recentes, ao mesmo tempo em que transfere muitas linhas.

Correção objetiva `[FIX NOW]`: separar dados estáveis de dados voláteis. Tirar `connections` do poll quente, buscar somente quando a configuração mudar e materializar no lead, ou em tabela de projeção do CRM, os campos necessários ao card. Como etapa intermediária, devolver apenas o conjunto visível e buscar seções arquivadas sob demanda.

Como verificar:

1. Instrumentar a rota com Server-Timing por fase: autenticação, active, attending, converted, last message, attendants e connections.
2. Rodar `EXPLAIN (ANALYZE, BUFFERS)` em cada consulta com volume real.
3. Comparar p50, p95 e p99 de TTFB com 1, 5 e 20 clientes concorrentes.
4. Verificar que a mudança afeta apenas consultas e payloads de leitura.

### 3. As consultas quentes de leads não têm índices compatíveis no schema e nas migrations

Problema: o schema de `leads` declara somente o índice único de deduplicação por canal e contato. O quadro filtra repetidamente por `status`, `connectionId`, `unitId` e `ownerId`, e ordena por timestamps diferentes. Sem índices compostos alinhados ao escopo real, o Postgres tende a varrer e ordenar a tabela a cada poll.

Evidências:

- `src/lib/db/schema/leads.ts:152-156`: único índice declarado para `leads` é `(channel, externalContactId)`.
- `src/modules/pipeline/queries.ts:116-127`: escopo frequente por conexão, unidade e dono.
- `src/modules/pipeline/queries.ts:171-188`: filtros por status e ordenações por `lastInboundAt`, `statusChangedAt`, `lastMessageAt` e `convertedAt`.
- A busca em `drizzle/` não encontrou criação de índices adicionais para `leads`.

Causa raiz: os índices acompanharam deduplicação e mensagens, mas não o read path do kanban que passou a operar em polling frequente.

Risco: sequential scan e sort repetidos, pressão de CPU e I/O no Postgres, piorando todas as APIs que compartilham o banco.

Correção objetiva `[FIX NOW]`: capturar planos reais antes de definir a ordem exata das colunas. Candidatos naturais são índices parciais ou compostos por escopo, status e ordenação. Criar com `CONCURRENTLY` fora de transação para não bloquear escrita. Não criar vários índices especulativos, pois cada índice também encarece os webhooks que atualizam leads.

Como verificar:

1. Consultar `pg_indexes` no schema de produção para confirmar o estado real, pois pode haver índice manual não versionado.
2. Rodar `EXPLAIN (ANALYZE, BUFFERS)` com e sem `connectionId`, com dono e unidade.
3. Aceitar o índice somente se o plano eliminar sequential scan e sort relevante no volume real.
4. Durante `CREATE INDEX CONCURRENTLY`, acompanhar locks, latência dos webhooks e taxa de escrita.

### 4. Até 2.000 cards ativos são montados no DOM sem paginação ou virtualização

Problema: a consulta permite 2.000 leads nas filas ativas e o componente executa `cards.map` para todos eles. A rolagem vertical é apenas CSS, não virtualização. `Column` e `KanbanCard` não usam memoização e recebem callbacks e objetos recriados pela página.

Evidências:

- `src/modules/pipeline/queries.ts:168-174`: limite de 2.000 leads ativos.
- `src/app/(dashboard)/crm/page.tsx:1493-1497`: todos os cards da coluna são montados dentro do container rolável.
- `src/app/(dashboard)/crm/page.tsx:1285-1505`: `Column` é componente comum, sem `React.memo`.
- `src/app/(dashboard)/crm/page.tsx:231-643`: a página concentra estado, filtros, polling e derivações; mudanças locais reexecutam o componente inteiro.
- `src/app/(dashboard)/crm/page.tsx:571-615`: `cardsDa` percorre listas para cada coluna exibida.

Causa raiz: limite do servidor foi tratado como limite de segurança, não como orçamento de renderização do navegador.

Risco: tempo alto de scripting e commit, travamentos ao filtrar ou arrastar, memória elevada e recálculo de estilo. Em máquinas mais fracas, o sistema parece lento mesmo depois que a API respondeu.

Correção objetiva `[FIX NOW]`: implementar janela virtual por coluna ou paginação incremental, preservando drag and drop. Extrair a vertical visual para `src/modules/pipeline/components/` e manter a página apenas como composição. Memoização só deve vir depois de estabilizar props e callbacks, pois sozinha não resolve milhares de nós.

Como verificar:

1. React Profiler com 100, 500, 1.000 e 2.000 leads.
2. Performance panel durante troca de filtro e drag, comparando scripting, layout, paint e long tasks.
3. Contar nós DOM e commits de `KanbanCard`.
4. Critério sugerido: nenhum long task acima de 50 ms numa troca de filtro em hardware intermediário.

### 5. Trocar para uma conexão sem cache continua exibindo o quadro anterior

Problema: o efeito marca `loading`, mas preserva `data`. O placeholder só aparece quando `data` é nulo, então os leads do filtro anterior permanecem visíveis até a nova resposta.

Evidências:

- `src/app/(dashboard)/crm/page.tsx:385-394`: no cache miss, apenas `setLoading(true)` é chamado.
- `src/app/(dashboard)/crm/page.tsx:763-768`: loading só substitui a tela quando `!data`.
- `src/app/(dashboard)/crm/page.tsx:805`: qualquer `data` existente mantém o quadro montado.
- `src/app/(dashboard)/crm/page.tsx:547-560`: somente a aba virtual de e-mail ganha filtro client-side; uma conexão real usa o payload anterior sem recorte local.

Causa raiz: o payload não carrega a chave do escopo que o produziu. `connSeq` rejeita resposta atrasada, mas não invalida o estado já pintado.

Risco: reproduz o relato de leads de outro perfil aparecerem e depois sumirem. Também expõe dados visualmente durante a transição.

Correção objetiva `[FIX NOW]`: armazenar `{ scopeKey, payload }` e renderizar somente quando a chave coincide com identidade, unidade e conexão atuais. Cache também precisa da chave de identidade e unidade. Este item coincide com a análise dedicada de concorrência em `tasks/reviews/frontend-race-review.md`.

Como verificar:

1. Aplicar latência artificial de 2 segundos.
2. Alternar A, B, A repetidamente.
3. Em nenhum frame, um cabeçalho ativo pode coexistir com payload de outra chave.
4. Repetir após logout e login com outro usuário no mesmo navegador.

## MEDIUM

### 6. O chat baixa e reconcilia 200 mensagens a cada 4 segundos, mesmo sem mudança

Problema: com o modal aberto, o chat busca as 200 mensagens mais recentes a cada 4 segundos. Se houver qualquer mensagem, ele sempre cria um novo array, o que refaz filtros, agrupamentos e renderização. O polling do quadro continua rodando por trás do modal a cada 2 segundos.

Evidências:

- `src/components/crm/ChatPanel.tsx:12-14`: polling de 4 segundos e página antiga de 100.
- `src/components/crm/ChatPanel.tsx:220-240`: leitura fixa de 200 mensagens e novo array na reconciliação.
- `src/components/crm/ChatPanel.tsx:292-308`: intervalo sem pausa por visibilidade e sem single-flight.
- `src/components/crm/ChatPanel.tsx:312-330`: cada novo array dispara scroll, filtros e agrupamento.
- `src/app/(dashboard)/crm/page.tsx:928-933`: o modal é sobreposto ao quadro, sem desmontar a página e seu polling.

Causa raiz: o chat não possui cursor de novidade, assinatura da janela ou canal de eventos.

Risco: ao abrir um lead, o navegador e o banco passam a sustentar dois pollings pesados. Conversas longas pioram o custo de parse e reconciliação.

Correção objetiva `[FIX NOW]`: primeira carga paginada e polls posteriores apenas com `after=<lastTimestamp>` ou versão. Não substituir a janela se nada mudou. Pausar quando invisível e coordenar refresh com envio otimista.

Como verificar:

1. Abrir um chat sem mensagens novas por 60 segundos e contar bytes e renders de `MessageBubble`.
2. O estado de mensagens não deve trocar de referência quando a API confirmar ausência de novidade.
3. Enviar e receber mensagens durante o teste para validar ordenação e deduplicação.

### 7. Busca textual usa `ILIKE '%termo%'` em tabelas grandes, sem índice de texto observado

Problema: cada busca executa uma varredura textual de três colunas de `messages`, outra de nome e telefone em `leads`, e depois hidrata os ids. As duas primeiras consultas são sequenciais. O schema não declara índices trigram para essas colunas.

Evidências:

- `src/modules/pipeline/queries.ts:447-474`: `ILIKE` com curinga à esquerda em conteúdo, nome e telefone.
- `src/modules/pipeline/queries.ts:479-497`: terceira consulta para hidratação.
- `src/lib/db/schema/messages.ts:93-105`: índices observados cobrem lead, timestamp e status, não conteúdo textual.
- `src/lib/db/schema/leads.ts:152-156`: não há índice de busca por nome ou telefone.
- `src/app/(dashboard)/crm/page.tsx:253-272`: o cliente ignora respostas antigas, mas não aborta trabalho já iniciado no servidor.

Causa raiz: busca global foi adicionada sobre tabelas transacionais sem um índice ou read model próprio.

Risco: digitação e troca rápida de filtros deixam consultas obsoletas concorrendo com o quadro. O custo cresce com todo o histórico de mensagens, não apenas com leads visíveis.

Correção objetiva `[FIX NOW]`: abortar a request abandonada no cliente, executar busca de contato e conteúdo em paralelo e medir planos. Se confirmado sequential scan relevante, adicionar `pg_trgm` e índices GIN seletivos, ou mover a busca para uma projeção própria. A escolha depende do volume e da seletividade real.

Como verificar:

1. `EXPLAIN (ANALYZE, BUFFERS)` com termos comuns, raros e telefone.
2. Medir p95 com múltiplas buscas concorrentes.
3. Confirmar por logs que requests abortadas não atualizam a UI e não acumulam no cliente.

### 8. O índice composto crítico de mensagens depende de script fora das migrations

Problema: `idx_messages_lead_id_timestamp` é essencial para a última mensagem por lead e paginação do chat, mas foi removido da migration e criado por um script de provisionamento separado. Uma instalação atualizada sem executar esse script pode operar sem o índice mais importante do caminho quente.

Evidências:

- `src/lib/db/schema/messages.ts:97-105`: o próprio schema documenta que o índice sustenta kanban e chat.
- `drizzle/0004_shocking_wallflower.sql:14-24`: a migration explicitamente não cria o índice.
- `scripts/create-messages-index.ts:39` e `scripts/create-messages-index.ts:95`: criação ocorre separadamente com `CONCURRENTLY`.
- `scripts/provisionar-cliente.ts:127`: o provisionamento novo chama o script, mas isso não prova que todas as instalações antigas o receberam.

Causa raiz: operação correta para evitar lock foi separada do mecanismo que registra migrations aplicadas, sem um health check de schema observado.

Risco: regressão severa de performance varia por cliente e fica difícil de reproduzir localmente.

Correção objetiva `[FIX NOW]`: adicionar auditoria idempotente de índices ao deploy ou health check administrativo. Não recriar se já existir.

Como verificar:

1. Consultar `pg_indexes` em cada schema provisionado.
2. Rodar o script somente onde faltar e confirmar `indisvalid` e `indisready` em `pg_index`.
3. Comparar plano e duração da query `DISTINCT ON` antes e depois.

## Pontos positivos observados

- `src/modules/pipeline/queries.ts:197-236` já substitui uma janela custosa por `DISTINCT ON`, evitando transferir todo o histórico só para obter a última mensagem.
- `src/lib/db/schema/messages.ts:105` define o índice composto adequado para paginação e última mensagem, quando ele realmente existe no banco.
- `src/app/(dashboard)/crm/page.tsx:363-373` evita `setData` quando a assinatura visual não muda, reduzindo alguns commits React.
- `src/app/(dashboard)/crm/page.tsx:396-425` pausa o polling do quadro quando a página fica invisível.
- `src/components/crm/ChatPanel.tsx:247-284` já usa paginação por cursor para mensagens antigas.

Essas melhorias reduzem sintomas, mas ocorrem depois que a maior parte do custo já aconteceu no servidor, na rede e no parse do JSON.

## Ordem recomendada para o plano de correção

1. Instrumentar primeiro: tamanho de resposta, Server-Timing, `pg_stat_statements`, planos de execução, React Profiler e cenário reproduzível A, B, A.
2. Corrigir isolamento visual e coordenação de requests: `scopeKey`, single-flight, descarte por sequência e cache por identidade, unidade e conexão.
3. Reduzir imediatamente a frequência e a sobreposição do polling, preservando refresh após mutação.
4. Confirmar e criar índices de produção com `CONCURRENTLY`, começando pelos planos mais caros.
5. Reduzir o payload do quadro: retirar conexões do poll, carregar seções fechadas sob demanda e introduzir paginação ou versão incremental.
6. Virtualizar as colunas e estabilizar props dos cards.
7. Transformar o poll do chat em busca incremental de novidades.
8. Otimizar a busca textual após medir seletividade e volume.
9. Fazer smoke de regressão das APIs de webhook, ingestão, envio e recebimento, comprovando que não houve alteração nesses contratos.

## Parecer

Não recomendo atacar apenas memoização de React ou aumentar timeouts. O gargalo estrutural é um snapshot grande, derivado de várias consultas, repetido em alta frequência e renderizado integralmente. A correção mais segura preserva as APIs de mensagens e cria um read path mais leve e modular para o pipeline.
