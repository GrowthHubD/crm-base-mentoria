'use client';

/**
 * /ranking — ranking GLOBAL de atendentes da rede (cross-unit, sempre agregado).
 *
 * Mesmo quando o admin tem unit ativa selecionada, esta página ignora —
 * ranking é "olhar geral da rede". Visível a TODOS os roles (atendente
 * comum também vê — é o jeito de competir).
 *
 * Layout:
 *  1. Pódio Top 3 — medalhas + métricas resumidas.
 *  2. Ranking de Conversões — lista linear ordenada por conversões com barra
 *     na cor do avatar do atendente.
 *  3. Todos os Atendentes — tabela ordenável por atendimentos, conversões,
 *     taxa ou tempo médio de atendimento (asc/desc clicando no header).
 */
import { useEffect, useMemo, useState } from 'react';
import { Trophy, Medal, Clock, ArrowUp, ArrowDown, ArrowUpDown, Star } from 'lucide-react';
import { useDados } from '@/lib/useDados';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import type { RankingAttendant, RankingBadge } from '@/app/api/ranking/route';
import Loading from '@/components/Loading';

type SortKey = 'atendimentos' | 'conversoes' | 'taxa' | 'tempoMedio';
type SortDir = 'asc' | 'desc';

const BADGE_STYLE: Record<RankingBadge, { bg: string; border: string; color: string }> = {
  Top:     { bg: 'rgba(168,85,247,0.12)',  border: 'rgba(168,85,247,0.45)',  color: '#C084FC' },
  Bom:     { bg: 'rgba(var(--accent-light-rgb),0.12)',  border: 'rgba(var(--accent-light-rgb),0.45)',  color: 'var(--accent-light)' },
  Regular: { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.35)', color: '#94A3B8' },
};

function formatTime(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

export default function RankingPage() {
  const [sortKey, setSortKey] = useState<SortKey>('conversoes');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Cache entre telas — ver `lib/useDados.ts`. Voltar ao ranking pinta na hora
  // com a última leitura e revalida por baixo.
  const { dado } = useDados<{ attendants: RankingAttendant[] }>('/api/ranking', { intervalo: 20_000 });
  const data = dado?.attendants ?? null;

  const sorted = useMemo(() => {
    if (!data) return [];
    const cp = [...data];
    const mul = sortDir === 'asc' ? 1 : -1;
    cp.sort((a, b) => {
      let av: number, bv: number;
      switch (sortKey) {
        case 'atendimentos': av = a.atendimentos; bv = b.atendimentos; break;
        case 'conversoes':   av = a.conversoes;   bv = b.conversoes;   break;
        case 'taxa':         av = a.taxa;         bv = b.taxa;         break;
        case 'tempoMedio':
          // null vai pro fim em qualquer direção (tratamos como Infinity).
          av = a.tempoMedioMin ?? Number.POSITIVE_INFINITY;
          bv = b.tempoMedioMin ?? Number.POSITIVE_INFINITY;
          break;
      }
      return (av - bv) * mul;
    });
    return cp;
  }, [data, sortKey, sortDir]);

  function toggleSort(k: SortKey) {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      // Defaults intuitivos: contagens/taxa desc (maior primeiro); tempo asc (menor é melhor).
      setSortDir(k === 'tempoMedio' ? 'asc' : 'desc');
    }
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<Trophy size={18} strokeWidth={1.6} />}
        title="Ranking de atendentes"
        subtitle="Visão geral da rede — agrega todas as unidades, sempre live"
      />

      <div className="px-3 py-4 md:px-6 md:py-6">
        {data === null && (
          <Card padding={20}><Loading size="sm" /></Card>
        )}
        {data?.length === 0 && (
          <Card padding={20}><div className="text-[12.5px] text-text-muted">Sem dados de atendentes ainda.</div></Card>
        )}

        {data && data.length > 0 && (
          <div className="flex flex-col gap-5">
            {/* Pódio Top 5 — antes era top 3 mas cliente reclamou que parecia
                "limite". Aumentado pra dar mais visibilidade ao time todo. */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
              {data.slice(0, 5).map((a, i) => (
                <PodiumCard key={a.id} a={a} rank={i + 1} attendantsForScale={data} />
              ))}
            </div>

            {/* Ranking de Conversões */}
            <Card padding={20}>
              <div className="mb-4 flex items-center gap-2">
                <Trophy size={16} strokeWidth={1.6} style={{ color: '#FBBF24' }} />
                <span className="text-[14px] font-semibold text-white">Ranking de Conversões</span>
              </div>
              <div className="flex flex-col gap-2">
                {data.map((a, i) => {
                  const maxConv = Math.max(...data.map(x => x.conversoes), 1);
                  const pct = (a.conversoes / maxConv) * 100;
                  return (
                    <div
                      key={a.id}
                      className="grid items-center gap-3 rounded-lg py-1.5 grid-cols-[24px_1fr_60px] md:grid-cols-[28px_180px_1fr_70px_50px] md:gap-4"
                    >
                      <div className="text-[11.5px] text-text-muted tabular-nums md:text-[12px]">{i + 1}</div>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <AvatarPill a={a} size={28} />
                        <div className="truncate text-[13px] text-text-primary">{a.name}</div>
                      </div>
                      <div className="relative hidden h-2 overflow-hidden rounded-full md:block" style={{ background: '#18181F' }}>
                        <div
                          className="absolute inset-y-0 left-0 rounded-full"
                          style={{
                            width: `${pct}%`,
                            background: a.color,
                            transition: 'width 900ms ease-out',
                          }}
                        />
                      </div>
                      <div className="text-right text-[12px] tabular-nums md:text-left" style={{ color: '#4ADE80' }}>
                        {a.conversoes} conv.
                      </div>
                      <div className="text-right text-[12px] tabular-nums" style={{ color: '#4ADE80' }}>
                        {a.taxa}%
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Tabela completa */}
            <Card padding={0}>
              <div className="flex items-center justify-between px-5 py-4">
                <div className="text-[14px] font-semibold text-white">Todos os Atendentes</div>
                <div className="text-[11px] text-text-muted">Clique nas colunas para ordenar</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-y" style={{ borderColor: 'var(--border-subtle)', background: 'rgba(24,24,31,0.5)' }}>
                      <Th>#</Th>
                      <Th>Atendente</Th>
                      <ThSort label="Atendimentos" active={sortKey === 'atendimentos'} dir={sortDir} onClick={() => toggleSort('atendimentos')} />
                      <ThSort label="Conversões" active={sortKey === 'conversoes'} dir={sortDir} onClick={() => toggleSort('conversoes')} />
                      <ThSort label="Taxa Conv." active={sortKey === 'taxa'} dir={sortDir} onClick={() => toggleSort('taxa')} />
                      <ThSort label="Tempo Atend." active={sortKey === 'tempoMedio'} dir={sortDir} onClick={() => toggleSort('tempoMedio')} />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((a, i) => (
                      <tr
                        key={a.id}
                        className="group border-b transition-colors hover:bg-[rgba(var(--accent-mid-rgb),0.05)]"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <td className="px-5 py-3 text-[12px] text-text-muted tabular-nums">{i + 1}</td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <AvatarPill a={a} size={32} />
                            <div>
                              <div className="text-[13px] font-medium text-text-primary">{a.name}</div>
                              <div className="mt-0.5">
                                <BadgePill badge={a.badge} />
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-[13px] font-semibold text-text-primary tabular-nums">{a.atendimentos}</td>
                        <td className="px-5 py-3 text-[13px] tabular-nums" style={{ color: '#4ADE80' }}>{a.conversoes}</td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <div className="hidden h-1.5 w-16 overflow-hidden rounded-full md:block" style={{ background: '#18181F' }}>
                              <div
                                className="h-full"
                                style={{ width: `${a.taxa}%`, background: a.color }}
                              />
                            </div>
                            <span className="text-[12.5px] tabular-nums" style={{ color: '#4ADE80' }}>{a.taxa}%</span>
                          </div>
                        </td>
                        <td className="px-5 py-3 text-[13px] tabular-nums" style={{ color: 'var(--accent-light)' }}>
                          {formatTime(a.tempoMedioMin)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function PodiumCard({
  a, rank, attendantsForScale,
}: {
  a: RankingAttendant;
  rank: number;
  attendantsForScale: RankingAttendant[];
}) {
  const maxConv = Math.max(...attendantsForScale.map(x => x.conversoes), 1);
  const pct = (a.conversoes / maxConv) * 100;
  const medalColor = rank === 1 ? '#FBBF24' : rank === 2 ? '#94A3B8' : '#D97706';

  return (
    <Card padding={20}>
      <div className="mb-3 flex items-start justify-between">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ background: `${medalColor}22`, color: medalColor }}
        >
          <Medal size={18} strokeWidth={1.6} />
          <span className="ml-1 text-[10px] font-bold">{rank}</span>
        </div>
        <BadgePill badge={a.badge} />
      </div>
      <div className="flex items-center gap-3">
        <AvatarPill a={a} size={44} />
        <div>
          <div className="text-[14px] font-semibold text-text-primary">{a.name}</div>
          <div className="text-[11.5px] text-text-muted">{a.atendimentos} atendimentos</div>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-lg p-2.5" style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted">
            <Clock size={10} /> Tempo Atend.
          </div>
          <div className="mt-0.5 text-[14px] font-semibold" style={{ color: 'var(--accent-light)' }}>
            {formatTime(a.tempoMedioMin)}
          </div>
        </div>
        <div className="rounded-lg p-2.5" style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Conversões</div>
          <div className="mt-0.5 text-[14px] font-semibold" style={{ color: '#4ADE80' }}>
            {a.conversoes}
          </div>
        </div>
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-text-muted">Taxa</span>
          <span style={{ color: '#4ADE80' }}>{a.taxa}%</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full" style={{ background: '#18181F' }}>
          <div
            className="h-full rounded-full"
            style={{
              width: `${pct}%`,
              background: a.color,
              transition: 'width 1000ms ease-out',
            }}
          />
        </div>
      </div>
    </Card>
  );
}

function AvatarPill({
  a, size = 28,
}: {
  a: { initials: string; color: string };
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        background: `${a.color}1F`,
        color: a.color,
        border: `1px solid ${a.color}66`,
        fontSize: Math.round(size * 0.36),
      }}
    >
      {a.initials}
    </div>
  );
}

function BadgePill({ badge }: { badge: RankingBadge }) {
  const s = BADGE_STYLE[badge];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
      style={{ background: s.bg, border: `1px solid ${s.border}`, color: s.color }}
    >
      <Star size={9} strokeWidth={2} />
      {badge}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="section-label px-5 py-3 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted">
      {children}
    </th>
  );
}

function ThSort({
  label, active, dir, onClick,
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
}) {
  return (
    <th
      onClick={onClick}
      className="cursor-pointer select-none px-5 py-3 text-[10.5px] font-semibold uppercase tracking-wider text-text-muted hover:text-text-secondary"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active
          ? (dir === 'asc'
              ? <ArrowUp size={11} strokeWidth={2} />
              : <ArrowDown size={11} strokeWidth={2} />)
          : <ArrowUpDown size={11} strokeWidth={1.6} className="opacity-50" />}
      </span>
    </th>
  );
}
