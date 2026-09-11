'use client';

import { useState } from 'react';

type Props = {
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (v: boolean) => void;
  size?: 'sm' | 'md' | 'lg';
  ariaLabel?: string;
};

export default function Toggle({
  checked,
  defaultChecked = false,
  onChange,
  size = 'md',
  ariaLabel,
}: Props) {
  const [internal, setInternal] = useState(defaultChecked);
  const isControlled = checked !== undefined;
  const value = isControlled ? (checked as boolean) : internal;

  const dims =
    size === 'lg'
      ? { w: 48, h: 26, thumb: 20, pad: 3 }
      : size === 'sm'
      ? { w: 30, h: 16, thumb: 12, pad: 2 }
      : { w: 36, h: 20, thumb: 16, pad: 2 };

  const toggle = () => {
    const next = !value;
    if (!isControlled) setInternal(next);
    onChange?.(next);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      onClick={toggle}
      style={{ width: dims.w, height: dims.h }}
      className={[
        'relative inline-flex shrink-0 rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-mid focus-visible:ring-offset-2 focus-visible:ring-offset-card',
        value ? 'bg-blue-primary' : 'bg-[#374151]',
      ].join(' ')}
    >
      <span
        style={{
          width: dims.thumb,
          height: dims.thumb,
          transform: `translateX(${value ? dims.w - dims.thumb - dims.pad : dims.pad}px)`,
          top: (dims.h - dims.thumb) / 2,
          transition: 'transform 220ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 200ms ease',
          boxShadow: value ? '0 0 8px rgba(var(--accent-mid-rgb),0.65)' : 'none',
        }}
        className="absolute left-0 rounded-full bg-white"
      />
    </button>
  );
}
