/**
 * Service layer do scheduler — mensagens agendadas pelo atendente
 * (popup "agendar retorno") + auto-cancelamento quando o lead responde.
 *
 * Workflow:
 *   1. Atendente clica "agendar para X" → criamos `scheduled_messages` + job BullMQ delayed
 *   2. Worker dispara no horário → envia via outbound + marca status='sent'
 *   3. Lead responde antes → cancelamos pendentes daquele lead (cancelled_reason)
 */
import { db } from '@/lib/db/client';
import { scheduledMessages } from '@/lib/db/schema/scheduled-messages';
import { leads } from '@/lib/db/schema/leads';
import { connections } from '@/lib/db/schema/connections';
import { eq, and, lt, desc } from 'drizzle-orm';
import { schedulerQueue } from '@/lib/queue';
import { logger } from '@/lib/logger';
import { upsertLeadFromContact } from '@/modules/leads/service';
import type { LeadChannel } from '@/modules/leads/types';

export interface ScheduleMessageInput {
  leadId: string;
  createdById: string;
  body: string;
  mediaUrl?: string;
  scheduledAt: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Cria mensagem agendada + job BullMQ delayed. O bullJobId é gravado
 * pra permitir cancelamento posterior.
 */
export async function scheduleMessage(input: ScheduleMessageInput): Promise<{ id: string; bullJobId: string }> {
  const delay = Math.max(0, input.scheduledAt.getTime() - Date.now());

  const [created] = await db
    .insert(scheduledMessages)
    .values({
      leadId: input.leadId,
      createdById: input.createdById,
      body: input.body,
      mediaUrl: input.mediaUrl,
      scheduledAt: input.scheduledAt,
      metadata: input.metadata,
      status: 'pending',
    })
    .returning({ id: scheduledMessages.id });

  // Sem Redis, `add()` é no-op e devolve `null` (contrato em lib/queue.ts) —
  // por isso `job?.id`. Não é perda: a linha em `scheduled_messages` É o
  // agendamento, e o /api/cron/tick varre o que venceu. O job do BullMQ
  // sempre foi só o despertador. Antes, o `job.id` cru estourava aqui e o
  // agendamento respondia HTTP 500 no Cloudflare.
  const job = await schedulerQueue.add(
    'scheduled-message',
    { scheduledMessageId: created.id },
    { delay, jobId: `sm-${created.id}` }
  );

  await db
    .update(scheduledMessages)
    .set({ bullJobId: job?.id ?? `sm-${created.id}` })
    .where(eq(scheduledMessages.id, created.id));

  return { id: created.id, bullJobId: job?.id ?? `sm-${created.id}` };
}

/**
 * Cancela todas as agendadas pendentes de um lead. Chamado pelo handler de
 * mensagem inbound — quando o lead retoma a conversa, follow-ups agendados
 * pelo atendente perdem propósito.
 */
export async function cancelPendingByLead(
  leadId: string,
  reason: string = 'lead_resumed_conversation'
): Promise<number> {
  const pendings = await db
    .select({ id: scheduledMessages.id, bullJobId: scheduledMessages.bullJobId })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.leadId, leadId), eq(scheduledMessages.status, 'pending')));

  let cancelled = 0;
  for (const p of pendings) {
    if (p.bullJobId) {
      try {
        const job = await schedulerQueue.getJob(p.bullJobId);
        if (job) await job.remove();
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, jobId: p.bullJobId },
          '[scheduler] falha removendo job BullMQ'
        );
      }
    }
    await db
      .update(scheduledMessages)
      .set({ status: 'cancelled', metadata: { cancelled_reason: reason } })
      .where(eq(scheduledMessages.id, p.id));
    cancelled++;
  }

  if (cancelled > 0) {
    logger.info({ leadId, cancelled, reason }, '[scheduler] agendadas canceladas');
  }
  return cancelled;
}

/**
 * Marca scheduled como 'sent' após envio via outbound worker.
 */
export async function markSent(id: string): Promise<void> {
  await db
    .update(scheduledMessages)
    .set({ status: 'sent', sentAt: new Date() })
    .where(eq(scheduledMessages.id, id));
}

export async function markFailed(id: string, error: string): Promise<void> {
  await db
    .update(scheduledMessages)
    .set({ status: 'failed', metadata: { error } })
    .where(eq(scheduledMessages.id, id));
}

export async function getById(id: string) {
  const [row] = await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id)).limit(1);
  return row;
}

/**
 * Lista pending vencidas (scheduledAt < now). Útil pra recovery após restart
 * do servidor — workers podem perder jobs delayed se Redis cair.
 */
export async function listOverduePending(): Promise<Array<{ id: string; leadId: string; body: string; scheduledAt: Date }>> {
  const rows = await db
    .select({
      id: scheduledMessages.id,
      leadId: scheduledMessages.leadId,
      body: scheduledMessages.body,
      scheduledAt: scheduledMessages.scheduledAt,
    })
    .from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, 'pending'), lt(scheduledMessages.scheduledAt, new Date())))
    .limit(500);
  return rows;
}

/**
 * Edita body, scheduledAt, mediaUrl ou metadata de um agendamento pendente.
 * Se `scheduledAt` mudar, remove o job BullMQ antigo e enfileira um novo
 * com o delay correto.
 */
export async function editScheduled(
  id: string,
  patch: { body?: string; scheduledAt?: Date; mediaUrl?: string | null; internalNote?: string | null }
): Promise<void> {
  const current = await getById(id);
  if (!current) throw new Error(`scheduled ${id} não existe`);
  if (current.status !== 'pending') {
    throw new Error(`não pode editar — status atual: ${current.status}`);
  }

  const update: Record<string, unknown> = {};
  if (patch.body !== undefined) update.body = patch.body;
  if (patch.mediaUrl !== undefined) update.mediaUrl = patch.mediaUrl;
  if (patch.internalNote !== undefined) {
    const meta = (current.metadata ?? {}) as Record<string, unknown>;
    update.metadata = { ...meta, internalNote: patch.internalNote };
  }

  // Reagendar: remove job antigo, enfileira um novo
  if (patch.scheduledAt && patch.scheduledAt.getTime() !== current.scheduledAt.getTime()) {
    if (current.bullJobId) {
      try {
        const job = await schedulerQueue.getJob(current.bullJobId);
        if (job) await job.remove();
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, jobId: current.bullJobId },
          '[scheduler] falha removendo job antigo no edit'
        );
      }
    }
    const delay = Math.max(0, patch.scheduledAt.getTime() - Date.now());
    const job = await schedulerQueue.add(
      'scheduled-message',
      { scheduledMessageId: id },
      { delay, jobId: `sm-${id}-${Date.now()}` }
    );
    update.scheduledAt = patch.scheduledAt;
    update.bullJobId = job?.id ?? null;
  }

  if (Object.keys(update).length > 0) {
    await db.update(scheduledMessages).set(update).where(eq(scheduledMessages.id, id));
  }
}

/**
 * Cancela um agendamento específico pelo id (UI Cancelar). Remove job BullMQ
 * e marca status='cancelled'.
 */
export async function cancelById(id: string, reason: string = 'cancelled_by_user'): Promise<void> {
  const current = await getById(id);
  if (!current) throw new Error(`scheduled ${id} não existe`);
  if (current.status !== 'pending') {
    return; // idempotente
  }

  if (current.bullJobId) {
    try {
      const job = await schedulerQueue.getJob(current.bullJobId);
      if (job) await job.remove();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, jobId: current.bullJobId },
        '[scheduler] falha removendo job no cancel'
      );
    }
  }
  const meta = (current.metadata ?? {}) as Record<string, unknown>;
  await db
    .update(scheduledMessages)
    .set({ status: 'cancelled', metadata: { ...meta, cancelled_reason: reason } })
    .where(eq(scheduledMessages.id, id));
}

/**
 * "Enviar agora" — cancela o delay do job, dispara imediatamente.
 * Implementação: remove job BullMQ delayed e enfileira um novo com delay=0.
 */
export async function sendNow(id: string): Promise<void> {
  const current = await getById(id);
  if (!current) throw new Error(`scheduled ${id} não existe`);
  if (current.status !== 'pending') {
    throw new Error(`não pode enviar agora — status atual: ${current.status}`);
  }

  if (current.bullJobId) {
    try {
      const job = await schedulerQueue.getJob(current.bullJobId);
      if (job) await job.remove();
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, jobId: current.bullJobId },
        '[scheduler] falha removendo job no sendNow'
      );
    }
  }
  const job = await schedulerQueue.add(
    'scheduled-message',
    { scheduledMessageId: id },
    { delay: 0, jobId: `sm-${id}-now-${Date.now()}` }
  );
  await db
    .update(scheduledMessages)
    .set({ scheduledAt: new Date(), bullJobId: job?.id ?? null })
    .where(eq(scheduledMessages.id, id));
}

/**
 * Resolve a connection ativa do tipo `channel`. Preferimos `connected`; cai
 * pra qualquer outra como último recurso. Retorna null se não há nenhuma
 * connection daquele canal — caller decide se aborta.
 */
async function pickConnectionForChannel(
  channel: LeadChannel
): Promise<string | null> {
  // Por enquanto só whatsapp tem adapter pro envio; outros canais nem chegam aqui.
  if (channel !== 'whatsapp') return null;

  const rows = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(eq(connections.type, channel))
    .orderBy(desc(connections.createdAt));

  if (rows.length === 0) return null;
  const connected = rows.find(r => r.status === 'connected');
  return (connected ?? rows[0]).id;
}

/**
 * Resolve lead pra um agendamento manual: se já existe lead com aquele canal +
 * contato, usa-o. Senão cria. Garante que o lead tem `connectionId` apontando
 * pra uma instância — sem isso o outbound worker não consegue enviar
 * (getAdapterForLead joga "Lead sem connection vinculada").
 *
 * Lança erro se ainda não há nenhuma connection WhatsApp.
 */
export async function findOrCreateLeadForSchedule(args: {
  channel: LeadChannel;
  contact: string;
  name?: string;
}): Promise<{ leadId: string; isNew: boolean }> {
  const normalized = args.channel === 'whatsapp'
    ? args.contact.replace(/\D/g, '')
    : args.contact.replace(/^@/, '').trim();

  const connectionId = await pickConnectionForChannel(args.channel);
  if (!connectionId && args.channel === 'whatsapp') {
    throw new Error('sem conexão WhatsApp configurada — abra /conexoes antes de agendar');
  }

  // Se atendente não passou nome E é whatsapp, tenta pegar pushName na uazapi
  // antes de gravar — assim o card nasce já identificado.
  let resolvedName = args.name?.trim();
  let resolvedAvatar: string | null | undefined = undefined;
  if (!resolvedName && args.channel === 'whatsapp' && connectionId) {
    try {
      const { fetchContactNameForLead } = await import('@/modules/channels/service');
      const info = await fetchContactNameForLead(connectionId, normalized);
      if (info?.name) resolvedName = info.name;
      if (info?.avatarUrl) resolvedAvatar = info.avatarUrl;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, phone: normalized },
        '[scheduler] lookup de pushName falhou (segue sem)'
      );
    }
  }

  const result = await upsertLeadFromContact({
    externalContactId: normalized,
    channel: args.channel,
    connectionId: connectionId ?? undefined,
    name: resolvedName,
    avatarUrl: resolvedAvatar ?? undefined,
    phone: args.channel === 'whatsapp' ? normalized : undefined,
  });

  // Se lead já existia sem connection, gruda agora pra desbloquear envios.
  if (!result.isNew && connectionId && !result.lead.connectionId) {
    await db.update(leads).set({ connectionId }).where(eq(leads.id, result.lead.id));
    logger.info(
      { leadId: result.lead.id, connectionId },
      '[scheduler] lead órfão recebeu connection'
    );
  }

  return { leadId: result.lead.id, isNew: result.isNew };
}

/**
 * Auto-fix de leads órfãos no momento do dispatch: se um scheduled-message
 * está prestes a sair mas o lead não tem connection, pega a primeira ativa do
 * canal. Sem isso, o outbound worker falha sempre.
 */
export async function ensureLeadHasConnection(leadId: string): Promise<boolean> {
  const [lead] = await db
    .select({ id: leads.id, channel: leads.channel, connectionId: leads.connectionId })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return false;
  if (lead.connectionId) return true;
  const connectionId = await pickConnectionForChannel(lead.channel as LeadChannel);
  if (!connectionId) return false;
  await db.update(leads).set({ connectionId }).where(eq(leads.id, leadId));
  logger.info({ leadId, connectionId }, '[scheduler] auto-fix: connection vinculada ao lead órfão');
  return true;
}
