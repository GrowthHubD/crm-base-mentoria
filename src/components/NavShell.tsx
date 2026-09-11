'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, X, MessagesSquare } from 'lucide-react';
import Sidebar from './Sidebar';
import type { PlanFeatures } from '@/lib/plan';
import { APP_NAME } from '@/lib/branding';

type RoleType = 'admin' | 'attendant';

interface ShellUser {
  name: string;
  email: string;
  role: RoleType;
}

/**
 * Wrapper client-side que gerencia o drawer mobile da sidebar.
 *
 * Desktop (>=768px): comportamento idêntico ao anterior — sidebar fixa à esquerda,
 * colapsável via botão interno.
 *
 * Mobile (<768px): sidebar fica oculta por padrão (translate-x-full) e abre como
 * drawer overlay. Um topbar fixo com botão hambúrguer aparece só nessa faixa.
 */
export default function NavShell({
  user,
  features,
  carteiraPropria,
  papelLabel,
  marcaNome,
  marcaLogo,
  marcaTagline,
  children,
}: {
  user: ShellUser;
  /** Vem do layout (Server Component) e desce até a Sidebar. */
  features?: PlanFeatures;
  /** Repassados ao Sidebar — resolvidos no servidor, ver o layout. */
  carteiraPropria?: boolean;
  papelLabel?: string;
  marcaNome?: string;
  marcaLogo?: string;
  marcaTagline?: string;
  children: React.ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = usePathname();

  // Fecha drawer ao navegar
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // ESC fecha drawer
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  // Trava scroll do body quando drawer está aberto
  useEffect(() => {
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [mobileOpen]);

  return (
    <>
      {/* Topbar fixo só no mobile */}
      <header
        className="fixed left-0 right-0 top-0 z-40 flex items-center justify-between border-b px-3 py-2 md:hidden"
        style={{
          height: 56,
          background: 'rgba(10,10,15,0.92)',
          backdropFilter: 'blur(14px)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          aria-label="Abrir menu"
          className="flex h-10 w-10 items-center justify-center rounded-lg border text-text-secondary"
          style={{ borderColor: 'var(--border-subtle)', background: '#111116' }}
        >
          <Menu size={18} strokeWidth={1.8} />
        </button>

        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-md bg-gradient-to-br from-[var(--accent)] to-[var(--accent-light)] flex items-center justify-center">
            <MessagesSquare size={16} strokeWidth={1.7} className="text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">{APP_NAME}</span>
        </div>

        {/* Spacer pra manter logo centralizado */}
        <div className="h-10 w-10" />
      </header>

      {/* Overlay quando drawer aberto (mobile) */}
      {mobileOpen && (
        <button
          type="button"
          aria-label="Fechar menu"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm md:hidden"
        />
      )}

      {/* Botão "fechar drawer" flutuante quando aberto */}
      {mobileOpen && (
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          aria-label="Fechar menu"
          className="fixed left-[228px] top-3 z-[60] flex h-9 w-9 items-center justify-center rounded-full text-white shadow-lg md:hidden"
          style={{ background: '#1C1C28', border: '1px solid var(--border-subtle)' }}
        >
          <X size={16} strokeWidth={1.8} />
        </button>
      )}

      <Sidebar
        user={user}
        features={features}
        mobileOpen={mobileOpen}
        carteiraPropria={carteiraPropria}
        papelLabel={papelLabel}
        marcaNome={marcaNome}
        marcaLogo={marcaLogo}
        marcaTagline={marcaTagline}
      />

      {children}
    </>
  );
}
