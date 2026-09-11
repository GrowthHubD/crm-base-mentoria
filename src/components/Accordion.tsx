'use client';

import { useRef, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

type Props = {
  title: string;
  description?: string;
  icon: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  children: ReactNode;
};

export default function Accordion({
  title,
  description,
  icon,
  defaultOpen = false,
  right,
  children,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<number | null>(defaultOpen ? null : 0);

  useEffect(() => {
    if (!bodyRef.current) return;
    if (open) {
      const target = bodyRef.current.scrollHeight;
      setH(target);
      const t = setTimeout(() => setH(null), 260);
      return () => clearTimeout(t);
    } else {
      setH(bodyRef.current.scrollHeight);
      requestAnimationFrame(() => setH(0));
    }
  }, [open]);

  return (
    <div className="card-surface overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-5 py-4 text-left transition-colors duration-150 hover:bg-[rgba(var(--accent-mid-rgb),0.04)]"
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{
            background: 'rgba(var(--accent-mid-rgb),0.10)',
            color: 'var(--accent-light)',
            filter: open ? 'drop-shadow(0 0 6px rgba(var(--accent-light-rgb),0.4))' : undefined,
            transition: 'filter 200ms ease',
          }}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[14px] font-semibold text-text-primary">{title}</div>
          {description && <div className="text-[12px] text-text-secondary mt-0.5">{description}</div>}
        </div>
        {right}
        <ChevronDown
          size={18}
          strokeWidth={1.6}
          className="text-text-muted"
          style={{
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 220ms ease',
          }}
        />
      </button>

      <div
        style={{
          height: h === null ? 'auto' : `${h}px`,
          overflow: 'hidden',
          transition: 'height 240ms ease-out, opacity 220ms ease',
          opacity: open ? 1 : 0,
        }}
      >
        <div ref={bodyRef} className="px-5 pb-5 pt-1">
          <div className="rounded-xl" style={{ background: 'transparent' }}>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
