/**
 * Queries (read-only) do módulo leads.
 */
import { db } from '@/lib/db/client';
import { filtroUnidade } from '@/modules/units/service';
import { filtroDono } from '@/lib/escopo-dono';
import { leads } from '@/lib/db/schema/leads';
import { eq, and, desc, asc, inArray, sql, lt, isNull, or } from 'drizzle-orm';
import type { Lead, LeadStatus, LeadChannel, LeadAttributedChannel } from './types';

/** Mapeia row Drizzle → tipo de domínio (converte aiAgentActive 0/1 → boolean) */
function rowToLead(row: typeof leads.$inferSelect): Lead {
  return {
    id: row.id,
    externalContactId: row.externalContactId,
    channel: row.channel as LeadChannel,
    connectionId: row.connectionId,
    name: row.name,
    phone: row.phone,
    email: row.email,
    avatarUrl: row.avatarUrl,
    notes: row.notes,
    status: row.status as LeadStatus,
    assignedToId: row.assignedToId,
    attributedChannel: (row.attributedChannel as LeadAttributedChannel | null) ?? null,
    escalationLevel: row.escalationLevel,
    lastMessageAt: row.lastMessageAt,
    lastInboundAt: row.lastInboundAt,
    lastOutboundAt: row.lastOutboundAt,
    lastEscalationAt: row.lastEscalationAt,
    aiAgentActive: row.aiAgentActive === 1,
    aiBlockedUntil: row.aiBlockedUntil,
    aiPausedUntil: row.aiPausedUntil,
    resolvedAt: row.resolvedAt,
    metadata: row.metadata ?? null,
    convertedAt: row.convertedAt,
    convertedById: row.convertedById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getLeadById(id: string): Promise<Lead | null> {
  const [row] = await db.select().from(leads).where(eq(leads.id, id)).limit(1);
  return row ? rowToLead(row) : null;
}

/**
 * Busca lead por (channel, externalContactId). Usado pelo webhook handler pra
 * decidir entre criar lead novo ou atualizar existente.
 */
export async function findLeadByContact(
  channel: LeadChannel,
  externalContactId: string
): Promise<Lead | null> {
  const [row] = await db
    .select()
    .from(leads)
    .where(and(eq(leads.channel, channel), eq(leads.externalContactId, externalContactId)))
    .limit(1);
  return row ? rowToLead(row) : null;
}

export interface ListLeadsFilter {
  /** Recorte por dono do lead — ver `lib/escopo-dono.ts`. */
  ownerId?: string | null;
  /** Recorte por filial. `null`/ausente = sem recorte. */
  unitId?: string | null;
  status?: LeadStatus | LeadStatus[];
  channel?: LeadChannel;
  assignedToId?: string | null;
  connectionId?: string;
  limit?: number;
  offset?: number;
  /** Ordem padrão: lastMessageAt DESC NULLS LAST, createdAt DESC */
  order?: 'recent' | 'oldest';
}

export async function listLeads(filter: ListLeadsFilter = {}): Promise<Lead[]> {
  const conditions = [];
  if (filter.status) {
    conditions.push(
      Array.isArray(filter.status)
        ? inArray(leads.status, filter.status)
        : eq(leads.status, filter.status)
    );
  }
  if (filter.channel) conditions.push(eq(leads.channel, filter.channel));
  if (filter.connectionId) conditions.push(eq(leads.connectionId, filter.connectionId));
  // Ver o comentário em getKanbanData: traz também os ainda não atribuídos.
  const porUnidade = filtroUnidade(leads.unitId, filter.unitId);
  if (porUnidade) conditions.push(porUnidade);
  // Recorte por dono — sem `or(isNull)`: lead sem dono é da casa. Ver
  // `lib/escopo-dono.ts`.
  const porDono = filtroDono(leads.ownerId, filter.ownerId);
  if (porDono) conditions.push(porDono);
  if (filter.assignedToId === null) {
    conditions.push(isNull(leads.assignedToId));
  } else if (filter.assignedToId) {
    conditions.push(eq(leads.assignedToId, filter.assignedToId));
  }

  const order = filter.order === 'oldest' ? asc(leads.createdAt) : desc(leads.lastMessageAt);

  const rows = await db
    .select()
    .from(leads)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(order, desc(leads.createdAt))
    .limit(filter.limit ?? 50)
    .offset(filter.offset ?? 0);

  return rows.map(rowToLead);
}

/**
 * Lista leads candidatos a escalação:
 *   - status='new' E lastMessageAt < (now - newToPriorityMinutes)
 *   - status='priority' E lastMessageAt < (now - priorityToUrgencyMinutes)
 *
 * Usado pelo escalation worker (cron 1min).
 */
export async function listLeadsToEscalate(params: {
  newToPriorityMinutes: number;
  priorityToUrgencyMinutes: number;
}): Promise<Lead[]> {
  const now = new Date();
  const newCutoff = new Date(now.getTime() - params.newToPriorityMinutes * 60_000);
  const priCutoff = new Date(now.getTime() - params.priorityToUrgencyMinutes * 60_000);

  const rows = await db
    .select()
    .from(leads)
    .where(
      or(
        and(eq(leads.status, 'new'), lt(leads.lastMessageAt, newCutoff)),
        and(eq(leads.status, 'priority'), lt(leads.lastMessageAt, priCutoff))
      )
    )
    .limit(500);

  return rows.map(rowToLead);
}

/** Conta leads agrupados por status — usado em dashboard cards */
export async function countLeadsByStatus(connectionId?: string): Promise<Record<LeadStatus, number>> {
  const conditions = connectionId ? [eq(leads.connectionId, connectionId)] : [];
  const rows = await db
    .select({ status: leads.status, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(leads.status);

  const result: Record<string, number> = {
    new: 0,
    priority: 0,
    urgency: 0,
    attending: 0,
    converted: 0,
    lost: 0,
  };
  for (const r of rows) result[r.status] = r.count;
  return result as Record<LeadStatus, number>;
}
