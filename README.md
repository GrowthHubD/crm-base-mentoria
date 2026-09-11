# CRM WhatsApp — Base

Base reutilizável de CRM de atendimento por **WhatsApp** (via [uazapi](https://uazapi.com) v2) com **IA opcional**. Single-tenant, sem regra de negócio de nicho — um esqueleto pronto pra construir CRMs de WhatsApp em cima.

## Stack

- **Next.js 15** (App Router, custom server pra Socket.IO + workers) + **React 19**
- **Drizzle ORM** + **PostgreSQL** (Neon, Supabase, local…)
- **better-auth** (email/senha, roles `admin`/`attendant`)
- **BullMQ + Redis** (fallback inline quando Redis está off)
- **Socket.IO** (realtime)
- **uazapi v2** (canal WhatsApp)
- **OpenRouter** (agente IA opcional — chat completions)

## Funcionalidades

- Canal WhatsApp: conexão por QR, envio/recebimento de texto, imagem, vídeo, documento, áudio/PTT (com transcrição), quote e reactions.
- Leads + pipeline kanban com escalação automática por tempo de espera.
- Chat por lead com composer completo (emoji, textos rápidos, colar print, gravar áudio).
- Agendamento de mensagens e follow-ups automáticos.
- Agente IA genérico: auto-reply configurável (prompt, personalidade, tom), horário de operação, transferência por palavra-chave. Desligado por padrão — o CRM funciona 100% no manual.
- Dashboard de KPIs, ranking de atendentes, gestão de usuários.

## Setup (≈10 min)

Requer Node 22+ e um PostgreSQL.

```bash
npm install
cp .env.example .env
# preencha no mínimo: DATABASE_URL, BETTER_AUTH_SECRET, ENCRYPTION_KEY
npm run db:push          # cria as tabelas
npm run db:seed          # cria admin@crm.local / admin12345
npm run dev              # http://localhost:9876
```

Login inicial: `admin@crm.local` / `admin12345`.

Pra receber mensagens: preencha as vars `UAZAPI_*` + `WEBHOOK_SECRET`, conecte um número em **/conexoes** (QR code) e aponte o webhook da instância pra `https://SEU_HOST/api/webhooks/whatsapp/<connectionId>`.

Pra ligar a IA: preencha `OPENROUTER_API_KEY` e configure em **/agente-ia**.

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe o app + workers (tsx watch) |
| `npm run build` / `npm start` | Build e produção |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest |
| `npm run db:push` | Sincroniza schema (dev) |
| `npm run db:generate` | Gera SQL migration versionada (fluxo prod) |
| `npm run db:studio` | UI do banco (Drizzle Studio) |

## Arquitetura

Ver [`CLAUDE.md`](CLAUDE.md) — padrões obrigatórios, camadas e anti-patterns.

Fluxo inbound: `uazapi → /api/webhooks/whatsapp/[connectionId] → (BullMQ ou inline) → processInboundPayload → upsert lead + grava mensagem + Socket.IO + (se IA ativa) enfileira resposta`.
