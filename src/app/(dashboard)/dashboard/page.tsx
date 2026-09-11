'use client';

import { useEffect, useState } from 'react';
import type { DashboardStats } from '@/app/api/dashboard/stats/route';
import type { ChannelStats } from '@/app/api/dashboard/channels/route';
import type { TimelinePoint } from '@/app/api/dashboard/timeline/route';
import type { HourlyPoint } from '@/app/api/dashboard/hourly/route';
import type { AttendantStats } from '@/app/api/dashboard/attendants/route';
import type { AtendimentoRow, AtendimentoCounts, AtendimentoResponse } from '@/app/api/dashboard/atendimentos/route';
import type { ConvertedRow } from '@/app/api/dashboard/converted/route';
import LeadModal from '@/components/crm/LeadModal';
import {
  LayoutDashboard,
  Users,
  MessageSquare,
  CircleCheckBig,
  Target,
  TrendingDown,
  Trophy,
  ListFilter,
  ChartColumn,
  Radio,
  Inbox,
  Medal,
  ArrowUpDown,
} from 'lucide-react';
import DateRangePicker, { rangeFromPreset, toIsoDate, type DateRange } from '@/components/DateRangePicker';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';
import { useDados } from '@/lib/useDados';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import KpiCard from '@/components/KpiCard';
import StatusBadge from '@/components/StatusBadge';
import Loading from '@/components/Loading';
import {
  DASHBOARD_ANALYTICS_POLL_MS,
  DASHBOARD_LIVE_POLL_MS,
  dashboardQueryActivity,
  type DashboardTab,
} from '@/modules/dashboard/polling-policy';

export default function DashboardPage() {
  const [tab, setTab] = useState<DashboardTab>('geral');
  const [range, setRange] = useState<DateRange>(() => rangeFromPreset('last30'));

  // Cache entre telas: ver `lib/useDados.ts`. Voltar para a dashboard pinta na
  // hora com o que já foi buscado e revalida por baixo, em vez de branco →
  // spinner → dados a cada navegação. O polling de 10s continua, mas só
  // enquanto a aba está visível.
  const qs = `?from=${toIsoDate(range.from)}&to=${toIsoDate(range.to)}`;
  const queryActivity = dashboardQueryActivity(tab);
  const { dado: statsResp } = useDados<DashboardStats>(`/api/dashboard/stats${qs}`, {
    intervalo: DASHBOARD_LIVE_POLL_MS,
  });
  // Os quatro recebem o MESMO período: antes channels e hourly eram fixos e
  // ficavam parados enquanto o resto respondia ao seletor — o gráfico
  // contradizia o KPI ao lado.
  const { dado: channelsResp } = useDados<{ channels: ChannelStats[] }>(`/api/dashboard/channels${qs}`, {
    intervalo: DASHBOARD_ANALYTICS_POLL_MS,
    ativo: queryActivity.channels,
  });
  const { dado: timelineResp } = useDados<{ points: TimelinePoint[] }>(`/api/dashboard/timeline${qs}`, {
    intervalo: DASHBOARD_ANALYTICS_POLL_MS,
    ativo: queryActivity.timeline,
  });
  const { dado: hourlyResp } = useDados<{ points: HourlyPoint[] }>(`/api/dashboard/hourly${qs}`, {
    intervalo: DASHBOARD_ANALYTICS_POLL_MS,
    ativo: queryActivity.hourly,
  });

  const stats = statsResp;
  const channels = channelsResp?.channels ?? [];
  const timeline = timelineResp?.points ?? [];
  const hourly = hourlyResp?.points ?? [];

  const totalLeads = stats?.leads.total ?? 0;
  const emAtendimento = (stats?.leads.attending ?? 0) + (stats?.leads.priority ?? 0) + (stats?.leads.urgency ?? 0);
  // KPIs que RESPONDEM ao seletor de datas: leads que entraram (created_at) e
  // que converteram (converted_at) DENTRO do período. Antes os cards mostravam
  // o acumulado all-time e não mexiam com o filtro — "filtrei e não filtrou".
  const leadsPeriodo = stats?.leads.leadsInRange ?? 0;
  const concluidos = stats?.leads.convertedInRange ?? 0;
  const convertedToday = stats?.leads.convertedToday ?? 0;
  const perdidos = stats?.leads.lost ?? 0;
  const taxaConv = leadsPeriodo > 0 ? Math.round((concluidos / leadsPeriodo) * 100) : 0;
  // KPI antigo "msgsHoje" (volume bruto in+out) deprecated em 09/06 — cliente
  // pediu pra focar em pessoas, não volume. Header subtitle agora usa
  // peopleAttendedToday (leads únicos que o time atendeu hoje).
  const pessoasAtendidasHoje = stats?.messages.peopleAttendedToday ?? 0;
  const pessoasMandaramHoje = stats?.messages.peopleMessagedToday ?? 0;
  const connConn = stats?.connections.connected ?? 0;
  const connTotal = stats?.connections.total ?? 0;

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<LayoutDashboard size={18} strokeWidth={1.6} />}
        title="Dashboard"
        subtitle={
          stats
            ? `Live · ${pessoasAtendidasHoje} pessoa${pessoasAtendidasHoje === 1 ? '' : 's'} atendida${pessoasAtendidasHoje === 1 ? '' : 's'} hoje · ${connConn}/${connTotal} conexões ativas`
            // Idem: subtítulo vazio até o dado chegar, sem frase de espera.
            : ''
        }
        right={<DateRangePicker value={range} onChange={setRange} />}
      />

      <div className="px-3 py-4 md:px-6 md:py-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4 stagger">
          <KpiCard
            label="Leads no período"
            value={leadsPeriodo}
            hint={<span>entraram · <span className="text-text-primary">{totalLeads}</span> no total</span>}
            icon={<Users size={20} strokeWidth={1.6} />}
            accent="blue"
            delay={0}
          />
          <KpiCard
            label="Em Atendimento"
            value={emAtendimento}
            hint={totalLeads > 0 ? `${Math.round((emAtendimento / totalLeads) * 100)}% do total · agora` : 'agora'}
            icon={<MessageSquare size={20} strokeWidth={1.6} />}
            accent="blue"
            delay={100}
          />
          <KpiCard
            label="Convertidos no período"
            value={concluidos}
            hint={convertedToday > 0
              ? <span><span className="text-text-primary">{convertedToday}</span> hoje</span>
              : ''}
            icon={<CircleCheckBig size={20} strokeWidth={1.6} />}
            accent="green"
            delay={200}
          />
          <KpiCard
            label="Taxa de Conversão"
            value={taxaConv}
            suffix="%"
            hint={<span><span className="text-text-primary">{concluidos}</span> convertidos</span>}
            icon={<Target size={20} strokeWidth={1.6} />}
            accent="blue"
            delay={300}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 sm:mt-4 sm:gap-4 lg:grid-cols-4 stagger">
          <KpiCard
            label="Pessoas atendidas hoje"
            value={pessoasAtendidasHoje}
            hint={pessoasMandaramHoje > 0
              ? <span><span className="text-text-primary">{pessoasMandaramHoje}</span> mandaram mensagem</span>
              : 'leads únicos com resposta do time'}
            icon={<MessageSquare size={18} strokeWidth={1.6} />}
            accent="blue"
            size="sm"
            delay={350}
          />
          <KpiCard label="Conexões ativas" value={connConn} hint={`de ${connTotal}`} icon={<Users size={18} strokeWidth={1.6} />} accent="blue" size="sm" delay={400} />
          <KpiCard label="Leads perdidos" value={perdidos} icon={<TrendingDown size={18} strokeWidth={1.6} />} accent="red" size="sm" delay={450} />
        </div>

        <div className="mt-6 md:mt-8">
          <div
            className="sticky top-[56px] z-10 -mx-3 mb-4 flex gap-1 overflow-x-auto border-b px-3 md:top-[64px] md:-mx-6 md:mb-6 md:px-6"
            style={{
              background: 'rgba(9,9,11,0.85)',
              backdropFilter: 'blur(14px)',
              borderColor: 'var(--border-subtle)',
            }}
          >
            {(
              [
                { k: 'geral', label: 'Visão Geral', icon: ChartColumn },
                { k: 'canais', label: 'Canais', icon: Radio },
                { k: 'atendimentos', label: 'Atendimentos', icon: Inbox },
              ] as { k: DashboardTab; label: string; icon: typeof Users }[]
            ).map(({ k, label, icon: Icon }) => {
              const active = tab === k;
              return (
                <button
                  key={k}
                  onClick={() => setTab(k)}
                  className={`relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-[12px] font-medium transition-colors duration-150 sm:gap-2 sm:px-4 sm:py-3 sm:text-[13px] ${
                    active ? 'text-white' : 'text-text-muted hover:text-text-secondary'
                  }`}
                >
                  <Icon size={16} strokeWidth={1.6} className={active ? 'text-blue-mid' : ''} />
                  {label}
                  {active && (
                    <span
                      className="absolute -bottom-px left-2 right-2 h-[2px] rounded-full"
                      style={{ background: 'var(--accent-mid)', boxShadow: '0 0 8px rgba(var(--accent-mid-rgb),0.6)' }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          <div key={tab} className="animate-[fadeUp_250ms_ease-out]">
            {tab === 'geral' && <VisaoGeral timeline={timeline} hourly={hourly} channels={channels} totalLeads={totalLeads} converted={concluidos} range={range} />}
            {tab === 'canais' && <Canais channels={channels} />}
            {tab === 'atendimentos' && <Atendimentos />}
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed p-10 text-center text-[12.5px] text-text-muted"
      style={{ borderColor: 'var(--border-subtle)' }}>
      {children}
    </div>
  );
}

/* ---------- Tab: Visão Geral ---------- */

function rangeLabel(r: DateRange): string {
  if (r.preset === 'today') return 'Hoje';
  if (r.preset === 'yesterday') return 'Ontem';
  if (r.preset === 'last7') return 'Últimos 7 dias';
  if (r.preset === 'last30') return 'Últimos 30 dias';
  if (r.preset === 'last90') return 'Últimos 90 dias';
  if (r.preset === 'thisMonth') return 'Este mês';
  if (r.preset === 'lastMonth') return 'Mês passado';
  const f = `${String(r.from.getDate()).padStart(2, '0')}/${String(r.from.getMonth() + 1).padStart(2, '0')}`;
  const t = `${String(r.to.getDate()).padStart(2, '0')}/${String(r.to.getMonth() + 1).padStart(2, '0')}`;
  return `${f} → ${t}`;
}

function VisaoGeral({
  timeline, hourly, channels, totalLeads, converted, range,
}: {
  timeline: TimelinePoint[];
  hourly: HourlyPoint[];
  channels: ChannelStats[];
  totalLeads: number;
  converted: number;
  range: DateRange;
}) {
  const hasTimeline = timeline.some(p => p.total > 0);
  const hasHourly = hourly.some(p => p.v > 0);
  const hasChannels = channels.some(c => c.leads > 0);

  return (
    <div className="grid grid-cols-12 gap-4">
      <Card className="col-span-12" padding={20}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="section-label">Evolução de Leads</div>
            <div className="mt-1 text-[14px] font-semibold text-white">{rangeLabel(range)}</div>
          </div>
          <div className="flex items-center gap-4 text-[11px]">
            <Legend3 color="var(--accent-mid)" label="Total" />
            <Legend3 color="#1D4ED8" label="Concluídos" dash />
            <Legend3 color="var(--accent-light)" label="Em Atendimento" />
          </div>
        </div>
        <div style={{ height: 260 }}>
          {hasTimeline ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={timeline} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gTotal" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-mid)" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="var(--accent-mid)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gAt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent-light)" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="var(--accent-light)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: '#111116', border: '1px solid rgba(var(--accent-mid-rgb),0.2)',
                    borderRadius: 10, color: '#F8FAFC', fontSize: 12,
                  }}
                  cursor={{ stroke: 'rgba(var(--accent-mid-rgb),0.35)' }}
                />
                <Area type="monotone" dataKey="total" stroke="var(--accent-mid)" strokeWidth={2} fill="url(#gTotal)" animationDuration={900} />
                <Area type="monotone" dataKey="atendimento" stroke="var(--accent-light)" strokeWidth={1.5} fill="url(#gAt)" animationDuration={900} animationBegin={150} />
                <Area type="monotone" dataKey="concluidos" stroke="#1D4ED8" strokeWidth={2} fill="transparent" strokeDasharray="4 3" animationDuration={900} animationBegin={300} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState>Sem leads no período selecionado.</EmptyState>
          )}
        </div>
      </Card>

      <Card className="col-span-12 lg:col-span-7" padding={20}>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="section-label">Fluxo por Horário</div>
            <div className="mt-1 text-[14px] font-semibold text-white">Mensagens nas últimas 24h</div>
          </div>
        </div>
        <div style={{ height: 240 }}>
          {hasHourly ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourly} margin={{ top: 6, right: 6, left: -20, bottom: 0 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="hour" tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(var(--accent-mid-rgb),0.05)' }}
                  contentStyle={{ background: '#111116', border: '1px solid rgba(var(--accent-mid-rgb),0.2)', borderRadius: 10, color: '#F8FAFC', fontSize: 12 }} />
                <Bar dataKey="v" radius={[4, 4, 0, 0]} animationDuration={700}>
                  {hourly.map((d, i) => (
                    <Cell key={i} fill={d.v > 25 ? 'var(--accent-mid)' : d.v > 10 ? 'var(--accent)' : 'var(--accent-deep)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState>Sem mensagens nas últimas 24h.</EmptyState>
          )}
        </div>
      </Card>

      <Card className="col-span-12 lg:col-span-5" padding={20}>
        <div className="mb-4">
          <div className="section-label">Canais de Origem</div>
          <div className="mt-1 text-[14px] font-semibold text-white">Distribuição de leads</div>
        </div>
        <div className="relative" style={{ height: 220 }}>
          {hasChannels ? (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={channels}
                  dataKey="leads"
                  nameKey="name"
                  innerRadius={60}
                  outerRadius={90}
                  paddingAngle={2}
                  stroke="none"
                  animationDuration={800}
                >
                  {channels.map(c => <Cell key={c.id} fill={c.color} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#111116', border: '1px solid rgba(var(--accent-mid-rgb),0.2)', borderRadius: 10, color: '#F8FAFC', fontSize: 12 }} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState>Sem leads ainda.</EmptyState>
          )}
          {hasChannels && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div className="kpi-number text-white" style={{ fontSize: 26 }}>{totalLeads}</div>
              <div className="text-[11px] text-text-muted">leads totais</div>
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-1 gap-2">
          {channels.map(c => (
            <div key={c.id} className="flex items-center gap-3 text-[12px]">
              <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
              <span className="flex-1 text-text-secondary">{c.name}</span>
              <span className="text-text-primary">{c.leads}</span>
              <span className="w-10 text-right text-text-muted">{c.conversao}%</span>
            </div>
          ))}
        </div>
      </Card>

      <Card className="col-span-12" padding={0}>
        <ConvertidosSection totalCount={converted} />
      </Card>
    </div>
  );
}

const CANAIS_MAP: Record<string, { name: string; color: string }> = {
  whatsapp:  { name: 'WhatsApp',   color: '#22C55E' },
  instagram: { name: 'Instagram',  color: '#F472B6' },
  google:    { name: 'Google Ads', color: 'var(--accent-mid)' },
  manual:    { name: 'Manual',     color: '#94A3B8' },
};

function ConvertidosSection({ totalCount }: { totalCount: number }) {
  const [rows, setRows] = useState<ConvertedRow[] | null>(null);
  const [openLead, setOpenLead] = useState<string | null>(null);

  async function load() {
    const res = await fetch('/api/dashboard/converted?limit=50', { cache: 'no-store' });
    if (!res.ok) return;
    const j = (await res.json()) as { converted: ConvertedRow[] };
    setRows(j.converted);
  }

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      if (cancelled) return;
      await load();
    }
    poll();
    const id = setInterval(poll, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const novasMsgs = (rows ?? []).filter(r => r.hasNewInbound).length;

  return (
    <div>
      <div className="flex items-center justify-between px-5 py-4">
        <div>
          <div className="section-label">Leads convertidos</div>
          <div className="mt-1 flex items-center gap-2 text-[14px] font-semibold text-white">
            {totalCount} {totalCount === 1 ? 'conversão' : 'conversões'} no total
            {novasMsgs > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-semibold animate-pulse"
                style={{ background: 'rgba(248,113,113,0.15)', color: '#F87171', border: '1px solid rgba(248,113,113,0.35)' }}
                title={`${novasMsgs} cliente(s) convertido(s) voltaram a falar`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#F87171' }} />
                {novasMsgs} {novasMsgs === 1 ? 'voltou a falar' : 'voltaram a falar'}
              </span>
            )}
          </div>
        </div>
        <div className="text-[11px] text-text-muted">
          Reabrem automaticamente após 48h se mandarem mensagem · clique pra abrir
        </div>
      </div>
      {rows === null ? (
        <div className="px-5 pb-5"><Loading size="sm" /></div>
      ) : rows.length === 0 ? (
        <div className="px-5 pb-5 text-[12px] text-text-muted">Nenhuma conversão registrada ainda.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-y" style={{ borderColor: 'var(--border-subtle)', background: 'rgba(24,24,31,0.5)' }}>
                {['Lead', 'Convertido por', 'Canal', 'Conexão', 'Convertido em'].map(h => (
                  <th key={h} className="section-label px-5 py-3 text-[10.5px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const canal = CANAIS_MAP[r.channel] ?? CANAIS_MAP.manual;
                const accentColor = r.hasNewInbound ? '#F87171' : '#22C55E';
                return (
                  <tr key={r.id}
                    onClick={() => setOpenLead(r.id)}
                    className="group cursor-pointer border-b transition-colors hover:bg-[rgba(34,197,94,0.05)]"
                    style={{
                      borderColor: 'var(--border-subtle)',
                      background: r.hasNewInbound ? 'rgba(248,113,113,0.04)' : undefined,
                    }}
                  >
                    <td className="relative px-5 py-3">
                      <span
                        className="absolute left-0 top-0 h-full w-[2px] transition-transform duration-200 group-hover:scale-y-100"
                        style={{
                          background: accentColor,
                          transform: r.hasNewInbound ? 'scaleY(1)' : 'scaleY(0)',
                        }}
                      />
                      <div className="flex items-center gap-2">
                        <div className="text-[13px] font-medium text-text-primary">{r.name}</div>
                        {r.hasNewInbound && (
                          <span
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide"
                            style={{ background: 'rgba(248,113,113,0.18)', color: '#F87171', border: '1px solid rgba(248,113,113,0.4)' }}
                            title={r.lastInboundAfterConvertedAt ? `Última mensagem: ${new Date(r.lastInboundAfterConvertedAt).toLocaleString('pt-BR')}` : undefined}
                          >
                            <span className="h-1 w-1 rounded-full animate-pulse" style={{ background: '#F87171' }} />
                            Voltou a falar
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-text-muted">{r.phone}</div>
                    </td>
                    <td className="px-5 py-3 text-[12.5px] text-text-secondary">
                      {r.atendente ?? '—'}
                      {r.atendenteSource === 'last_human' && (
                        <span
                          className="ml-1.5 inline-flex items-center rounded px-1 py-0 text-[9px] font-medium"
                          style={{ background: 'rgba(var(--accent-light-rgb),0.12)', color: 'var(--accent-light)' }}
                          title="Convertido sem clicar 'Converti!' no CRM — esse foi o último humano que atendeu o lead."
                        >
                          via msg
                        </span>
                      )}
                      {r.reopened && (
                        <span
                          className="ml-1.5 inline-flex items-center rounded px-1 py-0 text-[9px] font-medium"
                          style={{ background: 'rgba(251,191,36,0.12)', color: '#FBBF24' }}
                          title="Lead foi reaberto depois — não está mais na coluna Convertidos do kanban."
                        >
                          reaberto
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <div className="inline-flex items-center gap-2 text-[12.5px] text-text-secondary">
                        <span className="h-2 w-2 rounded-full" style={{ background: canal.color }} />
                        {canal.name}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-[12.5px] text-text-secondary">{r.connectionName ?? '—'}</td>
                    <td className="px-5 py-3 text-[12.5px] text-text-muted tabular-nums">
                      {new Date(r.convertedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openLead && (
        <LeadModal
          leadId={openLead}
          onClose={() => setOpenLead(null)}
          onChange={() => void load()}
        />
      )}
    </div>
  );
}

function Legend3({ color, label, dash }: { color: string; label: string; dash?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 text-text-secondary">
      <span
        className="inline-block h-[3px] w-4 rounded-sm"
        style={{ background: dash ? `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px)` : color }}
      />
      {label}
    </div>
  );
}

function Avatar({ a, size = 28 }: { a: { initials: string; color: string }; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size, height: size, background: `${a.color}33`, color: a.color,
        border: `1px solid ${a.color}55`, fontSize: size * 0.38,
      }}
    >
      {a.initials}
    </div>
  );
}

/* ---------- Tab: Canais ---------- */

function Canais({ channels }: { channels: ChannelStats[] }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 stagger">
        {channels.map(c => (
          <Card key={c.id} padding={20} interactive>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />
                <span className="text-[14px] font-semibold text-text-primary">{c.name}</span>
              </div>
              <span className="kpi-number text-blue-light" style={{ fontSize: 18 }}>{c.conversao}%</span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className="kpi-number" style={{ fontSize: 22 }}>{c.leads}</span>
              <span className="text-[11px] text-text-muted">leads totais</span>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full" style={{ background: '#18181F' }}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${c.conversao}%`,
                  background: `linear-gradient(90deg, #1D4ED8, ${c.color})`,
                  transition: 'width 1000ms ease-out',
                }}
              />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <Mini label="Novos" value={c.novos} tone="blue" />
              <Mini label="Atend." value={c.atendendo} tone="amber" />
              <Mini label="Conv." value={c.convertidos} tone="green" />
            </div>
          </Card>
        ))}
      </div>

      <Card padding={20}>
        <div className="mb-4">
          <div className="section-label">Comparativo por Canal</div>
          <div className="mt-1 text-[14px] font-semibold text-white">Novos · Atendendo · Convertidos</div>
        </div>
        <div style={{ height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={channels} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="name" tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#64748B', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip cursor={{ fill: 'rgba(var(--accent-mid-rgb),0.05)' }}
                contentStyle={{ background: '#111116', border: '1px solid rgba(var(--accent-mid-rgb),0.2)', borderRadius: 10, color: '#F8FAFC', fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11, color: '#94A3B8' }} iconType="circle" />
              <Bar dataKey="novos" name="Novos" fill="var(--accent-mid)" radius={[4,4,0,0]} animationDuration={700} />
              <Bar dataKey="atendendo" name="Atendendo" fill="#1D4ED8" radius={[4,4,0,0]} animationDuration={700} animationBegin={100} />
              <Bar dataKey="convertidos" name="Convertidos" fill="var(--accent-light)" radius={[4,4,0,0]} animationDuration={700} animationBegin={200} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card padding={20}>
        <div className="mb-4">
          <div className="section-label">Taxa de Conversão por Canal</div>
        </div>
        <div className="flex flex-col gap-3">
          {channels.map(c => (
            <div key={c.id} className="grid grid-cols-[90px_1fr_42px] items-center gap-3 md:grid-cols-[130px_1fr_50px] md:gap-4">
              <span className="text-[12.5px] text-text-secondary">{c.name}</span>
              <div className="relative h-3 overflow-hidden rounded-full" style={{ background: '#18181F' }}>
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${c.conversao}%`,
                    background: 'linear-gradient(90deg, var(--accent-deep) 0%, var(--accent-mid) 100%)',
                    transition: 'width 1100ms ease-out',
                  }}
                />
              </div>
              <span className="text-right text-[12.5px] text-text-primary tabular-nums">{c.conversao}%</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Mini({ label, value, tone }: { label: string; value: number; tone: 'blue' | 'amber' | 'green' }) {
  const color = tone === 'blue' ? 'var(--accent-light)' : tone === 'amber' ? '#FBBF24' : '#4ADE80';
  return (
    <div
      className="rounded-lg py-2"
      style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
      <div className="mt-0.5 text-[13px] font-semibold tabular-nums" style={{ color }}>{value}</div>
    </div>
  );
}

/* ---------- Tab: Atendimentos ---------- */

function Atendimentos() {
  const [rows, setRows] = useState<AtendimentoRow[] | null>(null);
  // Contadores GLOBAIS da unit (vindos do endpoint, não derivados dos 50
  // listados). Sem isso os chips de filtro divergiam dos KPIs da Visão Geral.
  const [counts, setCounts] = useState<AtendimentoCounts>({ todos: 0, novo: 0, atendimento: 0, concluido: 0, perdido: 0 });
  const [filter, setFilter] = useState<'todos' | 'novo' | 'atendimento' | 'concluido' | 'perdido'>('todos');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch('/api/dashboard/atendimentos', { cache: 'no-store' });
      if (!res.ok) return;
      const j = (await res.json()) as AtendimentoResponse;
      if (!cancelled) {
        setRows(j.atendimentos);
        setCounts(j.counts);
      }
    }
    load();
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (rows === null) {
    return <EmptyState><Loading size="sm" /></EmptyState>;
  }
  if (counts.todos === 0) {
    return <EmptyState>Sem atendimentos ainda.</EmptyState>;
  }
  const filters = [
    { k: 'todos', label: 'Todos', count: counts.todos },
    { k: 'novo', label: 'Novos', count: counts.novo },
    { k: 'atendimento', label: 'Em Atendimento', count: counts.atendimento },
    { k: 'concluido', label: 'Concluídos', count: counts.concluido },
    { k: 'perdido', label: 'Perdidos', count: counts.perdido },
  ] as const;
  const visible = filter === 'todos' ? rows : rows.filter(r => r.status === filter);

  return (
    <div className="flex flex-col gap-4">
      <Card padding={14}>
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-2 pl-1 text-[12px] text-text-muted">
            <ListFilter size={14} strokeWidth={1.6} />
            Filtrar:
          </span>
          <div className="flex flex-wrap gap-2">
            {filters.map(f => {
              const active = filter === f.k;
              return (
                <button
                  key={f.k}
                  onClick={() => setFilter(f.k)}
                  className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] transition-all duration-150 ${
                    active ? 'text-white' : 'text-text-muted hover:text-text-secondary'
                  }`}
                  style={
                    active
                      ? { background: 'var(--accent)', boxShadow: '0 0 12px rgba(var(--accent-mid-rgb),0.35)' }
                      : { background: '#18181F', border: '1px solid rgba(255,255,255,0.04)' }
                  }
                >
                  {f.label}
                  <span className="rounded-md px-1.5 text-[10px] tabular-nums" style={active ? { background: 'rgba(255,255,255,0.18)' } : { background: 'rgba(255,255,255,0.05)' }}>
                    {f.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </Card>

      <Card padding={0}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b" style={{ borderColor: 'var(--border-subtle)', background: 'rgba(24,24,31,0.5)' }}>
                {['Lead', 'Status', 'Atendente', 'Canal', 'Duração', 'Data'].map(h => (
                  <th key={h} className="section-label px-5 py-3 text-[10.5px]">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id}
                  className="group border-b transition-colors hover:bg-[rgba(var(--accent-mid-rgb),0.05)]"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <td className="relative px-5 py-3">
                    <span className="absolute left-0 top-0 h-full w-[2px] scale-y-0 bg-blue-mid transition-transform duration-200 group-hover:scale-y-100" />
                    <div className="text-[13px] font-medium text-text-primary">{r.lead}</div>
                    <div className="text-[11px] text-text-muted">{r.phone}</div>
                  </td>
                  <td className="px-5 py-3">
                    <StatusBadge variant={r.status}>
                      {r.status === 'novo' ? 'Novo' : r.status === 'atendimento' ? 'Em Atend.' : r.status === 'concluido' ? 'Concluído' : 'Perdido'}
                    </StatusBadge>
                  </td>
                  <td className="px-5 py-3 text-[12.5px] text-text-secondary">{r.atendente ?? '—'}</td>
                  <td className="px-5 py-3">
                    <div className="inline-flex items-center gap-2 text-[12.5px] text-text-secondary">
                      <span className="h-2 w-2 rounded-full" style={{ background: r.canal.color }} />
                      {r.canal.name}
                    </div>
                  </td>
                  <td className="px-5 py-3 text-[12.5px] text-text-secondary tabular-nums">{r.duracao}</td>
                  <td className="px-5 py-3 text-[12.5px] text-text-muted tabular-nums">{r.data}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between px-5 py-3 text-[11.5px] text-text-muted">
          <span>Subtotal: {visible.length} de {rows.length} atendimentos</span>
        </div>
      </Card>
    </div>
  );
}
