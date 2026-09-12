# CRM WhatsApp — Base

Base reutilizável de CRM de atendimento por **WhatsApp** com **agente de IA opcional**.
Uma instalação por cliente, sem regra de negócio de nicho — um esqueleto pronto pra
construir CRMs de WhatsApp em cima.

Roda de dois jeitos, com o mesmo código:

| | Node (VPS / máquina local) | Cloudflare Workers |
|---|---|---|
| Servidor | `server.ts` (Next + Socket.IO + workers BullMQ) | OpenNext + `worker-entry.js` |
| Banco | PostgreSQL direto | PostgreSQL via Hyperdrive |
| Fila | Redis/BullMQ **opcional** | não existe — tudo inline + Cron Trigger |
| Mídia | disco local ou R2 (SDK S3) | R2 (binding) |

## Stack

- **Next.js 15** (App Router) + **React 19**
- **Drizzle ORM** + **PostgreSQL** (Neon, Supabase, local…)
- **better-auth** (e-mail/senha, papéis `admin` / `attendant`)
- **BullMQ + Redis** (opcional — sem Redis o sistema roda inline)
- **WhatsApp**: Cloud API oficial da Meta, uazapi ou Evolution — escolhido **por conexão**
- **OpenRouter** (agente de IA, chat completions) + **OpenAI Whisper** (transcrição de áudio)

## Funcionalidades

- WhatsApp: envio/recebimento de texto, imagem, vídeo, documento, áudio/PTT (com transcrição), citação e reações.
- Leads + pipeline kanban com colunas editáveis e escalação automática por tempo de espera.
- Chat por lead com composer completo (emoji, textos rápidos, colar print, gravar áudio).
- Mensagens agendadas, follow-ups automáticos e automações por gatilho.
- Agente de IA: auto-resposta configurável (prompt, personalidade, tom), horário de operação, transferência por palavra-chave. Desligado por padrão.
- Dashboard de KPIs, ranking de atendentes, unidades (filiais), carteira por atendente, gestão de usuários.
- Backup diário do banco (NDJSON) para o R2.

## Setup em dev (≈10 min)

Requer **Node 22+** e um **PostgreSQL** (local, Neon, Supabase…). Redis é opcional.

```bash
npm install
cp .env.example .env
```

Preencha no `.env`, no mínimo:

```bash
DATABASE_URL=postgresql://...
BETTER_AUTH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Depois:

```bash
npm run db:push     # cria as tabelas
npm run db:seed     # cria o admin e IMPRIME a senha (sorteada) — guarde
npm run dev         # http://localhost:9876
```

O seed não tem senha padrão. Para escolher a sua: `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run db:seed`.
Rodar o seed de novo não troca a senha de quem já existe.

## Módulos e flags

Cada módulo vendido à parte nasce **desligado** (`src/lib/plan.ts`). Ligar é por instalação, no `.env` (ou nas `vars` do `wrangler.jsonc`):

| Flag | Padrão | O que liga | Precisa também de |
|---|---|---|---|
| `FEATURE_AI_AGENT` | off | tela `/agente-ia` e auto-resposta | `OPENROUTER_API_KEY` |
| `FEATURE_SCHEDULING` | off | mensagens agendadas | tick do cron (abaixo) |
| `FEATURE_FOLLOWUPS` | off | follow-ups automáticos | tick do cron |
| `FEATURE_QUICK_REPLIES` | off | textos rápidos no composer | — |
| `FEATURE_RANKING` | **on** | ranking de atendentes | — |
| `FEATURE_UNITS` | off | unidades/filiais | — |
| `FEATURE_LEAD_OWNERSHIP` | off | cada atendente vê só a própria carteira | — |
| `FEATURE_EMAIL` | off | canal de e-mail (Gmail OAuth) | `GOOGLE_CLIENT_ID/SECRET` |
| `FEATURE_KANBAN_MANUAL` | off | card só muda de coluna quando arrastado (funil de vendas) | — |

## WhatsApp — conectando um número

O CRM fala com três provedores e a escolha é **por conexão**, não global.

**Cloud API oficial da Meta (recomendado).** Sem QR: o número é cadastrado com a credencial da Meta.

```bash
npm run connect:cloud -- --phone-number-id <ID> --token <SYSTEM_USER_TOKEN>
```

No painel da Meta, aponte o webhook para `https://SEU_HOST/api/webhooks/meta/<connectionId>` com o
`META_VERIFY_TOKEN` do seu `.env`, e preencha `META_APP_SECRET` — sem ele o webhook aceita qualquer payload.
Fora da janela de 24h só sai template aprovado; o adapter traduz o erro para o atendente.

**uazapi (não oficial).** Preencha `UAZAPI_*`, conecte em **/conexoes** (QR) e aponte o webhook da instância
para `https://SEU_HOST/api/webhooks/whatsapp/<connectionId>`. O UUID da conexão na URL é o segredo.

**Evolution API (não oficial, servidor próprio).** Preencha `EVOLUTION_URL` + `EVOLUTION_GLOBAL_API_KEY`;
a tela de Conexões passa a oferecer a opção.

> Provedor não oficial viola os termos da Meta e o número pode ser bloqueado. Use um número dedicado à
> automação, nunca o institucional.

## IA

1. `FEATURE_AI_AGENT=true`
2. `OPENROUTER_API_KEY=...` (e `AI_MODEL_ID` se quiser trocar o modelo)
3. Configure em **/agente-ia** (prompt, horário, transferência).

`OPENAI_API_KEY` é só para transcrever áudio recebido (Whisper) — sem ela, áudio não vira texto.

## Filas e tarefas agendadas

**Com Redis** (`REDIS_URL` preenchido, `docker compose up -d` sobe um local): BullMQ processa webhooks e
os workers em `src/workers/` disparam escalação, agendadas e follow-ups sozinhos.

**Sem Redis** (`REDIS_URL` vazio — o padrão): o webhook processa inline e **nada agendado dispara sozinho**.
Quem acorda escalação, mensagens agendadas, follow-ups, automações e backup é `POST /api/cron/tick`, que
precisa ser chamado **a cada minuto** com o `CRON_SECRET`:

```bash
# crontab do servidor Node
* * * * * curl -s -X POST -H "x-cron-secret: $CRON_SECRET" https://SEU_HOST/api/cron/tick
```

No Cloudflare isso é o Cron Trigger do `wrangler.jsonc` — não precisa configurar nada.

## Mídia e segurança

- Mídia fica no R2 (ou em `tmp/media` em dev) e é servida pela rota pública `/api/media/[key]` — é a URL que
  o provedor busca para enviar o arquivo. A rota **nunca** serve o prefixo `backups/` e devolve tudo que não é
  imagem/áudio/vídeo/PDF como download com `nosniff`; o upload recusa HTML/SVG/JS.
- **Backup vai num bucket privado separado** (binding `BACKUPS`, ver `wrangler.jsonc`). Sem ele o backup cai
  no bucket de mídia com aviso no log — mitigado pela rota, mas não isolado.
- Toda rota autenticada chama `requireSession`/`requireAdmin` — há um teste estrutural que falha quando
  uma rota nova aparece sem guarda. O cadastro público do better-auth está fechado no `middleware.ts`.
- Segredos só em `.env` (dev) ou `wrangler secret` (Cloudflare). Nunca em arquivo versionado.

## Produção em Node (VPS)

```bash
npm run build
NODE_ENV=production PORT=9876 npm start      # ou pm2 start ecosystem.config.js
```

`NODE_ENV=production` é obrigatório: `server.ts` decide dev/prod por ele. Coloque um nginx na frente
(`nginx.conf` de exemplo) com HTTPS — o cookie de sessão é `__Secure-` e é descartado em `http`.

## Produção no Cloudflare

Um cliente = um Worker = um `env` no `wrangler.jsonc` (nome, `DB_SCHEMA`, Hyperdrive, domínio).

1. Postgres com um schema por cliente: `npm run cliente:novo -- <slug> "<Nome>"` cria schema, role e imprime a
   string de conexão.
2. `npx wrangler hyperdrive create <nome> --connection-string=... --caching-disabled` — **cache de consulta
   desligado**, obrigatório num CRM. Cole o `id` no env.
3. Buckets: `npx wrangler r2 bucket create <midia>` e outro para `BACKUPS`.
4. Segredos: `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `CRON_SECRET` (+ `META_APP_SECRET`, `OPENROUTER_API_KEY`…)
   via `npx wrangler secret put X --env <slug>`.
5. `npm run cf:build && npx wrangler deploy --env <slug>`, depois `npm run smoke -- <slug>`.

Áudio/PTT gravado no composer depende de ffmpeg, que não existe no Worker — o áudio sai como anexo.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | app + workers (tsx watch) |
| `npm run build` / `npm start` | build e produção Node |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run db:push` | sincroniza schema (dev) |
| `npm run db:generate` / `db:migrate` | migrations versionadas (prod) |
| `npm run db:seed` | admin inicial |
| `npm run db:studio` | UI do banco |
| `npm run connect:cloud` | cadastra número da Cloud API |
| `npm run cf:build` / `cf:deploy` | build OpenNext / deploy |
| `npm run cliente:novo` | provisiona schema + role de um cliente novo |
| `npm run smoke -- <env>` | bateria de fumaça contra um deploy |

## Arquitetura

Ver [`CLAUDE.md`](CLAUDE.md) — padrões obrigatórios, camadas e anti-patterns.

Fluxo inbound: `provedor → /api/webhooks/... → parser do canal → ingestParsedInbound → upsert lead + grava
mensagem + automações + (se IA ativa) resposta`. O que muda entre provedores fica no parser e no adapter,
nunca na regra de negócio.
