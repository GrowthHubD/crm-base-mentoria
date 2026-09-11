/**
 * Engine de automações — adaptado simplificado do crm_parceria_lagos.
 *
 * Conceitos:
 *   - automation: definição com trigger + steps
 *   - automation_step: passos sequenciais (send_text, send_media, wait, etc)
 *   - automation_log: 1 row por (lead × step × execução). Idempotente.
 *
 * Triggers suportados nesta versão:
 *   - 'first_message' → disparado quando lead novo manda 1ª mensagem
 *   - 'lead_inactive' → disparado pela escalação quando lead fica inativo
 *
 * Não traz dessa versão:
 *   - stage_enter, tag_added, manual (futuro, schema já está pronto)
 *   - Multi-tenancy
 */
import { db } from '@/lib/db/client';
import { automations, automationSteps, automationLogs } from '@/lib/db/schema/automations';
import { eq, and, lte, gte, inArray } from 'drizzle-orm';
import { schedulerQueue } from '@/lib/queue';
import { logger } from '@/lib/logger';
import { reads as leadReads } from '@/modules/leads/service';
import { recordPendingOutbound } from '@/modules/messages/service';
import { getAgentName } from '@/modules/ai-agent/queries';
import type { MessageType } from '@/modules/messages/types';
import type { OutboundJobData } from '@/workers/outbound-message';

export type AutomationTrigger = 'first_message' | 'lead_inactive' | 'stage_enter' | 'tag_added' | 'manual';
export type AutomationStepType =
  | 'send_text'
  | 'send_media'
  | 'wait'
  | 'set_status'
  | 'add_tag'
  | 'notify_human';

export interface StepConfig {
  // send_text / send_media
  body?: string;
  caption?: string;
  url?: string;
  mediaType?: 'image' | 'video' | 'audio' | 'document';
  // wait
  minutes?: number;
  hours?: number;
  days?: number;
  // set_status
  status?: 'new' | 'priority' | 'urgency' | 'attending' | 'converted' | 'lost';
  // add_tag
  tag?: string;
  // notify_human
  notifyMessage?: string;
  // delay opcional pré-step
  delayMinutes?: number;
}

function calcDelayMs(cfg: StepConfig): number {
  const mins = (cfg.delayMinutes ?? 0) + (cfg.minutes ?? 0) + (cfg.hours ?? 0) * 60 + (cfg.days ?? 0) * 24 * 60;
  return Math.max(0, mins * 60_000);
}

function renderTemplate(template: string | undefined, vars: Record<string, string | null | undefined>): string {
  if (!template) return '';
  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const v = vars[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

/**
 * Dispara todas as automations habilitadas pra um trigger específico em um lead.
 * Idempotente: se já existir log com (automationId, leadId) recente, pula.
 */
export async function fireTrigger(
  trigger: AutomationTrigger,
  leadId: string,
  context: Record<string, unknown> = {}
): Promise<{ fired: number }> {
  const lead = await leadReads.getById(leadId);
  if (!lead) return { fired: 0 };
  if (lead.status === 'converted' || lead.status === 'lost') return { fired: 0 };

  const matchingAutomations = await db
    .select()
    .from(automations)
    .where(and(eq(automations.trigger, trigger), eq(automations.enabled, true)));

  if (matchingAutomations.length === 0) return { fired: 0 };

  let fired = 0;

  for (const auto of matchingAutomations) {
    // Idempotência: evita disparar mesma automation 2x pro mesmo lead em 24h.
    // Para 'first_message', a janela é maior (15 dias) — não queremos welcome
    // toda vez que um lead engaja de novo.
    const windowMs = trigger === 'first_message' ? 15 * 24 * 60 * 60_000 : 24 * 60 * 60_000;
    const since = new Date(Date.now() - windowMs);
    const [recent] = await db
      .select({ id: automationLogs.id })
      .from(automationLogs)
      .where(
        and(
          eq(automationLogs.automationId, auto.id),
          eq(automationLogs.leadId, leadId),
          gte(automationLogs.createdAt, since)
        )
      )
      .limit(1);

    if (recent) {
      logger.debug(
        { automationId: auto.id, leadId, trigger },
        '[automations] já disparada na janela atual, pulando'
      );
      continue;
    }

    const steps = await db
      .select()
      .from(automationSteps)
      .where(eq(automationSteps.automationId, auto.id))
      .orderBy(automationSteps.sequence);

    if (steps.length === 0) continue;

    let cumulativeDelay = 0;
    for (const step of steps) {
      const cfg = (step.config ?? {}) as StepConfig;
      cumulativeDelay += calcDelayMs(cfg);
      const scheduledAt = new Date(Date.now() + cumulativeDelay);

      const [logRow] = await db
        .insert(automationLogs)
        .values({
          automationId: auto.id,
          stepId: step.id,
          leadId,
          status: 'pending',
          scheduledAt,
          metadata: { trigger, context, sequence: step.sequence },
        })
        .returning({ id: automationLogs.id });

      const job = await schedulerQueue.add(
        'automation-step',
        { logId: logRow.id },
        { delay: cumulativeDelay, jobId: `auto-${logRow.id}` }
      );

      await db
        .update(automationLogs)
        .set({ bullJobId: job?.id ?? `auto-${logRow.id}` })
        .where(eq(automationLogs.id, logRow.id));
    }

    fired++;
  }

  if (fired > 0) {
    logger.info({ trigger, leadId, fired }, '[automations] disparadas');
  }

  return { fired };
}

/**
 * Executa um step de automation. Chamado pelo worker ao receber job
 * `automation-step`. Atomic claim: só executa se status ainda for 'pending'.
 */
export async function executeStepFromLog(logId: string): Promise<{ ok: boolean; reason?: string }> {
  // Claim atômico: pending → running
  const [claimed] = await db
    .update(automationLogs)
    .set({ status: 'running' })
    .where(and(eq(automationLogs.id, logId), eq(automationLogs.status, 'pending')))
    .returning({ id: automationLogs.id, leadId: automationLogs.leadId, stepId: automationLogs.stepId, automationId: automationLogs.automationId });

  if (!claimed) {
    return { ok: false, reason: 'log já não está pending' };
  }

  const lead = await leadReads.getById(claimed.leadId);
  if (!lead) {
    await markLogFailed(logId, 'lead não existe');
    return { ok: false, reason: 'lead não existe' };
  }
  if (lead.status === 'converted' || lead.status === 'lost') {
    await markLogSkipped(logId, `lead em status ${lead.status}`);
    return { ok: false, reason: `lead status ${lead.status}` };
  }

  if (!claimed.stepId) {
    await markLogFailed(logId, 'stepId nulo');
    return { ok: false, reason: 'stepId nulo' };
  }

  const [step] = await db
    .select()
    .from(automationSteps)
    .where(eq(automationSteps.id, claimed.stepId))
    .limit(1);

  if (!step) {
    await markLogFailed(logId, 'step removido');
    return { ok: false };
  }

  const cfg = (step.config ?? {}) as StepConfig;
  const stepType = step.type as AutomationStepType;

  try {
    switch (stepType) {
      case 'send_text':
      case 'send_media': {
        const body = renderTemplate(cfg.body ?? cfg.caption, {
          name: lead.name,
          phone: lead.phone,
        });
        // O tipo aqui e o que o outbound sabe enviar — nao MessageType inteiro,
        // que inclui 'sticker' (existe no historico, mas nunca foi enviavel pelo
        // adapter). Antes isto passava batido porque a fila aceitava qualquer
        // payload.
        const type: OutboundJobData['type'] = stepType === 'send_media'
          ? ((cfg.mediaType ?? 'image') as OutboundJobData['type'])
          : 'text';
        const aiSenderName = await getAgentName();
        const msg = await recordPendingOutbound({
          leadId: lead.id,
          type,
          sender: 'ai',
          senderName: aiSenderName,
          body,
          mediaUrl: cfg.url ?? null,
          metadata: { source: 'automation', automationId: claimed.automationId, logId },
        });
        // Envio real: enfileira onde ha fila, envia inline onde nao ha.
        const { dispatchOutbound } = await import('@/lib/dispatch');
        await dispatchOutbound(
          {
            messageId: msg.id,
            leadId: lead.id,
            type,
            body,
            mediaUrl: cfg.url ?? null,
            mediaCaption: cfg.caption ?? null,
          },
          { jobId: `out-${msg.id}` }
        );
        break;
      }
      case 'wait': {
        // Wait não faz nada — o delay já foi aplicado no agendamento.
        break;
      }
      case 'set_status': {
        if (cfg.status) {
          const { changeStatus } = await import('@/modules/leads/service');
          await changeStatus(lead.id, cfg.status);
        }
        break;
      }
      case 'add_tag': {
        if (cfg.tag) {
          const tags = (lead.metadata?.tags as string[] | undefined) ?? [];
          if (!tags.includes(cfg.tag)) {
            const { patchLead } = await import('@/modules/leads/service');
            await patchLead(lead.id, {
              metadata: { ...(lead.metadata ?? {}), tags: [...tags, cfg.tag] },
            });
          }
        }
        break;
      }
      case 'notify_human': {
        const { emitToEmpresa } = await import('@/lib/socket');
        emitToEmpresa('crm', 'lead:notify', {
          leadId: lead.id,
          message: cfg.notifyMessage ?? 'Atenção: lead requer ação humana',
        });
        break;
      }
    }

    await markLogCompleted(logId);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markLogFailed(logId, msg);
    return { ok: false, reason: msg };
  }
}

async function markLogCompleted(logId: string) {
  await db
    .update(automationLogs)
    .set({ status: 'completed', executedAt: new Date() })
    .where(eq(automationLogs.id, logId));
}
async function markLogFailed(logId: string, error: string) {
  await db
    .update(automationLogs)
    .set({ status: 'failed', error, executedAt: new Date() })
    .where(eq(automationLogs.id, logId));
}
async function markLogSkipped(logId: string, reason: string) {
  await db
    .update(automationLogs)
    .set({ status: 'skipped', error: reason, executedAt: new Date() })
    .where(eq(automationLogs.id, logId));
}

/**
 * Recovery de logs órfãos (servidor reiniciou com jobs no Redis perdidos).
 * Chama o worker via re-enfileiramento.
 */
export async function recoverOverdue(): Promise<{ recovered: number }> {
  const overdue = await db
    .select({ id: automationLogs.id, scheduledAt: automationLogs.scheduledAt })
    .from(automationLogs)
    .where(and(eq(automationLogs.status, 'pending'), lte(automationLogs.scheduledAt, new Date())))
    .limit(200);

  for (const log of overdue) {
    await schedulerQueue.add('automation-step', { logId: log.id }, { jobId: `auto-${log.id}-recover` });
  }
  return { recovered: overdue.length };
}

/**
 * Cancela TODOS os logs pending de um lead (usado quando lead respondeu ou
 * foi convertido/perdido). Útil pra evitar follow-ups irrelevantes.
 */
export async function cancelPendingByLead(leadId: string, reason: string = 'lead_responded'): Promise<number> {
  const pendings = await db
    .select({ id: automationLogs.id, bullJobId: automationLogs.bullJobId })
    .from(automationLogs)
    .where(and(eq(automationLogs.leadId, leadId), eq(automationLogs.status, 'pending')));

  if (pendings.length === 0) return 0;

  for (const p of pendings) {
    if (p.bullJobId) {
      try {
        const job = await schedulerQueue.getJob(p.bullJobId);
        if (job) await job.remove();
      } catch {
        // best-effort
      }
    }
  }

  const ids = pendings.map(p => p.id);
  await db
    .update(automationLogs)
    .set({ status: 'cancelled', error: reason, executedAt: new Date() })
    .where(inArray(automationLogs.id, ids));

  return pendings.length;
}

/**
 * Executa inline os steps de automation vencidos.
 *
 * Irmã de `recoverOverdue`: aquela re-enfileira no BullMQ (Node), esta executa
 * na hora, porque no Cloudflare quem chama é o Cron Trigger e não existe fila
 * nem worker pra consumir. O teto por passada evita estourar o tempo de uma
 * invocação; o que sobrar continua vencido e sai no tick seguinte.
 */
export async function runOverdueSteps(limit = 25): Promise<{ ran: number; pending: number }> {
  const overdue = await db
    .select({ id: automationLogs.id })
    .from(automationLogs)
    .where(and(eq(automationLogs.status, 'pending'), lte(automationLogs.scheduledAt, new Date())))
    .limit(limit + 1);

  const batch = overdue.slice(0, limit);
  for (const log of batch) {
    try {
      await executeStepFromLog(log.id);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err, logId: log.id },
        '[automations] step vencido falhou'
      );
    }
  }
  return { ran: batch.length, pending: overdue.length > limit ? overdue.length - limit : 0 };
}
