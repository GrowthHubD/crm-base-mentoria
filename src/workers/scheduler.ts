/**
 * Worker: scheduler queue — trata 3 tipos de job:
 *   - 'automation-step': executa step de automation
 *   - 'scheduled-message': dispara mensagem agendada pelo atendente
 *   - 'followup-message': dispara mensagem de follow-up automático
 *
 * A regra de cada disparo vive em `modules/scheduler/runner.ts`, porque o
 * Cloudflare não tem worker: lá o mesmo trabalho é acordado pelo Cron Trigger
 * em `/api/cron/tick`. Este arquivo é só o adaptador BullMQ.
 */
import { Worker } from 'bullmq';
import { schedulerQueue } from '@/lib/queue';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { executeStepFromLog } from '@/modules/automations/service';
import { runScheduledMessage, runFollowup } from '@/modules/scheduler/runner';

export function startSchedulerWorker() {
  const worker = new Worker(
    schedulerQueue.name,
    async (job) => {
      switch (job.name) {
        case 'automation-step': {
          const { logId } = job.data as { logId: string };
          return await executeStepFromLog(logId);
        }
        case 'scheduled-message': {
          const { scheduledMessageId } = job.data as { scheduledMessageId: string };
          return await runScheduledMessage(scheduledMessageId);
        }
        case 'followup-message': {
          const { followupId } = job.data as { followupId: string };
          return await runFollowup(followupId);
        }
        default:
          logger.warn({ jobName: job.name }, '[worker:scheduler] job name desconhecido');
          return { ok: false, reason: 'unknown_job_name' };
      }
    },
    {
      connection: getRedis()!,
      concurrency: 3,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobName: job?.name, jobId: job?.id, err: err instanceof Error ? err.message : String(err) },
      '[worker:scheduler] job falhou'
    );
  });

  return worker;
}
