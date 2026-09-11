/**
 * Worker: escalação automática de pipeline.
 *
 * Repeatable job a cada 1 minuto. Consome `escalation:tick` da escalationQueue
 * e roda `runEscalationPass`.
 *
 * Recovery: sempre que o servidor sobe, registramos o repeatable job (BullMQ
 * é idempotente em adds repetidos com mesmo nome).
 */
import { Worker } from 'bullmq';
import { escalationQueue } from '@/lib/queue';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { runEscalationPass } from '@/modules/pipeline/service';

export const ESCALATION_REPEAT_KEY = 'escalation:tick';

export async function ensureEscalationCron(): Promise<void> {
  // BullMQ remove duplicates de jobName quando passamos repeat config
  await escalationQueue.add(
    ESCALATION_REPEAT_KEY,
    {},
    {
      repeat: { every: 60_000 }, // 1 minuto
      jobId: ESCALATION_REPEAT_KEY,
      removeOnComplete: 100,
      removeOnFail: 50,
    }
  );
  logger.info('[worker:escalation] cron registrado (every 60s)');
}

export function startEscalationWorker() {
  const worker = new Worker(
    escalationQueue.name,
    async () => {
      const stats = await runEscalationPass();
      return stats;
    },
    {
      connection: getRedis()!,
      concurrency: 1, // single worker pra evitar race em update de status
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err instanceof Error ? err.message : String(err) },
      '[worker:escalation] job falhou'
    );
  });

  return worker;
}
