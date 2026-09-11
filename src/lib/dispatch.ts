/**
 * Ponte entre "enfileirar" e "fazer agora".
 *
 * O produto roda em dois regimes e as rotas não deveriam saber em qual estão:
 *
 *   Com Redis (Node/VPS)   O job vai pra fila BullMQ e um worker consome, com
 *                          rate-limit e retry com backoff.
 *   Sem Redis (Cloudflare) Não há fila nem processo consumidor. O trabalho é
 *                          executado na própria requisição.
 *
 * A regra que isto protege: **nunca responder OK sem que o trabalho tenha sido
 * enfileirado OU executado**. O caminho antigo tentava `queue.add()` e caía
 * no inline só se a chamada lançasse — o que deixou de acontecer quando a fila
 * virou um no-op silencioso, e mensagens passaram a sumir com HTTP 200.
 */
import { sendQueue, QUEUES_ENABLED } from './queue';
import { logger } from './logger';
import type { OutboundJobData } from '@/workers/outbound-message';

/**
 * Entrega uma mensagem outbound.
 *
 * Com fila: enfileira com `jobId` estável (idempotência) e devolve na hora.
 * Sem fila: envia inline e só então resolve — a rota espera o envio de fato.
 *
 * O `delay` só é honrado no modo fila. Inline, um `setTimeout` de 8s dentro de
 * uma requisição HTTP seria pago pelo usuário na tela; a ordem entre balões
 * consecutivos é mantida por serem awaited em sequência pelo chamador.
 */
export async function dispatchOutbound(
  data: OutboundJobData,
  opts: { jobId: string; delayMs?: number }
): Promise<{ mode: 'queued' | 'inline'; ok: boolean }> {
  if (QUEUES_ENABLED) {
    await sendQueue.add('outbound-send', data, {
      jobId: opts.jobId,
      delay: opts.delayMs,
      removeOnComplete: 200,
      removeOnFail: 100,
    });
    return { mode: 'queued', ok: true };
  }

  const { processOutboundJob } = await import('@/workers/outbound-message');
  const result = await processOutboundJob(data);
  if (!result.ok) {
    logger.warn(
      { messageId: data.messageId, reason: result.reason },
      '[dispatch] envio inline falhou'
    );
  }
  return { mode: 'inline', ok: result.ok };
}
