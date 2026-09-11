/**
 * GET /api/dashboard/attendants — performance de atendentes.
 *
 * Sempre GLOBAL (cross-unit) — cliente decidiu em 09/06 que ranking não
 * faz sentido segmentado por unidade; gerente quer ver a rede inteira em
 * um lugar só, e o admin compara colegas independente de onde atendem.
 *
 * Atendente = user com leads atribuídos ou com conversões registradas.
 *
 * Conversões: contadas via `attendant_close_log` (action='converted') —
 * fonte cumulativa que persiste mesmo se o lead muda de status depois.
 *
 * Visibilidade: TODOS os roles autenticados veem o ranking completo,
 * incluindo atendentes. Cliente pediu em 09/06 — virou ferramenta de
 * gamificação entre o time, esconder os colegas tira o sentido.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { users } from '@/lib/db/schema/users';
import { attendantCloseLog } from '@/lib/db/schema/attendant-close-log';
import { sql, isNotNull, eq, and } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

export interface AttendantStats {
  id: string;
  name: string;
  initials: string;
  color: string;
  atendimentos: number;
  conversoes: number;
  taxa: number;
  badge: 'Top' | 'Bom' | 'Regular';
  rank: number;
}

const PALETTE = ['#C08BFF', '#22D3EE', '#F472B6', '#A78BFA', '#FBBF24', '#4ADE80', '#F87171', '#818CF8'];

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  // Atendimentos = leads atribuídos a `assignedToId` (qualquer status, qualquer unit).
  const atendRows = await db
    .select({
      userId: leads.assignedToId,
      userName: users.name,
      count: sql<number>`count(*)::int`,
    })
    .from(leads)
    .leftJoin(users, eq(leads.assignedToId, users.id))
    .where(isNotNull(leads.assignedToId))
    .groupBy(leads.assignedToId, users.name);

  // Conversões = LOG cumulativo de `attendant_close_log` (action='converted').
  // ANTES contava por `leads.convertedById`, mas esse campo é zerado quando
  // o lead sai de status='converted' (via mutations.updateLead). Lead que
  // convertia e era reaberto sumia do contador, escondendo a conversão real.
  // O log persiste mesmo se o lead muda de status ou é apagado depois.
  // Conversões automáticas (IA tool / Asaas webhook) também não geram log
  // (userId null) — então continuam excluídas do ranking dos humanos.
  const convRows = await db
    .select({
      userId: attendantCloseLog.userId,
      userName: users.name,
      count: sql<number>`count(*)::int`,
    })
    .from(attendantCloseLog)
    .leftJoin(users, eq(attendantCloseLog.userId, users.id))
    .where(and(isNotNull(attendantCloseLog.userId), eq(attendantCloseLog.action, 'converted')))
    .groupBy(attendantCloseLog.userId, users.name);

  const byUser = new Map<string, { name: string; atendimentos: number; conversoes: number }>();
  for (const r of atendRows) {
    if (!r.userId) continue;
    const cur = byUser.get(r.userId) ?? { name: r.userName ?? 'Atendente', atendimentos: 0, conversoes: 0 };
    cur.atendimentos += r.count;
    byUser.set(r.userId, cur);
  }
  for (const r of convRows) {
    if (!r.userId) continue;
    const cur = byUser.get(r.userId) ?? { name: r.userName ?? 'Atendente', atendimentos: 0, conversoes: 0 };
    cur.conversoes += r.count;
    if (!byUser.has(r.userId)) byUser.set(r.userId, cur);
  }

  const arr = Array.from(byUser.entries()).map(([id, v]) => {
    const taxa = v.atendimentos > 0 ? Math.round((v.conversoes / v.atendimentos) * 100) : 0;
    const badge: AttendantStats['badge'] = taxa >= 60 ? 'Top' : taxa >= 40 ? 'Bom' : 'Regular';
    return {
      id,
      name: v.name,
      initials: initialsFor(v.name),
      color: colorFor(id),
      atendimentos: v.atendimentos,
      conversoes: v.conversoes,
      taxa,
      badge,
    };
  });

  arr.sort((a, b) => b.conversoes - a.conversoes || b.atendimentos - a.atendimentos);
  const ranked: AttendantStats[] = arr.map((a, i) => ({ ...a, rank: i + 1 }));

  return NextResponse.json({ attendants: ranked });
}
