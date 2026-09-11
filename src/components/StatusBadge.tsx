import type { ReactNode } from 'react';

type Variant =
  | 'novo'
  | 'atendimento'
  | 'concluido'
  | 'perdido'
  | 'top'
  | 'bom'
  | 'regular'
  | 'conectado'
  | 'desconectado'
  | 'aguardando'
  | 'ia'
  | 'neutral';

const MAP: Record<Variant, { bg: string; text: string; dot?: string; pulse?: boolean; slow?: boolean }> = {
  novo: { bg: 'var(--accent-deep)', text: 'var(--accent-light)' },
  atendimento: { bg: '#451A03', text: '#FBBF24' },
  concluido: { bg: '#14532D', text: '#4ADE80' },
  perdido: { bg: '#450A0A', text: '#F87171' },
  top: { bg: 'var(--accent-deep)', text: 'var(--accent-light)' },
  bom: { bg: '#1C2235', text: '#818CF8' },
  regular: { bg: '#1C1C28', text: '#94A3B8' },
  conectado: { bg: '#14532D', text: '#4ADE80', dot: '#4ADE80', pulse: true },
  desconectado: { bg: '#450A0A', text: '#F87171', dot: '#F87171' },
  aguardando: { bg: '#451A03', text: '#FBBF24', dot: '#FBBF24', slow: true },
  ia: { bg: 'var(--accent-deep)', text: 'var(--accent-light)' },
  neutral: { bg: '#1C1C28', text: '#94A3B8' },
};

type Props = {
  variant: Variant;
  children: ReactNode;
  className?: string;
};

export default function StatusBadge({ variant, children, className = '' }: Props) {
  const c = MAP[variant];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 font-medium ${className}`}
      style={{
        background: c.bg,
        color: c.text,
        height: 22,
        fontSize: 11,
        letterSpacing: '0.01em',
        lineHeight: '22px',
      }}
    >
      {c.dot && (
        <span
          className={c.pulse ? 'animate-pulse-dot' : c.slow ? 'animate-slow-pulse' : ''}
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: c.dot,
            display: 'inline-block',
          }}
        />
      )}
      {children}
    </span>
  );
}
