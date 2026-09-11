# Spike — RealtimeHub (Durable Object + WebSocket Hibernation)

Prova de conceito isolada da peça mais incerta da migração pra Cloudflare:
**substituir o Socket.IO do CRM por um Durable Object com WebSocket.**

Roda sozinho, sem o app Next, sem banco, sem Redis.

## O que ele prova

1. Workers **mantém conexões WebSocket abertas** (via Durable Object) — algo que Socket.IO fazia e Workers "puro" não faz.
2. O **fan-out** funciona: um `POST /api/emit` chega em todas as abas conectadas — exatamente o `emitToEmpresa('crm', event, data)` de hoje.
3. Usa a **Hibernation API** (`ctx.acceptWebSocket`), que é o que deixa manter N conexões abertas custar ~nada quando estão ociosas.

## Rodar

Precisa de uma conta Cloudflare logada no wrangler (`npx wrangler login`) — mas o `dev` roda **local**, não precisa deploy.

```bash
cd "CRM Base/spikes/realtime-do"
npm install
npm run dev          # sobe em http://localhost:8787
```

Abra `http://localhost:8787` **em duas abas**. O ponto fica verde ("conectado").
Clique em qualquer botão de evento numa aba → **as duas abas** logam o evento na hora.

Isso é o CRM ganhando realtime de verdade (push), no lugar do polling de 4s de hoje.

## Como isso vira produção (Fase 4)

| Neste spike | No app Next |
|---|---|
| `RealtimeHub` DO (`src/index.ts`) | mesma classe, movida pro Worker do app |
| `POST /api/emit` | `emitToEmpresa()` reescrito pra chamar o stub do DO |
| WS client na `index.html` | hook `useRealtime()` que os componentes consomem |
| botões de evento | os `emitToEmpresa(CRM_ROOM, …)` que já existem nos services |

O contrato de eventos **não muda** — `message:new`, `lead:notify`, `lead:statusChanged`,
`lead:urgencyAlert`, etc. continuam iguais. Só troca o transporte.

## Custo

1 hub, conexões hibernando: dentro do incluído no Workers Paid (~$0). Sem processo
sempre-ligado, sem sticky sessions, sem PM2.
