import type { HTMLAttributes, ReactNode } from 'react';

type Props = HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  padding?: number;
  interactive?: boolean;
};

export default function Card({
  children,
  padding = 20,
  interactive,
  className = '',
  style,
  ...rest
}: Props) {
  return (
    <div
      className={`card-surface ${interactive ? 'hover:shadow-[0_8px_24px_rgba(0,0,0,0.35)]' : ''} ${className}`}
      style={{ padding, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}
