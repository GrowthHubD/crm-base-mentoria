/**
 * Worker: notificações — consome notificationQueue.
 *
 * Jobs:
 *   - 'api-failure' { details } — envia alerta WhatsApp pro admin
 */
import { Worker } from 'bullmq';
import { notificationQueue } from '@/lib/queue';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { notifyAPIFailure, type ApiFailureDetails } from '@/lib/notifications/api-failure';

export function startNotificationWorker() {
  const worker = new Worker(
    notificationQueue.name,
    async (job) => {
      switch (job.name) {
        case 'api-failure': {
          const { details } = job.data as { details: ApiFailureDetails };
          await notifyAPIFailure(details);
          return { ok: true };
        }
        default:
          logger.warn({ jobName: job.name }, '[worker:notification] job desconhecido');
          return { ok: false };
      }
    },
    {
      connection: getRedis()!,
      concurrency: 5,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobName: job?.name, err: err instanceof Error ? err.message : String(err) },
      '[worker:notification] falhou'
    );
  });

  return worker;
}
