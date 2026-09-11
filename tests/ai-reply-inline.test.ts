/**
 * Regressão do caminho inline da IA (regime sem Redis / Cloudflare).
 *
 * O bug que este teste tranca: `enqueueReplyForLead` chamava `aiQueue.add()`,
 * que sem Redis é um no-op silencioso. O webhook respondia 200, o log dizia
 * "IA enfileirada" e o cliente nunca recebia resposta — em produção, no molde
 * que é clonado pra cada cliente novo.
 *
 * O que precisa continuar verdadeiro:
 *   1. sem fila, alguém de fato chama `handleLeadMessage`;
 *   2. o debounce continua existindo — se a conversa andou durante a espera,
 *      esta invocação desiste (a mais recente responde por todas).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const handleLeadMessage = vi.fn(
  async (_leadId: string, _message: string) => ({ replied: true, transferred: false })
);
const byLead = vi.fn();

vi.mock('@/lib/queue', () => ({
  QUEUES_ENABLED: false,
  aiQueue: {
    add: vi.fn(async () => null),
    getJob: vi.fn(async () => null),
  },
}));

vi.mock('@/modules/messages/service', () => ({
  reads: { byLead: (...args: unknown[]) => byLead(...args) },
}));

vi.mock('@/modules/ai-agent/service', () => ({
  handleLeadMessage: (...args: unknown[]) => handleLeadMessage(...(args as [string, string])),
}));

import { enqueueReplyForLead, cancelPendingReplyForLead } from '@/modules/ai-agent/reply-queue';

describe('resposta da IA sem Redis', () => {
  beforeEach(() => {
    handleLeadMessage.mockClear();
    byLead.mockReset();
  });

  it('responde o lead mesmo sem fila nem worker', async () => {
    byLead.mockResolvedValue([{ id: 'msg-1' }]);

    await enqueueReplyForLead('lead-1', 'oi, tem vaga?', 0);

    expect(handleLeadMessage).toHaveBeenCalledWith('lead-1', 'oi, tem vaga?');
  });

  it('desiste se a conversa avançou durante a espera', async () => {
    // Primeira leitura arma o debounce; a segunda mostra outra mensagem —
    // pode ser o lead completando a frase ou um atendente humano assumindo.
    byLead
      .mockResolvedValueOnce([{ id: 'msg-1' }])
      .mockResolvedValueOnce([{ id: 'msg-2' }]);

    await enqueueReplyForLead('lead-2', 'quanto custa', 0);

    expect(handleLeadMessage).not.toHaveBeenCalled();
  });

  it('não finge ter cancelado um job que nunca existiu', async () => {
    await expect(cancelPendingReplyForLead('lead-3')).resolves.toBe(false);
  });
});
