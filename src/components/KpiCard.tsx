'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Card from './Card';

type Props = {
  label: string;
  value: number;
  suffix?: string;
  hint?: ReactNode;
  icon: ReactNode;
  accent?: 'blue' | 'amber' | 'green' | 'red';
  size?: 'lg' | 'sm';
  delay?: number;
};

function useCountUp(target: number, duration = 900, delay = 0) {
  const [n, setN] = useState(0);
  const raf = useRef<number | null>(null);
  useEffect(() => {
    const start = performance.now() + delay;
    const tick = (t: number) => {
      const elapsed = t - start;
      if (elapsed < 0) {
        raf.current = requestAnimationFrame(tick);
        return;
      }
      const p = Math.min(1, elapsed / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setN(target * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [target, duration, delay]);
  return n;
}

const ACCENTS = {
  blue: { fg: 'var(--accent-light)', bg: 'rgba(var(--accent-mid-rgb),0.10)' },
  amber: { fg: '#FBBF24', bg: 'rgba(251,191,36,0.10)' },
  // Variáveis com fallback verde: na Lidy "convertido" é verde (semântica de
  // sucesso); na marca Acme o cliente pediu o ícone na cor da marca, igual aos
  // demais cards — o bloco [data-marca='acme'] define as duas variáveis.
  green: { fg: 'var(--kpi-ok, #4ADE80)', bg: 'var(--kpi-ok-bg, rgba(74,222,128,0.10))' },
  red: { fg: '#F87171', bg: 'rgba(248,113,113,0.10)' },
};

export default function KpiCard({
  label,
  value,
  suffix = '',
  hint,
  icon,
  accent = 'blue',
  size = 'lg',
  delay = 0,
}: Props) {
  const n = useCountUp(value, 900, delay);
  const isPct = suffix === '%';
  const display = isPct ? Math.round(n) : Math.round(n).toLocaleString('pt-BR');
  const A = ACCENTS[accent];

  return (
    <Card padding={20} interactive>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="section-label mb-3">{label}</div>
          <div className="flex items-baseline gap-1.5">
            <span className="kpi-number" style={{ fontSize: size === 'lg' ? 30 : 22 }}>
              {display}
              {suffix}
            </span>
          </div>
          {hint && <div className="mt-2 text-[11.5px] text-text-muted">{hint}</div>}
        </div>
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg"
          style={{ background: A.bg, color: A.fg }}
        >
          {icon}
        </div>
      </div>
    </Card>
  );
}
