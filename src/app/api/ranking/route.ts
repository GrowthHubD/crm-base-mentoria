/**
 * GET /api/ranking — ranking global de atendentes, agregado cross-unit.
 *
 * Não filtra por unit ativo: ranking é SEMPRE global por design (regra do
 * cliente). Visível a todos os roles autenticados (incluindo atendente).
 *
 * Métricas por atendente:
 *  - atendimentos: DISTINCT lead_id em messages com sender='human' e sentById
 *    do user. "Atendimento" = lead que esse atendente tocou em algum momento.
 *  - conversoes: COUNT em attendant_close_log com action='converted' e userId
 *    do atendente. Conversões automáticas (IA, Asaas) não entram (userId NULL).
 *  - tempoMedioMs: AVG(duration_ms) em attendant_close_log do user — todas
 *    actions ('converted' + 'deleted'), conforme regra "encerrou o ciclo".
 *  - taxa: conversoes / atendimentos * 100 (0 se atendimentos=0).
 *  - badge: Top (≥70%) | Bom (≥55%) | Regular (<55%).
 *
 * Atendentes que aparecem mas não bateram nenhum critério ficam de fora —
 * só lista quem efetivamente operou.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema/messages';
import { users } from '@/lib/db/schema/users';
import { attendantCloseLog } from '@/lib/db/schema/attendant-close-log';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

export type RankingBadge = 'Top' | 'Bom' | 'Regular';

export interface RankingAttendant {
  id: string;
  name: string;
  initials: string;
  color: string;
  atendimentos: number;
  conversoes: number;
  taxa: number;
  /** Tempo médio do ciclo (lead criado → encerramento) em minutos arredondados. */
  tempoMedioMin: number | null;
  badge: RankingBadge;
  rank: number;
}

// 6 cores bem distintas — sortidas pelo hash do user.id, estável entre requests
// (mesmo atendente sempre vê a mesma cor). 6 evita repetição com poucos
// atendentes e mantém contraste visual no avatar/badge.
const PALETTE = ['#A78BFA', '#22D3EE', '#F472B6', '#FBBF24', '#4ADE80', '#F87171'];

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

function badgeFor(taxa: number): RankingBadge {
  if (taxa >= 70) return 'Top';
  if (taxa >= 55) return 'Bom';
  return 'Regular';
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  // Ranking lista APENAS atendentes (role='attendant'). Admins que
  // eventualmente respondam no CRM aparecem nos logs internos
  // mas não competem aqui — o ranking é entre atendentes do operacional.
  const attendantRole = eq(users.role, 'attendant');

  // 1) Atendimentos por usuário — leads DISTINTOS que o atendente tocou pelo
  //    CRM (msg 'human' com autoria) OU fechou (close-log, qualquer ação).
  //
  //    Contar só as mensagens do CRM estourava a taxa acima de 100% para quem
  //    atende PELO CELULAR: a resposta pelo celular chega como sender='owner',
  //    sem autoria, e some do denominador — mas o clique em "Converti!" fica
  //    no nome da pessoa e continua no numerador. Incluindo o fechamento, toda
  //    conversão está necessariamente no denominador, então a taxa é ≤ 100%.
  //
  //    Buscamos os PARES (usuário, lead) das duas fontes e unimos com Set.
  const msgPairs = await db
    .select({ userId: messages.sentById, userName: users.name, leadId: messages.leadId })
    .from(messages)
    .innerJoin(users, eq(messages.sentById, users.id))
    .where(and(eq(messages.sender, 'human'), attendantRole))
    .groupBy(messages.sentById, users.name, messages.leadId);

  const closePairs = await db
    .select({
      userId: attendantCloseLog.userId,
      userName: users.name,
      leadId: attendantCloseLog.leadIdText,
    })
    .from(attendantCloseLog)
    .innerJoin(users, eq(attendantCloseLog.userId, users.id))
    .where(attendantRole)
    .groupBy(attendantCloseLog.userId, users.name, attendantCloseLog.leadIdText);

  // 2) Conversões + tempo médio por usuário — só action='converted' pra count
  //    de conversões, mas TODAS (converted+deleted) entram no AVG (encerrou ciclo).
  const closeRows = await db
    .select({
      userId: attendantCloseLog.userId,
      userName: users.name,
      conversoes: sql<number>`sum(case when ${attendantCloseLog.action}='converted' then 1 else 0 end)::int`,
      totalClosures: sql<number>`count(*)::int`,
      avgMs: sql<string>`avg(${attendantCloseLog.durationMs})`,
    })
    .from(attendantCloseLog)
    .innerJoin(users, eq(attendantCloseLog.userId, users.id))
    .where(and(isNotNull(attendantCloseLog.userId), attendantRole))
    .groupBy(attendantCloseLog.userId, users.name);

  const byUser = new Map<string, {
    name: string;
    atendimentos: number;
    conversoes: number;
    avgMs: number | null;
  }>();
  // União (usuário → conjunto de leads tocados/fechados). `atendimentos` é o
  // tamanho do conjunto, então toda conversão já está no denominador.
  const atendLeadsByUser = new Map<string, { name: string; leads: Set<string> }>();
  for (const p of [...msgPairs, ...closePairs]) {
    if (!p.userId || !p.leadId) continue;
    let entry = atendLeadsByUser.get(p.userId);
    if (!entry) {
      entry = { name: p.userName ?? 'Atendente', leads: new Set<string>() };
      atendLeadsByUser.set(p.userId, entry);
    }
    if (p.userName) entry.name = p.userName;
    entry.leads.add(p.leadId);
  }
  for (const [userId, entry] of atendLeadsByUser) {
    const cur = byUser.get(userId) ?? { name: entry.name, atendimentos: 0, conversoes: 0, avgMs: null };
    cur.name = entry.name;
    cur.atendimentos += entry.leads.size;
    byUser.set(userId, cur);
  }
  for (const r of closeRows) {
    if (!r.userId) continue;
    const name = r.userName ?? 'Atendente';
    const cur = byUser.get(r.userId) ?? { name, atendimentos: 0, conversoes: 0, avgMs: null };
    cur.name = name;
    cur.conversoes += r.conversoes;
    // avg vem como string (numeric do PG). Convertemos com fallback null se NaN.
    const parsed = r.avgMs ? Number(r.avgMs) : NaN;
    cur.avgMs = Number.isFinite(parsed) ? parsed : null;
    byUser.set(r.userId, cur);
  }

  const arr = Array.from(byUser.entries()).map(([id, v]) => {
    const taxa = v.atendimentos > 0 ? Math.round((v.conversoes / v.atendimentos) * 100) : 0;
    return {
      id,
      name: v.name,
      initials: initialsFor(v.name),
      color: colorFor(id),
      atendimentos: v.atendimentos,
      conversoes: v.conversoes,
      taxa,
      tempoMedioMin: v.avgMs !== null ? Math.round(v.avgMs / 60_000) : null,
      badge: badgeFor(taxa),
    };
  });

  // Ranking: mais conversões primeiro; desempate por atendimentos.
  arr.sort((a, b) => b.conversoes - a.conversoes || b.atendimentos - a.atendimentos);
  const ranked: RankingAttendant[] = arr.map((a, i) => ({ ...a, rank: i + 1 }));

  return NextResponse.json({ attendants: ranked });
}
