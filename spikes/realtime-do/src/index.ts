/**
 * Spike: realtime via Durable Object (substitui Socket.IO).
 *
 * Mapa pro código de produção do CRM Base:
 *   - Socket.IO server (`server.ts` + `lib/socket.ts`)  →  este Worker + RealtimeHub DO
 *   - `emitToEmpresa(room, event, data)`                →  POST /api/emit  → hub.broadcast()
 *   - `socket.io-client` (que o CRM nunca teve)         →  WebSocket nativo em /api/realtime
 *
 * Single-tenant: 1 hub só, endereçado por idFromName('crm'). Multi-tenant
 * no futuro = idFromName(tenantId) e pronto — cada tenant seu próprio hub isolado.
 */

export interface Env {
  REALTIME_HUB: DurableObjectNamespace;
  ASSETS: Fetcher;
}

const HUB_NAME = 'crm'; // = CRM_ROOM do app hoje

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const stub = env.REALTIME_HUB.get(env.REALTIME_HUB.idFromName(HUB_NAME));

    // Browser abre a conexão realtime aqui (WebSocket upgrade → encaminha pro hub).
    if (url.pathname === '/api/realtime') {
      if (req.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      return stub.fetch(new Request('https://hub/ws', req));
    }

    // "emitToEmpresa" server-side: qualquer service/worker faria este POST.
    // Body: { "event": "message:new", "data": {...} }
    if (url.pathname === '/api/emit' && req.method === 'POST') {
      const body = await req.text();
      return stub.fetch(
        new Request('https://hub/broadcast', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
      );
    }

    // Página de teste (asset estático). Em produção, isto é o app Next.
    return env.ASSETS.fetch(req);
  },
};

/**
 * RealtimeHub — mantém as conexões WebSocket abertas e faz fan-out dos eventos.
 *
 * Usa a Hibernation API (`ctx.acceptWebSocket`): sockets ociosos não são
 * cobrados por duração até chegar mensagem. É o que torna manter N conexões
 * abertas ~grátis (vs. ~13x mais caro num WS always-on).
 */
export class RealtimeHub {
  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Fan-out: envia o payload pra TODAS as conexões vivas (inclusive hibernadas).
    if (url.pathname === '/broadcast') {
      const payload = await req.text();
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) {
        try {
          ws.send(payload);
        } catch {
          // socket morto entre o getWebSockets e o send — ignora
        }
      }
      return Response.json({ delivered: sockets.length });
    }

    // Upgrade WebSocket com hibernation.
    if (url.pathname === '/ws') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      // acceptWebSocket (NÃO server.accept()) = habilita hibernação.
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  // Handlers exigidos pela Hibernation API (o runtime os chama ao acordar o DO).

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // No CRM os clients são só-recebem. Tratamos apenas um "ping" pra keepalive.
    if (message === 'ping') {
      ws.send('pong');
    }
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _clean: boolean): Promise<void> {
    try {
      ws.close(code === 1006 ? 1000 : code);
    } catch {
      /* já fechado */
    }
  }

  async webSocketError(_ws: WebSocket, _err: unknown): Promise<void> {
    // conexão quebrada — o runtime já remove do getWebSockets(); nada a fazer
  }
}
