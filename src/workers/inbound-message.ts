/**
 * Worker: processa mensagens INBOUND (WhatsApp/uazapi) via BullMQ.
 *
 * O handler também é chamável diretamente pelo webhook em fallback inline
 * (quando Redis está indisponível em dev).
 */
import { Worker } from 'bullmq';
import { messageQueue } from '@/lib/queue';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { processInboundPayload } from '@/modules/channels/whatsapp/process-inbound';
import type { UazapiV2WebhookPayload } from '@/modules/messages/types';

interface InboundJobData {
  payload: UazapiV2WebhookPayload | Record<string, unknown>;
  /** Quando a msg chegou pela rota dinâmica /api/webhooks/whatsapp/[connectionId]
   *  já vem resolvida. */
  connectionId?: string;
}

export function startInboundMessageWorker() {
  const worker = new Worker(
    messageQueue.name,
    async (job) => {
      const data = job.data as InboundJobData;
      return processInboundPayload(data.payload, { connectionIdOverride: data.connectionId });
    },
    { connection: getRedis()!, concurrency: 5 }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err instanceof Error ? err.message : String(err) },
      '[worker:inbound] job falhou'
    );
  });

  return worker;
}
