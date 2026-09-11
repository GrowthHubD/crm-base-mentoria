/**
 * GET /api/dashboard/converted — leads convertidos com atendente responsável.
 *
 * Histórico cumulativo: lista TODO lead com `converted_at IS NOT NULL`,
 * independente do status atual. Lead que foi convertido e depois reaberto
 * continua aparecendo aqui (mas com `reopened: true` pro UI sinalizar).
 *
 * Atendente exibido:
 *   1) `convertedById` (quem clicou "Converti!" no CRM). Primary.
 *   2) Fallback: último `sender='human'` em `messages` do lead. Cobre o
 *      caso de atendente que fecha pelo celular sem clicar "Converti" —
 *      antes ele sumia da lista por completo (incidente 09/06).
 *   3) Sem nenhum dos dois → "—" + conexão como referência.
 *
 * Ordena por `convertedAt` desc. Default últimos 50; `?limit=N` até 200.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { users } from '@/lib/db/schema/users';
import { connections } from '@/lib/db/schema/connections';
import { messages } from '@/lib/db/schema/messages';
import { eq, desc, sql, and, inArray, isNotNull } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

export interface ConvertedRow {
  id: string;
  name: string;
  phone: string;
  channel: string;
  atendente: string | null;
  /** 'converted_by' = clicou "Converti"; 'last_human' = fallback último humano. */
  atendenteSource: 'converted_by' | 'last_human' | null;
  connectionName: string | null;
  convertedAt: string;
  /** Lead foi reaberto após conversão (status atual != 'converted'). */
  reopened: boolean;
  /** Cliente convertido voltou a falar depois de convertedAt. Badge na UI. */
  hasNewInbound: boolean;
  /** Timestamp da inbound mais recente APÓS convertedAt — pra mostrar "voltou
   *  a falar há X horas". */
  lastInboundAfterConvertedAt: string | null;
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  const url = new URL(req.url);
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));

  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      channel: leads.channel,
      status: leads.status,
      convertedById: leads.convertedById,
      convertedByName: users.name,
      connectionName: connections.displayName,
      convertedAt: leads.convertedAt,
      updatedAt: leads.updatedAt,
    })
    .from(leads)
    .leftJoin(users, eq(leads.convertedById, users.id))
    .leftJoin(connections, eq(leads.connectionId, connections.id))
    .where(isNotNull(leads.convertedAt))
    .orderBy(desc(sql`coalesce(${leads.convertedAt}, ${leads.updatedAt})`))
    .limit(limit);

  const leadIds = rows.map(r => r.id);

  // Bulk: última inbound (pra badge "voltou a falar") + último humano (pra
  // fallback de atendente quando convertedById é null — atendente que fecha
  // pelo celular sem clicar "Converti" entra aqui).
  const lastInboundByLead = new Map<string, Date>();
  const lastHumanByLead = new Map<string, { name: string | null; ts: Date }>();
  if (leadIds.length > 0) {
    const inboundRows = await db
      .select({
        leadId: messages.leadId,
        maxTs: sql<Date>`max(${messages.timestamp})`.as('max_ts'),
      })
      .from(messages)
      .where(and(inArray(messages.leadId, leadIds), eq(messages.direction, 'inbound')))
      .groupBy(messages.leadId);
    for (const row of inboundRows) {
      if (row.maxTs) lastInboundByLead.set(row.leadId, new Date(row.maxTs));
    }

    // Último humano que respondeu: window function pra pegar 1ª linha por lead
    // ordenado por timestamp desc. Cruza com users pra resolver nome (sentById
    // pode ser null se foi celular, daí usa senderName persistido).
    const ranked = await db
      .select({
        leadId: messages.leadId,
        timestamp: messages.timestamp,
        senderName: messages.senderName,
        userName: users.name,
        rn: sql<number>`row_number() over (partition by ${messages.leadId} order by ${messages.timestamp} desc)`.as('rn'),
      })
      .from(messages)
      .leftJoin(users, eq(messages.sentById, users.id))
      .where(and(inArray(messages.leadId, leadIds), eq(messages.sender, 'human')));
    for (const r of ranked) {
      if (Number(r.rn) !== 1) continue;
      const name = (r.userName ?? r.senderName ?? '').trim();
      if (name) lastHumanByLead.set(r.leadId, { name, ts: r.timestamp });
    }
  }

  const data: ConvertedRow[] = rows.map(r => {
    const convertedAt = r.convertedAt ?? r.updatedAt;
    const lastInbound = lastInboundByLead.get(r.id);
    const hasNew = !!(lastInbound && lastInbound.getTime() > convertedAt.getTime());

    // Atendente: convertedBy primary; fallback no último humano.
    let atendente: string | null = r.convertedByName ?? null;
    let atendenteSource: ConvertedRow['atendenteSource'] = atendente ? 'converted_by' : null;
    if (!atendente) {
      const last = lastHumanByLead.get(r.id);
      if (last?.name) {
        atendente = last.name;
        atendenteSource = 'last_human';
      }
    }

    return {
      id: r.id,
      name: r.name ?? 'Sem nome',
      phone: r.phone ?? '—',
      channel: r.channel,
      atendente,
      atendenteSource,
      connectionName: r.connectionName,
      convertedAt: convertedAt.toISOString(),
      reopened: r.status !== 'converted',
      hasNewInbound: hasNew,
      lastInboundAfterConvertedAt: hasNew && lastInbound ? lastInbound.toISOString() : null,
    };
  });

  return NextResponse.json({ converted: data });
}
