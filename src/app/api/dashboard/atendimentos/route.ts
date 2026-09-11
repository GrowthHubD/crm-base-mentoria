/**
 * GET /api/dashboard/atendimentos — últimos atendimentos pra dashboard.
 *
 * Devolve até 50 leads ordenados por última atividade (`rows`) E os contadores
 * agregados (`counts`) calculados sobre TODOS os leads da unit — NÃO apenas
 * os 50 listados. Sem isso, os chips de filtro divergiam dos KPIs da Visão
 * Geral quando a unit tinha > 50 leads (incidente reportado pelo cliente em
 * 09/06: "soma de leads Em Atendimento diverge").
 *
 * Status fica em vocabulário do produto (`novo`/`atendimento`/`concluido`/
 * `perdido`) pra UI manter os 4 filtros canônicos. Duração = lastMessageAt −
 * createdAt quando disponível.
 */
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { users } from '@/lib/db/schema/users';
import { messages } from '@/lib/db/schema/messages';
import { eq, desc, inArray, and, sql } from 'drizzle-orm';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';

export interface AtendimentoRow {
  id: string;
  lead: string;
  phone: string;
  status: 'novo' | 'atendimento' | 'concluido' | 'perdido';
  atendente: string | null;
  canal: { name: string; color: string };
  etiqueta: string;
  duracao: string;
  data: string;
}

export interface AtendimentoCounts {
  todos: number;
  novo: number;
  atendimento: number;
  concluido: number;
  perdido: number;
}

export interface AtendimentoResponse {
  atendimentos: AtendimentoRow[];
  /** Contadores GLOBAIS da unit (não apenas dos 50 listados). É essa fonte
   *  que alimenta os chips de filtro — bate com o KPI da Visão Geral. */
  counts: AtendimentoCounts;
}

const CANAIS: Record<string, { name: string; color: string }> = {
  whatsapp:  { name: 'WhatsApp',   color: '#22C55E' },
  instagram: { name: 'Instagram',  color: '#F472B6' },
  google:    { name: 'Google Ads', color: '#9154FF' },
  manual:    { name: 'Manual',     color: '#94A3B8' },
};

function statusUI(s: string): AtendimentoRow['status'] {
  if (s === 'converted') return 'concluido';
  if (s === 'lost') return 'perdido';
  if (s === 'new') return 'novo';
  return 'atendimento';
}

function formatDuration(start: Date, end: Date | null): string {
  if (!end) return '—';
  const mins = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60_000));
  if (mins < 60) return `${mins}min`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}min`;
}

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm} ${hh}:${min}`;
}

const EMPTY_COUNTS: AtendimentoCounts = { todos: 0, novo: 0, atendimento: 0, concluido: 0, perdido: 0 };

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  // Contadores GLOBAIS — agrupados por status, sobre TODOS os leads.
  // Mesma fonte que stats route.ts usa pra montar o KPI "Em Atendimento" da
  // Visão Geral, mas remapeada pro vocabulário UI (novo/atendimento/concluido/
  // perdido). Sem o agregado aqui, os chips de filtro divergiam dos KPIs.
  const statusCounts = await db
    .select({ status: leads.status, count: sql<number>`count(*)::int` })
    .from(leads)
    .groupBy(leads.status);
  const counts: AtendimentoCounts = { ...EMPTY_COUNTS };
  for (const r of statusCounts) {
    counts.todos += r.count;
    counts[statusUI(r.status)] += r.count;
  }

  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      channel: leads.channel,
      status: leads.status,
      assignedName: users.name,
      createdAt: leads.createdAt,
      lastMessageAt: leads.lastMessageAt,
    })
    .from(leads)
    .leftJoin(users, eq(leads.assignedToId, users.id))
    .orderBy(desc(leads.lastMessageAt))
    .limit(50);

  // Coluna ATENDENTE no Kanban e aqui usa o critério "último humano que
  // respondeu" — não o assignedToId (que só é setado se atendente explicita
  // assumir, raro). Busca mais recente sender='human' em messages.
  const leadIds = rows.map(r => r.id);
  const lastHumanByLead = new Map<string, string>();
  if (leadIds.length > 0) {
    const ranked = await db
      .select({
        leadId: messages.leadId,
        senderName: messages.senderName,
        userName: users.name,
        rn: sql<number>`row_number() over (partition by ${messages.leadId} order by ${messages.timestamp} desc)`.as('rn'),
      })
      .from(messages)
      .leftJoin(users, eq(messages.sentById, users.id))
      .where(and(inArray(messages.leadId, leadIds), eq(messages.sender, 'human')));
    for (const r of ranked) {
      if (Number(r.rn) !== 1) continue;
      const name = (r.senderName ?? r.userName ?? '').trim();
      if (name) lastHumanByLead.set(r.leadId, name);
    }
  }

  const data: AtendimentoRow[] = rows.map(r => ({
    id: r.id,
    lead: r.name ?? 'Sem nome',
    phone: r.phone ?? '—',
    status: statusUI(r.status),
    // Prioriza último humano que respondeu (consistente com Kanban). Se nenhum
    // humano falou (lead só recebeu IA), cai no assignedToId — geralmente null.
    atendente: lastHumanByLead.get(r.id) ?? r.assignedName,
    canal: CANAIS[r.channel] ?? CANAIS.manual,
    etiqueta: '—',
    duracao: formatDuration(r.createdAt, r.lastMessageAt ?? null),
    data: formatDate(r.lastMessageAt ?? r.createdAt),
  }));

  return NextResponse.json<AtendimentoResponse>({ atendimentos: data, counts });
}
