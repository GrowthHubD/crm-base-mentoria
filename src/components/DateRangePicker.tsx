'use client';

/**
 * Date Range Picker do dashboard. Popup com:
 *   - Sidebar de presets (Hoje, Ontem, Últimos 7/30/90 dias, Este mês, Mês passado)
 *   - Dois meses em grid lado-a-lado (1 no mobile)
 *   - Seleção em dois cliques: 1º = from, 2º = to (aplica e fecha)
 *
 * Sem dependência externa de calendar — Date API nativa. Datas trafegam como
 * Date local (00:00 cliente). O caller converte pra ISO `YYYY-MM-DD` quando
 * mandar pro backend (a serialização tá em `toIsoDate` exportado).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';

export interface DateRange {
  from: Date;
  to: Date;
  /** Identifica o preset que originou o range (undefined = custom). */
  preset?: PresetKey;
}

export type PresetKey =
  | 'today'
  | 'yesterday'
  | 'last7'
  | 'last30'
  | 'last90'
  | 'thisMonth'
  | 'lastMonth';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Hoje' },
  { key: 'yesterday', label: 'Ontem' },
  { key: 'last7', label: 'Últimos 7 dias' },
  { key: 'last30', label: 'Últimos 30 dias' },
  { key: 'last90', label: 'Últimos 90 dias' },
  { key: 'thisMonth', label: 'Este mês' },
  { key: 'lastMonth', label: 'Mês passado' },
];

const MONTH_NAMES = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];
const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

function inRange(d: Date, from: Date, to: Date): boolean {
  const t = startOfDay(d).getTime();
  return t >= startOfDay(from).getTime() && t <= startOfDay(to).getTime();
}

/** Converte Date local → "YYYY-MM-DD" sem timezone shift. */
export function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function rangeFromPreset(key: PresetKey, today: Date = new Date()): DateRange {
  const t = startOfDay(today);
  switch (key) {
    case 'today':
      return { from: t, to: t, preset: 'today' };
    case 'yesterday': {
      const y = addDays(t, -1);
      return { from: y, to: y, preset: 'yesterday' };
    }
    case 'last7':
      return { from: addDays(t, -6), to: t, preset: 'last7' };
    case 'last30':
      return { from: addDays(t, -29), to: t, preset: 'last30' };
    case 'last90':
      return { from: addDays(t, -89), to: t, preset: 'last90' };
    case 'thisMonth': {
      const from = new Date(t.getFullYear(), t.getMonth(), 1);
      return { from, to: t, preset: 'thisMonth' };
    }
    case 'lastMonth': {
      const from = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const to = new Date(t.getFullYear(), t.getMonth(), 0); // último dia do mês anterior
      return { from, to, preset: 'lastMonth' };
    }
  }
}

function formatLabel(range: DateRange): string {
  if (range.preset) {
    const p = PRESETS.find((x) => x.key === range.preset);
    if (p) return p.label;
  }
  const f = formatShortDate(range.from);
  const t = formatShortDate(range.to);
  if (f === t) return f;
  return `${f} — ${t}`;
}

function formatShortDate(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

interface DayCell {
  date: Date;
  isCurrentMonth: boolean;
}

function buildMonthGrid(year: number, month: number): DayCell[] {
  const first = new Date(year, month, 1);
  const startWeekday = first.getDay(); // 0..6 (dom=0)
  const gridStart = addDays(first, -startWeekday);
  const cells: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    cells.push({ date: d, isCurrentMonth: d.getMonth() === month });
  }
  return cells;
}

export default function DateRangePicker({
  value,
  onChange,
}: {
  value: DateRange;
  onChange: (range: DateRange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingFrom, setPendingFrom] = useState<Date | null>(null);
  // Calendário esquerdo (right = leftMonth+1). Inicia mostrando o mês do `to`.
  const [leftMonth, setLeftMonth] = useState<{ year: number; month: number }>(() => {
    const d = value.to;
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    return { year: prev.getFullYear(), month: prev.getMonth() };
  });

  const popupRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Click outside e ESC fecham
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Node;
      if (popupRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;
      setOpen(false);
      setPendingFrom(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        setPendingFrom(null);
      }
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rightMonth = useMemo(() => {
    const d = new Date(leftMonth.year, leftMonth.month + 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [leftMonth]);

  const leftCells = useMemo(() => buildMonthGrid(leftMonth.year, leftMonth.month), [leftMonth]);
  const rightCells = useMemo(() => buildMonthGrid(rightMonth.year, rightMonth.month), [rightMonth]);

  function applyPreset(key: PresetKey) {
    const r = rangeFromPreset(key);
    onChange(r);
    setPendingFrom(null);
    setOpen(false);
  }

  function pickDay(d: Date) {
    if (!pendingFrom) {
      setPendingFrom(d);
      return;
    }
    // 2º click: monta o range em ordem cronológica.
    const a = startOfDay(pendingFrom);
    const b = startOfDay(d);
    const range: DateRange = a <= b ? { from: a, to: b } : { from: b, to: a };
    onChange(range);
    setPendingFrom(null);
    setOpen(false);
  }

  function moveMonths(delta: number) {
    setLeftMonth(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  // Range "preview" enquanto seleciona — usa pendingFrom como ponta provisória
  const previewRange: { from: Date; to: Date } | null = pendingFrom
    ? { from: pendingFrom, to: pendingFrom }
    : { from: value.from, to: value.to };

  return (
    <div className="relative inline-block">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px] text-text-secondary transition-colors hover:border-blue-light/60 hover:text-text-primary"
        style={{ borderColor: 'var(--border-subtle)', background: '#111116' }}
      >
        <Calendar size={14} strokeWidth={1.6} />
        <span>{formatLabel(value)}</span>
        <ChevronDown size={14} strokeWidth={1.6} />
      </button>

      {open && (
        <div
          ref={popupRef}
          className="absolute right-0 z-50 mt-2 flex flex-col overflow-hidden rounded-xl border shadow-2xl sm:flex-row"
          style={{
            background: '#0F0F14',
            borderColor: 'var(--border-subtle)',
            minWidth: 320,
          }}
        >
          {/* Sidebar de presets */}
          <div
            className="flex shrink-0 flex-col gap-1 border-b p-3 sm:border-b-0 sm:border-r"
            style={{ borderColor: 'var(--border-subtle)', minWidth: 150 }}
          >
            <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
              Períodos
            </div>
            {PRESETS.map((p) => {
              const active = value.preset === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => applyPreset(p.key)}
                  className="rounded-md px-3 py-1.5 text-left text-[12.5px] transition-colors"
                  style={
                    active
                      ? { background: 'var(--accent)', color: '#fff' }
                      : { color: '#CBD5E1' }
                  }
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>

          {/* Dois calendários */}
          <div className="flex flex-col gap-4 p-4 sm:flex-row">
            <MonthGrid
              year={leftMonth.year}
              month={leftMonth.month}
              cells={leftCells}
              preview={previewRange}
              committedRange={{ from: value.from, to: value.to }}
              pendingFrom={pendingFrom}
              onPick={pickDay}
              onPrev={() => moveMonths(-1)}
              onNext={null}
            />
            <div className="hidden sm:block">
              <MonthGrid
                year={rightMonth.year}
                month={rightMonth.month}
                cells={rightCells}
                preview={previewRange}
                committedRange={{ from: value.from, to: value.to }}
                pendingFrom={pendingFrom}
                onPick={pickDay}
                onPrev={null}
                onNext={() => moveMonths(1)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MonthGrid({
  year,
  month,
  cells,
  preview,
  committedRange,
  pendingFrom,
  onPick,
  onPrev,
  onNext,
}: {
  year: number;
  month: number;
  cells: DayCell[];
  preview: { from: Date; to: Date } | null;
  committedRange: { from: Date; to: Date };
  pendingFrom: Date | null;
  onPick: (d: Date) => void;
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
}) {
  const today = startOfDay(new Date());
  return (
    <div style={{ minWidth: 260 }}>
      <div className="mb-2 flex items-center justify-between">
        {onPrev ? (
          <button
            type="button"
            onClick={onPrev}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary"
            aria-label="Mês anterior"
          >
            <ChevronLeft size={14} strokeWidth={1.6} />
          </button>
        ) : <span className="w-6" />}
        <div className="text-[12.5px] font-medium text-text-secondary">
          {MONTH_NAMES[month]} {year}
        </div>
        {onNext ? (
          <button
            type="button"
            onClick={onNext}
            className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary"
            aria-label="Próximo mês"
          >
            <ChevronRight size={14} strokeWidth={1.6} />
          </button>
        ) : <span className="w-6" />}
      </div>
      <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wider text-text-muted">
        {WEEKDAYS.map((w) => <div key={w}>{w}</div>)}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, i) => {
          const isOtherMonth = !c.isCurrentMonth;
          const isToday = sameDay(c.date, today);
          const isFrom = sameDay(c.date, committedRange.from);
          const isTo = sameDay(c.date, committedRange.to);
          const inCommitted = inRange(c.date, committedRange.from, committedRange.to);
          const isPendingStart = !!pendingFrom && sameDay(c.date, pendingFrom);
          // O range "preview" mostra os endpoints ao vivo
          const endpoint = isFrom || isTo || isPendingStart;

          let bg = 'transparent';
          let color = isOtherMonth ? '#475569' : '#CBD5E1';
          if (endpoint) {
            bg = 'var(--accent)';
            color = '#fff';
          } else if (inCommitted && !pendingFrom) {
            bg = 'rgba(var(--accent-rgb),0.18)';
            color = '#CBD5E1';
          }

          return (
            <button
              key={i}
              type="button"
              onClick={() => onPick(c.date)}
              className="flex h-8 items-center justify-center rounded-md text-[12px] transition-colors"
              style={{
                background: bg,
                color,
                fontWeight: endpoint ? 600 : isToday ? 600 : 400,
                border: isToday && !endpoint ? '1px solid rgba(255,255,255,0.12)' : 'none',
              }}
              onMouseEnter={(e) => {
                if (!endpoint && !(inCommitted && !pendingFrom)) {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                }
              }}
              onMouseLeave={(e) => {
                if (!endpoint && !(inCommitted && !pendingFrom)) {
                  e.currentTarget.style.background = 'transparent';
                }
              }}
            >
              {c.date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
