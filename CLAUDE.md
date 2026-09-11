# CRM WhatsApp (Base) — Contexto pra IA

> Lido automaticamente por Claude Code, Cursor e similares.

## O que é

CRM white-label de atendimento por WhatsApp (marca **Lidy**), vendido a clientes
finais. Sem regra de negócio de nicho.

**Isolamento em dois níveis** — não confundir:

- **Cliente assinante = instância.** Cada cliente tem o próprio Worker e o próprio
  banco. É por isso que não existe escopo de tenant dentro do código: o isolamento
  entre clientes é físico.
- **Unidades = `unitId` DENTRO da instância.** Um cliente pode ter várias filiais.
  Isso é **núcleo do produto**, não add-on. (Pendente de implementação — ver abaixo.)

Stack: Next.js 15 (App Router, custom server) + React 19 + Drizzle ORM + PostgreSQL + better-auth + BullMQ/Redis + Socket.IO + uazapi v2 (WhatsApp) + OpenRouter (IA opcional, chat completions).

## O que tem pronto

- **Canal WhatsApp** via uazapi v2 (client + adapter + webhook parser + process-inbound resiliente).
- **Leads + Pipeline** (kanban Novo→Prioridade→Urgência→Respondidos→Convertidos, escalação automática por tempo).
- **Chat** por lead (texto, mídia, áudio/PTT com transcrição, quote, reactions, emoji, textos rápidos).
- **Workers BullMQ**: inbound, outbound (com "digitando..."), escalação (cron), scheduler (agendadas + follow-ups), ai-agent, notification.
- **Agente IA genérico** (opcional): auto-reply configurável por prompt/personalidade, horário de operação, transferência por palavra-chave, follow-ups. Sem catálogo/pagamento/booking — plugue tools em `modules/ai-agent/tools.ts` se precisar.
- **Dashboard** com KPIs, **Agendamentos**, **Conexões**, **Ranking**, gestão de **Usuários** (admin/atendente).
- **Deploy Cloudflare**: OpenNext + Hyperdrive (cache de query DESLIGADO) + R2 (binding) +
  Cron Trigger pra escalação, via `worker-entry.js`. Sem Redis em produção.

## Padrões obrigatórios

- **Service layer**: `route.ts` → `service.ts` → `queries.ts`/`mutations.ts`. Workers chamam o mesmo service. Não duplicar lógica.
- **Adapter pattern**: integrações externas (uazapi) sempre via adapter (`modules/channels/types.ts`).
- **Imports**: alias `@/...`, nunca relativo longo. Client components importam de `@/modules/<x>/types`, nunca do barrel server-only.
- **Webhook**: SEMPRE retorna 200. Enfileira BullMQ; fallback inline se Redis off.
- **Idempotência**: mensagens via `messages.external_id` (unique).
- **Encryption**: tokens uazapi em `connections.access_token_encrypted` via `@/lib/encryption`.
- **Módulos por plano**: `src/lib/plan.ts`. Add-ons pagos (agente IA, agendamentos/
  follow-ups, textos rápidos) nascem DESLIGADOS; o que é do plano base usa flag
  opt-out. Papel (`adminOnly`) é eixo separado: papel = o que o usuário pode,
  plano = o que a empresa contratou.
- **Regime sem Redis**: `QUEUES_ENABLED` decide. No Cloudflare não há fila nem
  worker — a rota executa inline via `@/lib/dispatch`. Trabalho depois da resposta
  SEMPRE via `runInBackground` (`@/lib/background`): promise solta morre quando o
  Worker responde.
- **Nenhuma fila sem caminho inline**: `queue.add()` sem Redis é um no-op que
  devolve `null` — não lança. Todo produtor precisa do par: enfileira quando há
  fila, executa quando não há. Já mordeu duas vezes (outbound sumindo com HTTP
  200; e a IA inteira muda em produção). Produtor novo nasce com o par.
- **Agendado = linha no banco, não job**: o job do BullMQ sempre foi só o
  despertador. Quem tem `scheduledAt` + `status` no banco (mensagens agendadas,
  follow-ups, steps de automação) é varrido por `/api/cron/tick`, chamado pelo
  Cron Trigger a cada minuto via `worker-entry.js`. A regra do disparo vive em
  `modules/scheduler/runner.ts` — worker e cron chamam a MESMA função.
- **Schema novo**: exportar em `lib/db/schema/index.ts`. O drizzle-kit só cria o que
  passa pelo barrel — `attendant_close_log` ficou de fora e a tabela nunca existiu,
  com o Ranking em 500 e conversões não registradas.

## Dois canais de WhatsApp

O CRM fala com os dois, e a escolha é POR CONEXÃO — não global:

| | uazapi (não-oficial) | Cloud API (oficial) |
|---|---|---|
| Como conecta | QR code, na tela de Conexões | `npm run connect:cloud` (credencial da Meta) |
| Marcador | `metadata.provider` ausente | `metadata.provider = "cloud-api"` |
| `external_id` | id da instância | `phone_number_id` |
| Webhook | `/api/webhooks/whatsapp/<connectionId>` | `/api/webhooks/meta/<connectionId>` |
| "digitando...", editar, apagar | sim | **não existem** — o adapter faz no-op |
| Mídia recebida | URL/base64 no webhook | só `media_id`: 2 chamadas autenticadas |
| Fora da janela de 24h | irrelevante | só template aprovado (erro 131047) |

Regra estrutural: **o que muda entre canais fica no parser e no adapter, nunca
na regra de negócio**. Os dois parsers produzem `ParsedInbound` e entram no
mesmo `ingestParsedInbound` (`whatsapp/process-inbound.ts`), que cria lead,
grava mensagem, dispara automações e o agente. Se você se pegar escrevendo
`if (provider === ...)` fora de `channels/service.ts`, parou no lugar errado.

Variáveis do canal oficial: `META_VERIFY_TOKEN` (GET de verificação),
`META_APP_SECRET` (assinatura de cada POST — sem ele o webhook aceita qualquer
payload) e `META_GRAPH_VERSION`. O token do número não vive em env: fica
criptografado na connection.

## Unidades (`unitId`) — PENDENTE, e é núcleo

A regra antiga dizia "NÃO reintroduza `unitId`". **Foi revogada em 13/08/2026**: o
João definiu que cada cliente assinante pode ter várias unidades, como no Motel.
Aquela proibição foi simplificação de fork — na hora de podar, multi-unidade entrou
no balde de "coisa de motel" sem que ninguém tivesse perguntado se os clientes
teriam filiais.

Ainda não implementado. Ao fazer: portar `modules/units` do Sistema Motel (lá são
~98 arquivos tocando `unitId`, então planeje). Não é plano adicional — é base.

## Anti-patterns

- ❌ `output: 'standalone'` no Next config (quebra Socket.IO)
- ❌ `edge runtime` em rotas (incompatível com BullMQ/Drizzle/Socket.IO)
- ❌ Workers importando de `src/app/`
- ❌ `fetch('https://api.uazapi.com')` fora de `modules/channels/whatsapp/client.ts`

## Comandos

```bash
npm install
cp .env.example .env        # preencha DATABASE_URL, BETTER_AUTH_SECRET, ENCRYPTION_KEY
npm run db:push             # sincroniza schema (dev)
npm run db:seed             # cria admin@crm.local / admin12345
npm run dev                 # http://localhost:9876

npm run typecheck           # tsc --noEmit
npm test                    # vitest
npm run db:studio           # UI do banco
npm run db:generate         # gera SQL migration (commit antes de prod)
```

## Idioma

Código, identifiers, commits: inglês. Comentários/docs/PRs: português.
