/**
 * Boot de todos os workers BullMQ.
 *
 * Chamado por server.ts depois do app.prepare(). Cada worker é independente
 * (própria conexão Redis); falha de boot de um worker não derruba os outros.
 *
 * Em dev (tsx watch), o restart hot-reload re-executa este boot automaticamente.
 * BullMQ dedupe jobs repeatable (cron) por jobId, então é seguro re-rodar.
 */
import { logger } from '@/lib/logger';
import { QUEUES_ENABLED } from '@/lib/queue';
import { startInboundMessageWorker } from './inbound-message';
import { startOutboundMessageWorker } from './outbound-message';
import { startEscalationWorker, ensureEscalationCron } from './escalation';
import { startSchedulerWorker } from './scheduler';
import { startAiAgentWorker } from './ai-agent';
import { startNotificationWorker } from './notification';
import type { Worker } from 'bullmq';

export interface WorkersBundle {
  inbound: Worker;
  outbound: Worker;
  escalation: Worker;
  scheduler: Worker;
  aiAgent: Worker;
  notification: Worker;
}

let _workers: WorkersBundle | null = null;

export async function startWorkers(): Promise<WorkersBundle | null> {
  if (_workers) return _workers;

  // Sem Redis não há fila pra consumir: o app roda em modo inline (cada rota
  // executa o trabalho na hora). Tentar subir worker aqui só produziria erro
  // de conexão em loop no log.
  if (!QUEUES_ENABLED) {
    logger.info('[workers] REDIS_URL ausente — modo inline, nenhum worker BullMQ iniciado');
    return null;
  }

  logger.info('[workers] boot iniciado');

  const inbound = startInboundMessageWorker();
  const outbound = startOutboundMessageWorker();
  const escalation = startEscalationWorker();
  const scheduler = startSchedulerWorker();
  const aiAgent = startAiAgentWorker();
  const notification = startNotificationWorker();

  // Registra repeatable jobs (cron) — falhas individuais não bloqueiam boot
  try { await ensureEscalationCron(); }
  catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[workers] cron escalação');
  }

  _workers = { inbound, outbound, escalation, scheduler, aiAgent, notification };
  logger.info('[workers] todos workers iniciados');
  return _workers;
}

export async function stopWorkers(): Promise<void> {
  if (!_workers) return;
  await Promise.all([
    _workers.inbound.close(),
    _workers.outbound.close(),
    _workers.escalation.close(),
    _workers.scheduler.close(),
    _workers.aiAgent.close(),
    _workers.notification.close(),
  ]);
  _workers = null;
  logger.info('[workers] todos workers encerrados');
}
