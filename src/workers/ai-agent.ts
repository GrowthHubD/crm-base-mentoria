/**
 * Worker: agent IA — processa job 'reply-to-lead' da aiQueue.
 *
 * Encadeia: ai-agent.service.handleLeadMessage(leadId, message) que já cuida
 * de RAG, prompt building, Gemini call, persistência outbound e enfileiramento.
 *
 * Rate-limit (PRD): 10 calls/min — configurado em queue.ts.
 */
import { Worker } from 'bullmq';
import { aiQueue } from '@/lib/queue';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { handleLeadMessage } from '@/modules/ai-agent/service';
import { notifyAPIFailure } from '@/lib/notifications/api-failure';

interface AiJobData {
  leadId: string;
  message: string;
}

export function startAiAgentWorker() {
  const worker = new Worker(
    aiQueue.name,
    async (job) => {
      const { leadId, message } = job.data as AiJobData;
      try {
        return await handleLeadMessage(leadId, message);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ leadId, err: errMsg }, '[worker:ai] handleLeadMessage falhou');
        notifyAPIFailure({
          service: 'ai',
          operation: 'handleLeadMessage',
          errorMessage: errMsg,
          leadId,
        }).catch(() => {});
        throw err;
      }
    },
    {
      connection: getRedis()!,
      concurrency: 2,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err instanceof Error ? err.message : String(err) },
      '[worker:ai] job falhou'
    );
  });

  return worker;
}
