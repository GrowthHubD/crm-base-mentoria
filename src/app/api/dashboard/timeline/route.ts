/**
 * GET /api/dashboard/timeline — evolução de leads num período configurável.
 *
 * Aceita `?from=YYYY-MM-DD&to=YYYY-MM-DD` (datas inclusivas). Sem params,
 * usa últimos 30 dias. Limite máximo de 366 dias pra não estourar memória.
 *
 * Agrupa por dia NO FUSO BRT (created_at guarda UTC → converte antes de
 * truncar o dia). `concluidos` = converted; `atendimento`
 * = em fila ativa (attending/priority/urgency). Tudo somado vira `total`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { sql, gte, lte, and } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

export interface TimelinePoint {
  date: string; // DD/MM
  total: number;
  concluidos: number;
  atendimento: number;
}

const MAX_RANGE_DAYS = 366;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParam(v: string | null): Date | null {
  if (!v || !ISO_DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  const url = new URL(req.url);
  const fromParam = parseDateParam(url.searchParams.get('from'));
  const toParam = parseDateParam(url.searchParams.get('to'));

  const end = toParam ?? new Date();
  end.setHours(23, 59, 59, 999);

  const start = fromParam ?? (() => {
    const d = new Date(end);
    d.setDate(d.getDate() - 29);
    return d;
  })();
  start.setHours(0, 0, 0, 0);

  // Clamp range pra evitar query > 1 ano (custos + memória).
  const diffDays = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  if (diffDays > MAX_RANGE_DAYS) {
    start.setTime(end.getTime() - MAX_RANGE_DAYS * 86_400_000);
    start.setHours(0, 0, 0, 0);
  }
  if (start > end) {
    return NextResponse.json({ points: [] });
  }

  const rows = await db
    .select({
      // `created_at` guarda UTC: converte pra BRT ANTES de truncar o dia,
      // senão lead que entrou às 22h BRT é contado no dia seguinte.
      day: sql<string>`to_char(${leads.createdAt} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD')`.as('day'),
      status: leads.status,
      count: sql<number>`count(*)::int`,
    })
    .from(leads)
    .where(and(
      gte(leads.createdAt, start),
      lte(leads.createdAt, end),
    ))
    .groupBy(sql`day`, leads.status)
    .orderBy(sql`day asc`);

  const byDay = new Map<string, { total: number; concluidos: number; atendimento: number }>();
  for (const r of rows) {
    const t = byDay.get(r.day) ?? { total: 0, concluidos: 0, atendimento: 0 };
    t.total += r.count;
    if (r.status === 'converted') t.concluidos += r.count;
    if (r.status === 'attending' || r.status === 'priority' || r.status === 'urgency') {
      t.atendimento += r.count;
    }
    byDay.set(r.day, t);
  }

  const points: TimelinePoint[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const t = byDay.get(iso) ?? { total: 0, concluidos: 0, atendimento: 0 };
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    points.push({ date: `${dd}/${mm}`, ...t });
  }

  return NextResponse.json({ points });
}
