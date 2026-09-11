/**
 * Service layer do módulo leads — orquestra queries+mutations e expõe
 * regras de negócio. Workers e API routes consomem APENAS este arquivo.
 *
 * Regras:
 *   - Transição de status: NEVER permitir converted → outro status
 *   - lastMessageAt é o relógio de escalação (reset quando lead manda msg)
 *   - aiAgentActive é flag controlada por automation/admin
 *
 * Single-tenant: todos os eventos Socket.IO são emitidos na sala única `CRM_ROOM`.
 */
import {
  getLeadById,
  findLeadByContact,
  listLeads,
  listLeadsToEscalate,
  countLeadsByStatus,
  type ListLeadsFilter,
} from './queries';
import {
  createLead,
  upsertLead,
  updateLead,
  touchLastMessage,
  escalateLead,
  setLeadStatus,
  reopenConvertedToAttending,
} from './mutations';
import type { Lead, LeadStatus, CreateLeadInput, UpdateLeadInput } from './types';
import { logger } from '@/lib/logger';
import { emitToEmpresa } from '@/lib/socket';

/** Single-tenant: existe uma única sala Socket.IO pra todo o CRM. */
const CRM_ROOM = 'crm';

const TERMINAL_STATUSES = new Set<LeadStatus>(['converted', 'lost']);

/**
 * Transições manuais (via patchLead/changeStatus) são LIVRES — o atendente pode
 * mover qualquer lead pra qualquer status. Escalações automáticas (via
 * `escalate`) seguem suas próprias regras (forward-only).
 *
 * `convertedAt` é zerado automaticamente em updateLead quando o status sair
 * de `converted` (ver mutations.ts).
 */
export function allowedManualTargets(from: LeadStatus): LeadStatus[] {
  const all: LeadStatus[] = ['new', 'priority', 'urgency', 'attending', 'converted', 'lost'];
  return all.filter((s) => s !== from);
}

export class LeadServiceError extends Error {
  constructor(public code: 'NOT_FOUND' | 'TERMINAL' | 'INVALID_TRANSITION', message: string) {
    super(message);
    this.name = 'LeadServiceError';
  }
}

export const reads = {
  getById: getLeadById,
  findByContact: findLeadByContact,
  list: listLeads,
  listToEscalate: listLeadsToEscalate,
  countByStatus: countLeadsByStatus,
};

export async function createLeadFromContact(input: CreateLeadInput): Promise<Lead> {
  const { id } = await createLead(input);
  const lead = await getLeadById(id);
  if (!lead) throw new LeadServiceError('NOT_FOUND', `Lead ${id} sumiu após create`);
  emitToEmpresa(CRM_ROOM, 'lead:created', { lead });
  return lead;
}

export async function upsertLeadFromContact(input: CreateLeadInput): Promise<{ lead: Lead; isNew: boolean }> {
  const { id, isNew } = await upsertLead(input);
  const lead = await getLeadById(id);
  if (!lead) throw new LeadServiceError('NOT_FOUND', `Lead ${id} sumiu após upsert`);
  emitToEmpresa(CRM_ROOM, isNew ? 'lead:created' : 'lead:updated', { lead });
  return { lead, isNew };
}

/**
 * Hard delete do lead — irreversível. Apaga messages, scheduled, followups,
 * payments, attendance_log, automation_logs por CASCADE (FKs ON DELETE CASCADE).
 *
 * Antes do delete cancelamos jobs pendentes no BullMQ (follow-up e scheduled)
 * — sem isso, o worker dispararia jobs órfãos e logaria erros.
 *
 * `deletedByUserId`: quando humano clica Excluir no LeadModal, o tempo de
 * atendimento é gravado no ranking via attendant_close_log. Sem ele (caso raro
 * de delete programático), só registra como anônimo.
 *
 * Uso esperado: admin removendo leads de teste, spam, ou erros de cadastro.
 * Pra "sair do pipeline mantendo histórico", use status='lost'.
 */
export async function deleteLead(
  id: string,
  deletedByUserId?: string | null
): Promise<void> {
  const current = await getLeadById(id);
  if (!current) throw new LeadServiceError('NOT_FOUND', `Lead ${id} não existe`);

  const [followupSvc, schedulerSvc] = await Promise.all([
    import('@/modules/followup/service'),
    import('@/modules/scheduler/service'),
  ]);
  await Promise.allSettled([
    followupSvc.cancelPendingByLead(id, 'lead_deleted'),
    schedulerSvc.cancelPendingByLead(id, 'lead_deleted'),
  ]);

  // Grava tempo de atendimento no ranking ANTES do delete — a row precisa
  // estar persistida quando o lead some. Só conta pra ranking quando humano
  // apagou (deletedByUserId não-nulo).
  if (deletedByUserId) {
    const { logAttendantClose } = await import('./mutations');
    await logAttendantClose({
      userId: deletedByUserId,
      leadId: id,
      action: 'deleted',
      durationMs: Date.now() - current.createdAt.getTime(),
    });
  }

  const { db } = await import('@/lib/db/client');
  const { leads } = await import('@/lib/db/schema/leads');
  const { eq } = await import('drizzle-orm');
  await db.delete(leads).where(eq(leads.id, id));

  emitToEmpresa(CRM_ROOM, 'lead:deleted', { leadId: id });
  logger.info({ leadId: id, by: deletedByUserId }, '[leads] deletado (hard)');
}

export async function patchLead(id: string, patch: UpdateLeadInput): Promise<Lead> {
  const current = await getLeadById(id);
  if (!current) throw new LeadServiceError('NOT_FOUND', `Lead ${id} não existe`);

  // Transições manuais são livres — atendente decide pra onde mover.
  await updateLead(id, patch);
  const updated = await getLeadById(id);
  if (!updated) throw new LeadServiceError('NOT_FOUND', `Lead ${id} sumiu após update`);
  emitToEmpresa(CRM_ROOM, 'lead:updated', { lead: updated });
  return updated;
}

/**
 * Renova a pausa renovável da IA pro lead — chamado quando o atendente
 * HUMANO envia mensagem (rota POST /api/leads/[id]/messages) ou quando a IA
 * detecta trigger de cancelamento. A IA cala por `minutes` a partir de agora;
 * se a pausa já estava ativa com tempo MAIOR, mantemos o maior (não encurta).
 *
 * Decisão de design: salvar o NOVO valor sempre que vier maior ou igual ao
 * atual. Renovação simples — cada msg do humano empurra o timer pra frente.
 */
export async function renewAiPause(
  leadId: string,
  minutes: number,
  reason: 'human_message' | 'cancellation_trigger'
): Promise<void> {
  if (minutes <= 0) return;
  const lead = await getLeadById(leadId);
  if (!lead) return;
  const now = Date.now();
  const newUntil = new Date(now + minutes * 60_000);
  const current = lead.aiPausedUntil?.getTime() ?? 0;
  if (current >= newUntil.getTime()) return; // já mais longa
  await updateLead(leadId, { aiPausedUntil: newUntil });
  logger.info(
    { leadId, minutes, reason, until: newUntil },
    '[leads] aiPausedUntil renovada'
  );
  emitToEmpresa(CRM_ROOM, 'lead:updated', {
    lead: { ...lead, aiPausedUntil: newUntil },
  });
}

/**
 * Marca o lead como "Resolvido" manualmente: seta `resolvedAt = now`, move
 * status pra `attending` (não-terminal, fica na coluna "Respondidos" do
 * kanban) e cancela todos os follow-ups pendentes. Enquanto `resolvedAt`
 * está preenchido, NENHUM follow-up novo é agendado nem disparado pro lead.
 * Limpa automaticamente quando o lead manda nova msg inbound (volta ao
 * ciclo normal de follow-up).
 *
 * Idempotente: chamar de novo num lead já resolvido só refresca o timestamp.
 */
export async function markLeadResolved(leadId: string): Promise<Lead> {
  const current = await getLeadById(leadId);
  if (!current) throw new LeadServiceError('NOT_FOUND', `Lead ${leadId} não existe`);

  const now = new Date();
  await updateLead(leadId, {
    resolvedAt: now,
    // Status terminal (converted/lost) NÃO muda — atendente já fechou de outro jeito.
    ...(current.status === 'converted' || current.status === 'lost'
      ? {}
      : { status: 'attending' }),
  });

  // Cancela follow-ups pendentes em massa. Best-effort: se o cancelamento
  // falhar, o worker scheduler.ts ainda checa resolvedAt antes de disparar.
  try {
    const { cancelPendingByLead } = await import('@/modules/followup/service');
    await cancelPendingByLead(leadId, 'lead_resolved_manually');
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId },
      '[leads] cancelar follow-ups ao resolver falhou (worker ainda barra)'
    );
  }

  const updated = await getLeadById(leadId);
  if (!updated) throw new LeadServiceError('NOT_FOUND', `Lead ${leadId} sumiu após update`);
  emitToEmpresa(CRM_ROOM, 'lead:updated', { lead: updated });
  logger.info({ leadId }, '[leads] marcado como resolvido manualmente');
  return updated;
}

/**
 * Limpa `resolvedAt` — chamado quando o lead manda nova msg inbound (volta
 * a engajar, então o atendente NÃO deve mais ter o estado "resolvido": se
 * o lead sumir de novo, follow-ups voltam a rodar). No-op se não estava
 * resolvido.
 */
export async function clearLeadResolved(leadId: string): Promise<void> {
  const current = await getLeadById(leadId);
  if (!current || !current.resolvedAt) return;
  await updateLead(leadId, { resolvedAt: null });
  logger.info(
    { leadId },
    '[leads] resolvedAt limpo (inbound novo, ciclo de follow-up retomado)'
  );
}

/**
 * Re-liga aiAgentActive=1 em TODOS os leads não-terminais.
 * Usado quando o admin re-habilita a IA global e quer propagar o
 * estado pros chats existentes (que ficaram com IA off durante a janela
 * em que ai_agent_config.enabled estava false).
 *
 * Não dispara nenhuma mensagem agora — a IA é puramente reativa a inbound,
 * então o efeito prático é "armar" os leads pra responder na próxima msg.
 * Followups não disparam automaticamente (são agendados na criação do lead).
 *
 * Retorna a contagem de leads afetados.
 */
export async function bulkEnableAiForUnit(): Promise<{ affected: number }> {
  const { db } = await import('@/lib/db/client');
  const { leads: leadsTable } = await import('@/lib/db/schema/leads');
  const { and, eq, notInArray } = await import('drizzle-orm');
  const result = await db
    .update(leadsTable)
    .set({ aiAgentActive: 1, updatedAt: new Date() })
    .where(
      and(
        eq(leadsTable.aiAgentActive, 0),
        notInArray(leadsTable.status, ['converted', 'lost'])
      )
    )
    .returning({ id: leadsTable.id });
  logger.info(
    { affected: result.length },
    '[leads] bulkEnableAiForUnit — IA religada em massa após admin reativar config global'
  );
  return { affected: result.length };
}

export async function escalate(id: string, toStatus: LeadStatus, level: number): Promise<void> {
  const current = await getLeadById(id);
  if (!current) throw new LeadServiceError('NOT_FOUND', `Lead ${id} não existe`);
  if (TERMINAL_STATUSES.has(current.status)) return;
  if (current.status === toStatus) return;

  await escalateLead(id, toStatus, level);
  logger.info(
    { leadId: id, from: current.status, to: toStatus, level },
    '[leads] escalado'
  );
  emitToEmpresa(CRM_ROOM, 'lead:statusChanged', {
    leadId: id,
    previousStatus: current.status,
    newStatus: toStatus,
    level,
    timestamp: new Date(),
  });
  if (toStatus === 'urgency') {
    emitToEmpresa(CRM_ROOM, 'lead:urgencyAlert', { leadId: id });
  }
}

export async function reopenLead(id: string): Promise<Lead> {
  const current = await getLeadById(id);
  if (!current) throw new LeadServiceError('NOT_FOUND', `Lead ${id} não existe`);
  if (!TERMINAL_STATUSES.has(current.status)) {
    throw new LeadServiceError('INVALID_TRANSITION', `Lead ${id} não está em status terminal`);
  }

  await setLeadStatus(id, 'new');
  await updateLead(id, { metadata: { ...(current.metadata ?? {}), reopenedFrom: current.status, reopenedAt: new Date().toISOString() } });

  const updated = await getLeadById(id);
  if (!updated) throw new LeadServiceError('NOT_FOUND', `Lead ${id} sumiu após reopen`);
  emitToEmpresa(CRM_ROOM, 'lead:statusChanged', {
    leadId: id,
    previousStatus: current.status,
    newStatus: 'new',
    timestamp: new Date(),
    reason: 'reopened',
  });
  logger.info({ leadId: id, from: current.status }, '[leads] reaberto');
  return updated;
}

export async function changeStatus(
  id: string,
  status: LeadStatus,
  options: { assignedToId?: string; convertedById?: string | null } = {}
): Promise<void> {
  const current = await getLeadById(id);
  if (!current) throw new LeadServiceError('NOT_FOUND', `Lead ${id} não existe`);

  // Transição livre: atendente pode marcar qualquer status manualmente.
  // convertedById vem do caller (rota /status passa req.user.id quando atendente
  // humano clica "Converti!"). aiBlockedUntil é setado automático (+24h).
  await setLeadStatus(id, status, {
    assignedToId: options.assignedToId,
    convertedById: options.convertedById ?? null,
  });
  emitToEmpresa(CRM_ROOM, 'lead:statusChanged', {
    leadId: id,
    previousStatus: current.status,
    newStatus: status,
    timestamp: new Date(),
  });
}

export async function bumpActivity(
  leadId: string,
  source: 'inbound' | 'outbound',
  when: Date = new Date()
): Promise<void> {
  await touchLastMessage(leadId, when, source);

  const current = await getLeadById(leadId);
  if (!current) return;

  // Lead terminal (converted/lost) com inbound novo: reabre imediatamente
  // como `new`. NÃO existe mais janela de "invisibilidade" (era 48h via
  // CRM_CONVERTED_LOCK_HOURS) — qualquer mensagem volta o lead pra pipeline.
  // aiBlockedUntil (se setada na conversão) é preservada — atendente humano
  // responde durante a janela de bloqueio da IA.
  if (TERMINAL_STATUSES.has(current.status)) {
    if (source === 'inbound') {
      await setLeadStatus(leadId, 'new');
      await updateLead(leadId, {
        metadata: {
          ...(current.metadata ?? {}),
          reopenedFrom: current.status,
          reopenedAt: when.toISOString(),
          reopenReason: 'auto_on_inbound',
        },
      });
      logger.info(
        { leadId, from: current.status },
        '[leads] reaberto ao receber inbound (status era terminal)'
      );
      emitToEmpresa(CRM_ROOM, 'lead:statusChanged', {
        leadId,
        previousStatus: current.status,
        newStatus: 'new',
        timestamp: when,
      });
    } else if (source === 'outbound' && current.status === 'converted') {
      // Mandamos mensagem PRA um lead convertido: ele perde o status TEMPORÁRIO
      // de conversão e volta pra "Respondidos" (attending). convertedAt é
      // preservado (a conversão segue no relatório, com badge "reaberto"); só o
      // estado terminal + o bloqueio temporário da IA (aiBlockedUntil) saem.
      // Se o cliente responder depois, o branch inbound acima joga pro pipeline.
      await reopenConvertedToAttending(leadId);
      await updateLead(leadId, {
        metadata: {
          ...(current.metadata ?? {}),
          reopenedFrom: current.status,
          reopenedAt: when.toISOString(),
          reopenReason: 'auto_on_outbound',
        },
      });
      logger.info(
        { leadId },
        '[leads] convertido voltou pra Respondidos ao receber mensagem nossa (outbound)'
      );
      emitToEmpresa(CRM_ROOM, 'lead:statusChanged', {
        leadId,
        previousStatus: current.status,
        newStatus: 'attending',
        timestamp: when,
      });
    }
    return;
  }

  // Decisão por TIMESTAMP (qual msg é a mais recente), não só pelo status atual.
  // Webhooks inbound/outbound são processados concorrentemente pelo BullMQ e
  // podem chegar fora de ordem: se o outbound de um atendente é processado
  // DEPOIS de um inbound posterior do cliente, decidir por status marcava
  // 'attending' por último e prendia o lead em "Respondidos" com o cliente
  // esperando (centenas de casos observados na Atenas em 13/06). Comparar
  // lastInboundAt vs lastOutboundAt resolve nos dois sentidos — cada
  // touchLastMessage grava só o seu campo, então os timestamps refletem a
  // cronologia real independente da ordem de processamento.
  const lastInbound = current.lastInboundAt?.getTime() ?? 0;
  const lastOutbound = current.lastOutboundAt?.getTime() ?? 0;
  const clientIsWaiting = lastInbound >= lastOutbound;

  if (source === 'inbound' && current.status === 'attending' && clientIsWaiting) {
    await setLeadStatus(leadId, 'new');
    emitToEmpresa(CRM_ROOM, 'lead:statusChanged', {
      leadId,
      previousStatus: 'attending',
      newStatus: 'new',
      timestamp: when,
    });
  }
  if (
    source === 'outbound' &&
    !TERMINAL_STATUSES.has(current.status) &&
    current.status !== 'attending' &&
    !clientIsWaiting
  ) {
    await setLeadStatus(leadId, 'attending');
    emitToEmpresa(CRM_ROOM, 'lead:statusChanged', {
      leadId,
      previousStatus: current.status,
      newStatus: 'attending',
      timestamp: when,
    });
  }
}
