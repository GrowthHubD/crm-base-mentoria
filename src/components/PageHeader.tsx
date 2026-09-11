import type { ReactNode } from 'react';
import SeletorUnidade from './SeletorUnidade';

type Props = {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  /**
   * Mostra o seletor de unidade à esquerda das ações da página.
   *
   * Fica no cabeçalho e não na sidebar de propósito: o recorte por filial muda
   * o que a TELA ATUAL mostra, e a decisão precisa estar no campo de visão de
   * quem está lendo os números — não a um scroll de distância, num menu.
   *
   * Só aparece para quem pode alternar (o dono). O componente se esconde
   * sozinho quando há menos de duas filiais.
   */
  podeAlternarUnidade?: boolean;
};

export default function PageHeader({ icon, title, subtitle, right, podeAlternarUnidade }: Props) {
  return (
    <header
      className="sticky top-0 z-20 flex min-h-[56px] items-center justify-between gap-2 border-b px-3 py-2 md:h-[64px] md:min-h-[64px] md:gap-3 md:px-6 md:py-0"
      style={{
        background: 'rgba(9,9,11,0.85)',
        backdropFilter: 'blur(16px)',
        borderColor: 'var(--border-subtle)',
      }}
    >
      <div className="flex min-w-0 items-center gap-2 md:gap-3">
        {icon && (
          <div
            className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg sm:flex"
            style={{ background: 'rgba(var(--accent-mid-rgb),0.12)', color: 'var(--accent-light)' }}
          >
            {icon}
          </div>
        )}
        <div className="flex min-w-0 flex-col leading-tight">
          <h1 className="truncate text-[13px] font-semibold text-text-primary md:text-[15px]">{title}</h1>
          {subtitle && (
            <p className="hidden truncate text-[12px] text-text-secondary sm:block">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 md:gap-3">
        {podeAlternarUnidade && <SeletorUnidade podeAlternar />}
        {right}
      </div>
    </header>
  );
}
