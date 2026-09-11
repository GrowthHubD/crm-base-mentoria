/**
 * GET /api/dashboard/channels — distribuição de leads, em duas leituras.
 *
 * Aceita `?from=YYYY-MM-DD&to=YYYY-MM-DD` (default: últimos 30 dias), como os
 * demais gráficos do dashboard.
 *
 * `channels` responde "por onde o lead ENTROU" e agrupa por `leads.channel` —
 * o canal de conversa. Antes agrupava por `attributed_channel`, e como esse
 * campo só é preenchido quando um marcador de anúncio é reconhecido, a soma
 * dos anéis não batia com o total do período: o donut mostrava algumas
 * centenas ao redor de um centro na casa dos milhares.
 *
 * `adSources` responde "de qual anúncio o lead veio" e agrupa por
 * `attributed_channel`. É métrica de marketing, legitimamente parcial — só
 * cobre lead com origem rastreada. Separar as duas evita comparar coisas
 * diferentes no mesmo gráfico.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { sql, and, gte, lte, isNotNull } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

/** Canais de CONVERSA — por onde a mensagem realmente trafega. */
const CHANNELS: Array<{ id: string; key: string; name: string; color: string }> = [
  { id: 'whats',  key: 'whatsapp', name: 'WhatsApp', color: '#22C55E' },
  { id: 'manual', key: 'manual',   name: 'Manual',   color: '#94A3B8' },
];

/** Origens de MARKETING — de onde o lead veio antes de chamar. */
const AD_SOURCES: Array<{ id: string; key: string; name: string; color: string }> = [
  { id: 'instagram', key: 'instagram', name: 'Instagram', color: '#F472B6' },
  { id: 'google',    key: 'google',    name: 'Google Ads', color: '#9154FF' },
  { id: 'whats',     key: 'whatsapp',  name: 'Direto',     color: '#22C55E' },
];

export interface ChannelStats {
  id: string;
  name: string;
  color: string;
  leads: number;
  novos: number;
  atendendo: number;
  convertidos: number;
  conversao: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDateParam(v: string | null): Date | null {
  if (!v || !ISO_DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

type Tally = { total: number; novos: number; atendendo: number; convertidos: number };

function emptyTally(): Tally {
  return { total: 0, novos: 0, atendendo: 0, convertidos: 0 };
}

function accumulate(t: Tally, status: string, count: number): void {
  t.total += count;
  if (status === 'new' || status === 'priority' || status === 'urgency') t.novos += count;
  if (status === 'attending') t.atendendo += count;
  if (status === 'converted') t.convertidos += count;
}

function toStats(
  defs: Array<{ id: string; key: string; name: string; color: string }>,
  tally: Map<string, Tally>
): ChannelStats[] {
  return defs.map(c => {
    const t = tally.get(c.key) ?? emptyTally();
    return {
      id: c.id,
      name: c.name,
      color: c.color,
      leads: t.total,
      novos: t.novos,
      atendendo: t.atendendo,
      convertidos: t.convertidos,
      conversao: t.total > 0 ? Math.round((t.convertidos / t.total) * 100) : 0,
    };
  });
}

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

  const period = and(gte(leads.createdAt, rangeStart), lte(leads.createdAt, rangeEnd));

  // Canal de conversa — cobre TODOS os leads do período, então a soma fecha.
  const channelRows = await db
    .select({ channel: leads.channel, status: leads.status, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(period)
    .groupBy(leads.channel, leads.status);

  const channelTally = new Map<string, Tally>();
  for (const r of channelRows) {
    if (!r.channel) continue;
    const t = channelTally.get(r.channel) ?? emptyTally();
    accumulate(t, r.status, r.count);
    channelTally.set(r.channel, t);
  }

  // Origem de anúncio — só leads com atribuição reconhecida.
  const adRows = await db
    .select({
      channel: leads.attributedChannel,
      status: leads.status,
      count: sql<number>`count(*)::int`,
    })
    .from(leads)
    .where(and(period, isNotNull(leads.attributedChannel)))
    .groupBy(leads.attributedChannel, leads.status);

  const adTally = new Map<string, Tally>();
  for (const r of adRows) {
    if (!r.channel) continue;
    const t = adTally.get(r.channel) ?? emptyTally();
    accumulate(t, r.status, r.count);
    adTally.set(r.channel, t);
  }

  return NextResponse.json({
    channels: toStats(CHANNELS, channelTally),
    adSources: toStats(AD_SOURCES, adTally),
  });
}
