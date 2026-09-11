/**
 * GET /api/dashboard/stats — KPIs do dashboard.
 *
 * Aceita `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusivo). Sem params, últimos 30
 * dias — o mesmo default do seletor de datas e da timeline.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { messages } from '@/lib/db/schema/messages';
import { connections } from '@/lib/db/schema/connections';
import { sql, eq, gte, lte, and, inArray } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDateParam(v: string | null): Date | null {
  if (!v || !ISO_DATE_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface DashboardStats {
  leads: {
    total: number;
    new: number;
    priority: number;
    urgency: number;
    attending: number;
    /** Quantidade ATUAL na coluna "Convertidos" do kanban (status='converted').
     *  Pode decrementar quando leads são reabertos. Use `convertedAllTime` pra
     *  visão histórica que não decrementa. */
    converted: number;
    /** Cumulativo: count de leads que foram convertidos EM ALGUM MOMENTO
     *  (converted_at NOT NULL), independente do status atual. Não decrementa
     *  quando o lead é reaberto. É essa métrica que vai pra UI principal e
     *  pra "Taxa de Conversão" — o ranking de quem vendeu. */
    convertedAllTime: number;
    lost: number;
    /** Convertidos com `converted_at` em HOJE (sem condicionar status atual).
     *  Lead pode ter sido convertido às 09h e reaberto às 14h — continua
     *  contando como conversão de hoje. */
    convertedToday: number;
    /** Leads que ENTRARAM (created_at) dentro do período `from`..`to`. É o
     *  "quantos leads entraram" que responde ao seletor de datas. */
    leadsInRange: number;
    /** Leads convertidos (converted_at) dentro do período `from`..`to`. */
    convertedInRange: number;
  };
  messages: {
    /** @deprecated Volume bruto in+out. Cliente pediu pra focar em pessoas, não volume —
     *  use `peopleAttendedToday` no KPI principal. Mantido pra compat. */
    today: number;
    inboundToday: number;
    outboundToday: number;
    /** Pessoas (leads únicos) que o TIME atendeu hoje: distinct lead_id com
     *  mensagem outbound (sender 'human', 'ai' ou 'owner') com timestamp >=
     *  startOfDay. Mais útil que volume bruto pra análise — uma conversa com
     *  30 trocas conta como 1 atendimento, não 30. */
    peopleAttendedToday: number;
    /** Pessoas (leads únicos) que MANDARAM msg hoje (entrada de conversa). */
    peopleMessagedToday: number;
  };
  connections: {
    total: number;
    connected: number;
    disconnected: number;
  };
  generatedAt: Date;
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  // Período do filtro do dashboard (inclusivo nas duas pontas). Sem params,
  // cai nos últimos 30 dias — mesmo default do seletor e da timeline.
  const url = new URL(req.url);
  const rangeEnd = parseDateParam(url.searchParams.get('to')) ?? new Date();
  rangeEnd.setHours(23, 59, 59, 999);
  const rangeStart = parseDateParam(url.searchParams.get('from')) ?? (() => {
    const d = new Date(rangeEnd);
    d.setDate(d.getDate() - 29);
    return d;
  })();
  rangeStart.setHours(0, 0, 0, 0);

  // Leads agrupados por status
  const leadCounts = await db
    .select({
      status: leads.status,
      count: sql<number>`count(*)::int`,
    })
    .from(leads)
    .groupBy(leads.status);

  const leadByStatus: Record<string, number> = {
    new: 0, priority: 0, urgency: 0, attending: 0, converted: 0, lost: 0,
  };
  for (const r of leadCounts) leadByStatus[r.status] = r.count;
  const totalLeads = Object.values(leadByStatus).reduce((a, b) => a + b, 0);

  // Convertidos cumulativo (histórico) — independente de status atual. Lead
  // convertido e reaberto continua contando aqui. É essa métrica que reflete
  // "quantos atendentes converteram" pro ranking/dashboard, não a coluna do
  // kanban (que decrementa em reaberturas).
  const [{ count: convertedAllTime }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leads)
    .where(sql`${leads.convertedAt} IS NOT NULL`);

  // Convertidos hoje — sem condicionar status='converted'. Lead pode ter
  // convertido 09h e voltado pra attending às 14h: continua contando como
  // "convertido hoje" no painel.
  const [{ count: convertedToday }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leads)
    .where(gte(leads.convertedAt, startOfDay));

  // ── Contagens POR PERÍODO (respondem ao seletor de datas) ──
  const [{ count: leadsInRange }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(gte(leads.createdAt, rangeStart), lte(leads.createdAt, rangeEnd)));

  const [{ count: convertedInRange }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(gte(leads.convertedAt, rangeStart), lte(leads.convertedAt, rangeEnd)));

  // Mensagens hoje (in/out) — filtra só por timestamp.
  const msgsToday = await db
    .select({
      direction: messages.direction,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .where(gte(messages.timestamp, startOfDay))
    .groupBy(messages.direction);
  const inboundToday = msgsToday.find(m => m.direction === 'inbound')?.count ?? 0;
  const outboundToday = msgsToday.find(m => m.direction === 'outbound')?.count ?? 0;

  // Pessoas (leads únicos) atendidas hoje — DISTINCT lead_id em messages com
  // sender IN ('human','ai') AND timestamp >= startOfDay. É o KPI principal
  // que vai pro card "Pessoas atendidas hoje" — o volume bruto de mensagens
  // (today) gerava confusão na análise (cliente pediu em 09/06).
  const [att] = await db
    .select({ count: sql<number>`count(distinct ${messages.leadId})::int` })
    .from(messages)
    .where(and(
      gte(messages.timestamp, startOfDay),
      // 'owner' entra junto: é o atendente respondendo PELO CELULAR, no número
      // compartilhado, sem autoria. Deixá-lo de fora subcontava brutalmente
      // quando boa parte do time trabalha assim.
      inArray(messages.sender, ['human', 'ai', 'owner']),
    ));
  const peopleAttendedToday = att?.count ?? 0;
  const [msgd] = await db
    .select({ count: sql<number>`count(distinct ${messages.leadId})::int` })
    .from(messages)
    .where(and(gte(messages.timestamp, startOfDay), eq(messages.sender, 'lead')));
  const peopleMessagedToday = msgd?.count ?? 0;

  // Connections
  const connCounts = await db
    .select({
      status: connections.status,
      count: sql<number>`count(*)::int`,
    })
    .from(connections)
    .groupBy(connections.status);
  const connConnected = connCounts.find(c => c.status === 'connected')?.count ?? 0;
  const totalConn = connCounts.reduce((a, c) => a + c.count, 0);

  const stats: DashboardStats = {
    leads: {
      total: totalLeads,
      new: leadByStatus.new,
      priority: leadByStatus.priority,
      urgency: leadByStatus.urgency,
      attending: leadByStatus.attending,
      converted: leadByStatus.converted,
      convertedAllTime,
      lost: leadByStatus.lost,
      convertedToday,
      leadsInRange,
      convertedInRange,
    },
    messages: {
      today: inboundToday + outboundToday,
      inboundToday,
      outboundToday,
      peopleAttendedToday,
      peopleMessagedToday,
    },
    connections: {
      total: totalConn,
      connected: connConnected,
      disconnected: totalConn - connConnected,
    },
    generatedAt: new Date(),
  };

  return NextResponse.json(stats);
}
