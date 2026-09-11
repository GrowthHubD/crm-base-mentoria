/**
 * O webhook da uazapi tem que ACEITAR payload sem header de segredo.
 *
 * A uazapi não envia header nenhum — dá para acrescentar dados na URL, não no
 * cabeçalho. Mesmo assim a rota comparava `x-webhook-secret` com
 * `WEBHOOK_SECRET` e, quando não batia, respondia **200** e descartava. Do
 * lado do provedor ficava "entregue"; do lado do cliente, o CRM vazio.
 *
 * O que fechou a armadilha: a variável nem tinha sido escolhida por ninguém —
 * ela vinha do `.env` da máquina de desenvolvimento, embutida no bundle pelo
 * build do OpenNext. Um cliente novo já nascia com a porta trancada.
 *
 * A autenticação desta rota é o UUID da conexão na URL. Se alguém reintroduzir
 * a exigência de header, este teste cai.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const processInboundPayload = vi.fn(async () => ({ ok: true as const }));
const persistEvent = vi.fn(async (_e: unknown) => ({ id: 'evt-1' as string | null, isNew: true }));
const markDone = vi.fn(async () => {});
const markAttemptFailed = vi.fn(async () => {});

vi.mock('@/modules/channels/whatsapp/process-inbound', () => ({
  processInboundPayload: (...a: unknown[]) => processInboundPayload(...(a as [])),
}));
vi.mock('@/modules/webhook-events', () => ({
  persistEvent: (e: unknown) => persistEvent(e),
  markDone: (...a: unknown[]) => markDone(...(a as [])),
  markAttemptFailed: (...a: unknown[]) => markAttemptFailed(...(a as [])),
}));
vi.mock('@/lib/queue', () => ({ messageQueue: { add: vi.fn() }, QUEUES_ENABLED: false }));
vi.mock('@/lib/background', () => ({ runInBackground: (p: Promise<unknown>) => p }));

const CONN = 'b5fe4fd9-2cad-4f64-a93b-be0fc6b35515';

function requisicao(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`https://cliente.exemplo/api/webhooks/whatsapp/${CONN}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const PAYLOAD = {
  EventType: 'messages',
  message: { id: 'MSG-1', chatid: '5551999999999@s.whatsapp.net', text: 'teste', fromMe: false },
};

const original = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.env = { ...original };
});

describe('webhook uazapi por conexão', () => {
  it('processa mesmo com WEBHOOK_SECRET definido e nenhum header enviado', async () => {
    process.env.WEBHOOK_SECRET = 'segredo-que-veio-de-carona-no-bundle';
    const { POST } = await import('@/app/api/webhooks/whatsapp/[connectionId]/route');

    const res = await POST(requisicao(PAYLOAD), { params: Promise.resolve({ connectionId: CONN }) });

    expect(res.status).toBe(200);
    expect(processInboundPayload).toHaveBeenCalledTimes(1);
  });

  it('grava o evento cru ANTES de processar', async () => {
    const { POST } = await import('@/app/api/webhooks/whatsapp/[connectionId]/route');
    await POST(requisicao(PAYLOAD), { params: Promise.resolve({ connectionId: CONN }) });

    expect(persistEvent).toHaveBeenCalledTimes(1);
    const arg = persistEvent.mock.calls[0][0] as {
      provider: string; connectionId: string; eventKey: string; payload: unknown;
    };
    expect(arg.provider).toBe('uazapi');
    expect(arg.connectionId).toBe(CONN);
    expect(arg.payload).toEqual(PAYLOAD);
    // A ordem é o ponto: sem o evento gravado, o 200 seria uma promessa vazia.
    expect(persistEvent.mock.invocationCallOrder[0])
      .toBeLessThan(processInboundPayload.mock.invocationCallOrder[0]);
  });

  it('reentrega do mesmo evento não processa de novo', async () => {
    persistEvent.mockResolvedValueOnce({ id: null, isNew: false });
    const { POST } = await import('@/app/api/webhooks/whatsapp/[connectionId]/route');

    const res = await POST(requisicao(PAYLOAD), { params: Promise.resolve({ connectionId: CONN }) });

    expect(res.status).toBe(200);
    expect(processInboundPayload).not.toHaveBeenCalled();
  });

  it('banco fora vira 500, não 200 mudo', async () => {
    persistEvent.mockRejectedValueOnce(new Error('CONNECTION_CLOSED'));
    const { POST } = await import('@/app/api/webhooks/whatsapp/[connectionId]/route');

    const res = await POST(requisicao(PAYLOAD), { params: Promise.resolve({ connectionId: CONN }) });

    // 200 aqui diria à uazapi "guardei" sobre uma mensagem que se perdeu.
    expect(res.status).toBe(500);
    expect(processInboundPayload).not.toHaveBeenCalled();
  });
});
