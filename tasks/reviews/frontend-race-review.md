# Revisão do CRM: troca rápida de filtros, cache e concorrência

Escopo: somente leitura do fluxo do CRM. Nenhum código de produto foi alterado.

Stack observada: Next.js 15, React 19, fetch nativo, Drizzle e Postgres. O CRM usa estado e cache próprios em `src/app/(dashboard)/crm/page.tsx`, sem uma biblioteca de queries.

## Resumo executivo

Foram encontrados 2 problemas críticos de isolamento, 3 problemas altos que explicam diretamente os glitches e 2 problemas médios de consistência e carga.

O sintoma principal é determinístico: ao trocar para uma conexão ainda sem cache, a tela mantém os leads da conexão anterior até a nova resposta chegar. A proteção `connSeq` impede que uma resposta atrasada de outra aba sobrescreva a atual, mas não impede que o próprio estado antigo continue renderizado durante a transição.

As correções podem ficar isoladas no módulo de CRM/pipeline e nas rotas de leitura do CRM. Não é necessário alterar webhooks, ingestão de mensagens, envio de mensagens ou contratos com provedores.

## CRITICAL

### 1. Busca do CRM ignora o isolamento por unidade

Problema: `GET /api/crm/search` aplica somente o recorte por dono. Ela não chama `escopoDaRequisicao`, não lê `x-unit-id` e `searchConversations` nem aceita `unitId`. Assim, um usuário restrito por unidade pode localizar leads e trechos de mensagens de outra unidade quando o recorte por dono não estiver ativo ou não separar esses registros.

Evidência:

- `src/app/api/crm/search/route.ts:12-25`: autentica e calcula apenas `escopoDono`.
- `src/modules/pipeline/queries.ts:429-445`: o tipo do filtro e o `scope` incluem somente `connectionId` e `ownerId`.
- `src/modules/pipeline/queries.ts:449-474`: tanto a busca por mensagens quanto a busca por contato executam sem condição de unidade.
- Em contraste, `src/app/api/crm/queues/route.ts:18-27` calcula e aplica `unitId`.

Causa raiz: os dois eixos de isolamento, unidade e dono, foram implementados de forma diferente entre a fila e a busca.

Impacto: exposição de nome, telefone e conteúdo de conversa fora do escopo autorizado. Também faz a busca mostrar leads de outro perfil de visualização.

Sugestão `[FIX NOW]`: fazer a rota de busca resolver o mesmo `EscopoUnidade` da rota de filas e passar `unitId` para `searchConversations`; aplicar `filtroUnidade(leads.unitId, filter.unitId)` em todas as consultas. Adicionar teste de rota para usuário preso a uma unidade. Isso muda apenas o filtro de uma leitura existente e não toca o fluxo de mensagens.

### 2. Cache do quadro não é isolado por usuário

Problema: `boardCache` vive no escopo do módulo e sua chave é somente `connectionId`. Logout e login usam navegação client-side, portanto o cache JavaScript pode sobreviver à troca de sessão. Ao abrir o CRM com outra conta, o componente pode pintar imediatamente os leads da conta anterior antes da revalidação autenticada.

Evidência:

- `src/app/(dashboard)/crm/page.tsx:220-229`: o comentário confirma que o cache sobrevive à navegação e a chave é apenas a conexão.
- `src/app/(dashboard)/crm/page.tsx:389-394`: o cache é aplicado diretamente ao estado antes do fetch.
- `src/components/Sidebar.tsx:150-152`: logout usa `router.replace('/login')`, sem recarga total.
- `src/app/(auth)/login/login-client.tsx:109-115`: login normal usa `router.push` e `router.refresh`, também sem recarga total garantida.

Causa raiz: o cache guarda dados autorizados, mas sua chave representa apenas o filtro visual, não o principal autenticado nem o escopo de unidade.

Impacto: exposição temporária de dados entre contas no mesmo navegador. Pela regra de severidade da revisão, exposição de dados é crítica mesmo quando breve.

Sugestão `[FIX NOW]`: tornar a chave composta por identidade, unidade e conexão, ou limpar todo cache autenticado no logout e na mudança de identidade. A solução mais robusta é o layout servidor fornecer um `scopeKey` opaco para o cliente, sem expor permissões, e o módulo nunca renderizar cache cujo `scopeKey` diverge do atual.

## HIGH

### 3. Troca para aba sem cache mantém os leads da aba anterior na tela

Problema: quando `activeConn` muda e não existe cache para a nova conexão, o efeito marca `loading`, mas não limpa nem invalida `data`. Como o quadro renderiza sempre que `data` existe, a aba nova mostra o conjunto anterior até o fetch terminar.

Evidência:

- `src/app/(dashboard)/crm/page.tsx:385-394`: o ramo sem cache chama somente `setLoading(true)` e em seguida `load()`.
- `src/app/(dashboard)/crm/page.tsx:474-475`: `rawQueues` continua derivado do `data` antigo.
- `src/app/(dashboard)/crm/page.tsx:547-561`: para qualquer conexão que não seja `email`, não há filtro client-side adicional que esconda os cards antigos.
- `src/app/(dashboard)/crm/page.tsx:763-768`: o placeholder de carga só aparece com `loading && !data`.
- `src/app/(dashboard)/crm/page.tsx:805`: o quadro antigo continua renderizado com `data && !searchActive`.

Causa raiz: `data` não carrega a identidade do filtro que o produziu. O componente sabe qual aba está ativa e quais dados possui, mas não consegue provar que ambos correspondem.

Impacto: reproduz exatamente o relato de leads de outro perfil aparecerem e depois sumirem.

Sugestão `[FIX NOW]`: representar o estado como `{ scopeKey, payload }` e renderizar somente quando `scopeKey === activeScopeKey`. Se não houver cache compatível, mostrar skeleton mantendo a geometria do board. Apenas chamar `setData(null)` reduz o sintoma, mas o estado etiquetado elimina a classe inteira de erro.

### 4. Resultados de busca antigos continuam visíveis enquanto outro filtro busca

Problema: quando o termo ou a conexão muda, o efeito liga `searchLoading`, mas preserva `searchResults`. O componente de resultados continua mapeando esses cards durante o loading. A flag `cancelled` evita que uma resposta antiga seja aplicada depois, mas não esconde os resultados que já estavam no estado.

Evidência:

- `src/app/(dashboard)/crm/page.tsx:253-273`: o início de uma busca não limpa nem etiqueta `searchResults`.
- `src/app/(dashboard)/crm/page.tsx:795-802`: a tela passa os resultados antigos junto com `loading=true`.
- `src/app/(dashboard)/crm/page.tsx:1189-1219`: o cabeçalho mostra o spinner, mas a grade ainda executa `results.map(...)`.

Causa raiz: estado de resultado separado da chave da consulta, com o mesmo problema estrutural do quadro.

Impacto: ao trocar conexão com uma busca ativa, aparecem conversas da conexão anterior até a resposta correta chegar.

Sugestão `[FIX NOW]`: armazenar `{ queryKey, results }`, renderizar somente a chave ativa e usar `AbortController` no cleanup. O estado de loading deve pertencer à mesma chave.

### 5. Loads concorrentes da mesma aba podem chegar fora de ordem

Problema: `connSeq` invalida respostas de outra aba e `moveSeq` invalida respostas anteriores a uma movimentação, mas duas leituras da mesma aba compartilham os mesmos valores. Polling, foco da janela, refresh manual e refresh após PATCH podem sobrepor requisições. Se a mais antiga responder por último, ela atualiza `boardCache`, `boardSig` e `data` com um snapshot anterior.

Evidência:

- `src/app/(dashboard)/crm/page.tsx:344-362`: não existe contador por requisição, `AbortSignal` ou single-flight.
- `src/app/(dashboard)/crm/page.tsx:361`: o cache é atualizado antes da verificação de validade da resposta.
- `src/app/(dashboard)/crm/page.tsx:399-418`: polling e eventos de foco podem iniciar novas leituras sem consultar uma requisição em voo.
- `src/app/(dashboard)/crm/page.tsx:665`: o refresh manual abre outra leitura.
- `src/app/(dashboard)/crm/page.tsx:467`: uma movimentação concluída também abre outra leitura.

Causa raiz: a versão é controlada por aba e mutação, não por request.

Impacto: card pode voltar temporariamente para estado anterior, dados novos podem desaparecer até o próximo poll e requisições duplicadas aumentam a pressão no Worker e no banco.

Sugestão `[FIX NOW]`: um coordenador de leitura no módulo `pipeline` com single-flight por `scopeKey`, `AbortController` para scope abandonado e `requestSeq` para aceitar somente a resposta mais recente. Atualizar cache apenas depois de validar a sequência.

## MEDIUM

### 6. A aba E-mail não restringe a busca ao canal de e-mail

Problema: para `activeConn === 'email'`, o cliente omite `connectionId`. A rota e a query não aceitam `channel`, logo a busca retorna WhatsApp e e-mail juntos.

Evidência:

- `src/app/(dashboard)/crm/page.tsx:262-264`: `email` segue sem qualquer filtro na query string.
- `src/app/api/crm/search/route.ts:16-25`: a rota lê somente `q` e `connectionId`.
- `src/modules/pipeline/queries.ts:429-445`: a query não tem recorte por canal.

Impacto: resultado incorreto e aparência de leads de outro filtro.

Sugestão `[FIX NOW]`: aceitar um `channel=email` validado na leitura do CRM e aplicá-lo na query. Alternativamente, filtrar o resultado no cliente, mas isso transfere dados desnecessários e não corrige o custo no servidor.

### 7. Busca cancelada visualmente continua consumindo rede e banco

Problema: o cleanup muda apenas uma flag booleana e limpa o debounce. Se o fetch já começou, ele continua. Cada busca executa duas consultas independentes de forma sequencial e uma terceira consulta de hidratação. O `ILIKE '%termo%'` em corpo de mensagens não possui índice trigram no schema observado.

Evidência:

- `src/app/(dashboard)/crm/page.tsx:259-272`: nenhum `AbortController` é usado.
- `src/modules/pipeline/queries.ts:447-497`: as consultas de conteúdo, contato e hidratação são encadeadas.
- `src/lib/db/schema/messages.ts:94-105`: existem índices de lead, timestamp e composto, mas nenhum índice para busca textual.

Impacto: alternar filtros e digitar repetidamente deixa trabalho obsoleto executando, elevando a latência das requisições que realmente interessam.

Sugestão `[FIX NOW]`: abortar fetch anterior no cliente, paralelizar as duas primeiras consultas e medir `EXPLAIN ANALYZE` antes de adicionar um índice trigram. O índice fica `[BACKLOG]` até haver medição no banco real.

## Lacunas de testes

Não existe teste do estado do CRM para os seguintes cenários:

1. conexão A lenta, troca para B e resposta de A chega depois;
2. troca A, B, A com requisições simultâneas;
3. duas leituras concorrentes da mesma aba respondendo fora de ordem;
4. busca ativa durante troca de conexão;
5. logout da conta A e login da conta B na mesma sessão do navegador;
6. busca por usuário preso a uma unidade.

O teste `src/__tests__/use-dados.test.ts` cobre troca de URL no hook genérico, mas o CRM não usa esse hook e mantém uma implementação paralela.

## Plano recomendado para correção

1. Congelar o comportamento com testes de regressão dos seis cenários acima.
2. Extrair a leitura do quadro e a busca para `src/modules/pipeline/hooks/`, mantendo UI, estado, cache e coordenação de requests dentro da vertical do pipeline.
3. Introduzir `scopeKey` composto por identidade, unidade, canal/conexão e termo quando aplicável.
4. Impedir render de payload cuja chave não corresponda à chave ativa.
5. Aplicar single-flight, aborto no abandono do scope e aceitação somente da resposta mais recente.
6. Corrigir a paridade de escopo entre filas e busca, incluindo unidade e canal de e-mail.
7. Reduzir trabalho obsoleto da busca e medir as queries antes de qualquer alteração de índice.
8. Validar com teste de componente usando latências invertidas, teste de rota para unidade, typecheck e smoke autenticado.
9. Confirmar explicitamente que webhooks, ingestão, envio e recebimento de mensagens não sofreram diff.

## Parecer

Não considerar o fluxo de filtros estabilizado ainda. O ajuste recente de `connSeq` resolve uma corrida específica, mas o modelo de estado continua sem associar payload e escopo. A correção mais simples e elegante é centralizar essa associação no módulo `pipeline`, em vez de adicionar mais flags independentes na página de aproximadamente duas mil linhas.
