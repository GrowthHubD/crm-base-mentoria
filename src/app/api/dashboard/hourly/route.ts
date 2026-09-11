/**
 * GET /api/dashboard/hourly — fluxo de mensagens por HORA DO DIA, agregado
 * sobre o período do seletor (`?from=YYYY-MM-DD&to=YYYY-MM-DD`).
 *
 * Dois defeitos que existiam aqui:
 *
 *  1. FUSO. A coluna `messages.timestamp` guarda UTC. `extract(hour from
 *     timestamp)` devolvia a hora em UTC e o gráfico saía deslocado 3h — o
 *     pico real das 21h BRT aparecia à meia-noite. Agora converte pra
 *     America/Sao_Paulo antes de extrair a hora.
 *  2. PERÍODO. Era fixo em "últimas 24h" e ignorava o seletor de datas,
 *     enquanto os outros gráficos respondiam. Agora agrega por hora do dia
 *     sobre a janela from..to (default: últimos 30 dias).
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema/messages';
import { sql, gte, lte, and } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

export interface HourlyPoint {
  hour: string;
  v: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDateParam(v: string | null): Date | null {
  if (!v || !ISO_DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Hora do dia em BRT a partir do timestamp UTC gravado na coluna. */
const HOUR_BRT = sql<number>`extract(hour from ${messages.timestamp} AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo')::int`;

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  const url = new URL(req.url);
  const rangeEnd = parseDateParam(url.searchParams.get('to')) ?? new Date();
  rangeEnd.setHours(23, 59, 59, 999);
  const rangeStart = parseDateParam(url.searchParams.get('from')) ?? (() => {
    const d = new Date(rangeEnd);
    d.setDate(d.getDate() - 29);
    return d;
  })();
  rangeStart.setHours(0, 0, 0, 0);

  const rows = await db
    .select({
      hour: HOUR_BRT.as('hour'),
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(and(gte(messages.timestamp, rangeStart), lte(messages.timestamp, rangeEnd)))
    .groupBy(sql`hour`);

  const byHour = new Map<number, number>();
  for (const r of rows) byHour.set(r.hour, r.count);

  const points: HourlyPoint[] = [];
  for (let h = 0; h < 24; h += 2) {
    const v = (byHour.get(h) ?? 0) + (byHour.get(h + 1) ?? 0);
    points.push({ hour: `${String(h).padStart(2, '0')}h`, v });
  }

  return NextResponse.json({ points });
}
