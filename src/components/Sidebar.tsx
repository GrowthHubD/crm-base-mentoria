'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  LayoutDashboard, MessageSquare, Calendar, Wifi, Bot, Settings,
  LogOut, Users, ChevronLeft, ChevronDown, Trophy, Zap, Mail,
} from 'lucide-react';
import { signOut } from '@/lib/auth-client';
import { APP_NAME, APP_TAGLINE_SHORT } from '@/lib/branding';
import { BASE_PLAN, type FeatureKey, type PlanFeatures } from '@/lib/plan';

type Item = {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Some para quem não é admin — recorte de PERMISSÃO. */
  adminOnly?: boolean;
  /** Some quando o módulo não foi contratado — recorte de PLANO. */
  feature?: FeatureKey;
  /**
   * Some para quem não é admin QUANDO cada pessoa tem a carteira dela.
   *
   * Terceiro recorte, e não um `adminOnly` a mais, porque a pergunta é outra:
   * não é "esta pessoa tem permissão", é "esta tela faz sentido para quem só
   * enxerga a própria carteira". Dashboard e Ranking somam o time inteiro —
   * para um BDR que só vê os próprios leads, seriam números de conversas que
   * ele não pode abrir.
   */
  soDonoDeTudo?: boolean;
  /**
   * Deixa de ser exclusiva do admin QUANDO cada pessoa tem a carteira dela.
   *
   * Conexões é o caso: num CRM de atendimento mexer nos números derruba a
   * operação inteira, e por isso fica com o admin. Num time de prospecção cada
   * BDR conecta o próprio celular por QR — e só enxerga o dele (o recorte é da
   * API, não da tela).
   */
  liberaComCarteira?: boolean;
  /**
   * Sub-itens: o item vira um grupo expansível (ex.: CRM → WhatsApp | E-mail).
   * Cada filho é um link próprio; o pai não navega, só abre/fecha.
   */
  children?: { to: string; label: string; icon: React.ComponentType<{ size?: number; strokeWidth?: number }> }[];
  /**
   * Módulo que justifica o SUBMENU — não o item.
   *
   * Diferente de `feature`: sem ele o item continua no menu, só perde os
   * filhos e volta a ser link direto. É o caso do CRM: quem não tem o canal de
   * e-mail continua tendo CRM (é o produto inteiro), mas não precisa escolher
   * entre dois canais quando só existe um.
   *
   * Pôr `feature` no pai aqui esconderia o CRM de todo mundo que não comprou
   * e-mail — o cliente ficaria sem o kanban.
   */
  childrenFeature?: keyof PlanFeatures;
};

const items: Item[] = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, soDonoDeTudo: true },
  {
    to: '/crm', label: 'CRM', icon: MessageSquare,
    // Um kanban por canal: WhatsApp abre só as conexões/leads de WhatsApp;
    // E-mail abre só as caixas/leads de e-mail. O canal viaja na URL (?canal=).
    // O submenu só existe quando há DOIS canais. Sem o módulo de e-mail
    // contratado, "CRM" volta a ser um link direto — dividir em WhatsApp|E-mail
    // para quem só tem WhatsApp é oferecer uma escolha que não existe.
    childrenFeature: 'email',
    children: [
      { to: '/crm?canal=whatsapp', label: 'WhatsApp', icon: MessageSquare },
      { to: '/crm?canal=email', label: 'E-mail', icon: Mail },
    ],
  },
  { to: '/textos-rapidos', label: 'Textos rápidos', icon: Zap, feature: 'quickReplies' },
  { to: '/agendamentos', label: 'Agendamentos', icon: Calendar, feature: 'scheduling' },
  { to: '/ranking', label: 'Ranking', icon: Trophy, feature: 'ranking', soDonoDeTudo: true },
  // Conexões é operação do dia a dia: quando o número cai, quem percebe é o
  // atendente, e mandá-lo caçar o admin para reler um QR é o que trava o
  // atendimento de verdade. Por isso a tela é de todos.
  //
  // O que era motivo para trancá-la — criar e APAGAR conexão derruba o
  // atendimento inteiro — foi resolvido onde importa: essas duas operações
  // agora exigem admin NA ROTA (`requireAdmin` em POST e DELETE). Antes ficavam
  // em `requireSession` e o atendente já podia apagar pela API; o menu escondia
  // e não bloqueava.
  { to: '/conexoes', label: 'Conexões', icon: Wifi },
  // A caixa de e-mail é de quem a conecta, e cada um só vê a sua — por isso
  // ganha entrada própria em vez de ficar dentro de Configurações, que é
  // exclusiva do admin.
  { to: '/configuracoes/email', label: 'E-mail', icon: Mail, adminOnly: true, liberaComCarteira: true, feature: 'email' },
  { to: '/agente-ia', label: 'Agente IA', icon: Bot, adminOnly: true, feature: 'aiAgent' },
  { to: '/configuracoes', label: 'Configurações', icon: Settings, adminOnly: true },
  { to: '/superadmin/users', label: 'Usuários', icon: Users, adminOnly: true },
];

type RoleType = 'admin' | 'attendant';

interface SidebarUser {
  name: string;
  email: string;
  role: RoleType;
}

const STORAGE_KEY = 'sidebar-collapsed';
const WIDTH_OPEN = '220px';
const WIDTH_COLLAPSED = '64px';

export default function Sidebar({
  user,
  features = BASE_PLAN,
  mobileOpen = false,
  carteiraPropria = false,
  papelLabel = 'Atendente',
  marcaNome = APP_NAME,
  marcaLogo = '/logo.png',
  marcaTagline = APP_TAGLINE_SHORT,
}: {
  user: SidebarUser;
  /**
   * Esta instalação dá a cada pessoa a carteira dela? Resolvido no SERVIDOR —
   * ver `lib/escopo-dono.ts`. Muda quais telas fazem sentido no menu, nunca
   * quem pode chamar o quê (isso é decidido em cada rota).
   */
  carteiraPropria?: boolean;
  /** Como o papel não-admin se chama aqui: "Atendente", "BDR"… */
  papelLabel?: string;
  /** Identidade desta instalação, resolvida no SERVIDOR (ver lib/marca.ts).
   *  Vem por prop porque APP_NAME é NEXT_PUBLIC_ — congelado no build, igual
   *  para os sete Workers; a marca por deploy só existe em runtime. */
  marcaNome?: string;
  marcaLogo?: string;
  marcaTagline?: string;
  /** Plano contratado, resolvido no servidor. Ver o cabeçalho de lib/plan.ts:
   *  não dá pra ler aqui, porque este é Client Component e o valor precisa
   *  variar por deploy sem rebuildar. */
  features?: PlanFeatures;
  /** Controlado pelo NavShell; desktop ignora (sidebar fixa). */
  mobileOpen?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const isAdmin = user.role === 'admin';
  // Grupos expansíveis abertos (por `to` do pai). Começa aberto quando a rota
  // atual já está dentro do grupo, para o usuário ver onde está.
  const [gruposAbertos, setGruposAbertos] = useState<Record<string, boolean>>({});
  const alternaGrupo = useCallback(
    (to: string) => setGruposAbertos((g) => ({ ...g, [to]: !g[to] })),
    [],
  );

  // Inicializa a partir do mesmo localStorage que o script inline lê.
  // Hidratação: começa expandido pra casar com o markup default e ajusta no useEffect.
  // `collapsedPref` é a preferência persistida (só vale no desktop).
  const [collapsedPref, setCollapsedPref] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  // No mobile, o drawer sempre renderiza modo expandido (texto + ícones).
  // No desktop respeita a preferência. JSX abaixo só lê `collapsed`.
  const collapsed = isMobile ? false : collapsedPref;

  // Sincroniza state com localStorage no mount + escreve a CSS var.
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      setCollapsedPref(stored === '1');
    } catch { /* localStorage indisponível, ignora */ }
  }, []);

  // Detecta viewport mobile pra forçar modo "aberto" (sem só-ícones) no drawer
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 767px)');
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    // No mobile a sidebar é drawer (overlay) — main sempre ocupa a tela toda.
    // Setamos a var como 0 no mobile pro CSS de `marginLeft` no layout virar 0.
    const width = isMobile ? '0px' : collapsedPref ? WIDTH_COLLAPSED : WIDTH_OPEN;
    document.documentElement.style.setProperty('--sidebar-width', width);
    try { localStorage.setItem(STORAGE_KEY, collapsedPref ? '1' : '0'); } catch { /* ignora */ }
  }, [collapsedPref, isMobile]);

  const toggleCollapsed = useCallback(() => {
    setCollapsedPref(v => !v);
  }, []);

  async function handleLogout() {
    await signOut();
    router.replace('/login');
  }

  const initials = (user.name || user.email).slice(0, 2).toUpperCase();
  // O nome do papel vem do servidor: "atendente" num CRM de atendimento,
  // "BDR" num time de prospecção. Ver `lib/escopo-dono.ts`.
  const roleLabel = isAdmin ? 'Gerente' : papelLabel;
  const roleColor = isAdmin ? 'var(--accent-light)' : '#94A3B8';
  const roleBg = isAdmin ? 'rgba(var(--accent-light-rgb),0.15)' : 'rgba(148,163,184,0.12)';

  // Três filtros independentes: o que a empresa CONTRATOU, o que este usuário
  // PODE, e se ele enxerga o time ou só a própria carteira. Um módulo não
  // contratado some pra todo mundo, inclusive pro admin — ele é o dono, e não
  // deve ver porta de produto que não comprou.
  //
  // Esconder aqui é conveniência, NÃO é a segurança: cada rota do servidor
  // recusa por conta própria. Um menu escondido com a URL aberta é o erro
  // clássico, e este arquivo não é a defesa.
  const visible = items
    .filter((it) => {
      if (it.feature && !features[it.feature]) return false;
      if (it.soDonoDeTudo && carteiraPropria) return false;
      if (it.adminOnly && !isAdmin) return !!(it.liberaComCarteira && carteiraPropria);
      return true;
    })
    // Submenu sem o módulo contratado vira link direto (ver `childrenFeature`).
    .map((it) =>
      it.childrenFeature && !features[it.childrenFeature] ? { ...it, children: undefined } : it,
    );

  // Mobile: largura fixa "aberta" (220px) — drawer não tem sentido com versão
  // colapsada de 64px. Desktop: respeita o `collapsedPref`.
  const desktopWidthClass = collapsedPref ? 'md:w-[64px]' : 'md:w-[220px]';

  return (
    <aside
      className={`fixed left-0 top-0 z-50 flex h-[100dvh] w-[220px] flex-col overflow-y-auto overscroll-contain border-r transition-[transform,width] duration-200 md:z-30 md:translate-x-0 ${desktopWidthClass} ${
        mobileOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
      style={{
        background: '#0A0A0F',
        borderColor: 'var(--border-subtle)',
      }}
    >
      {/* Header: logo + nome + toggle (oculta texto quando colapsada) */}
      <div className={`flex items-center pt-5 pb-4 ${collapsed ? 'justify-center px-2' : 'gap-3 px-5'}`}>
        {/* A logo já traz o próprio quadrado escuro com cantos arredondados —
            por isso nada de gradiente atrás dela, que criaria moldura sobre
            moldura. O brilho fica em magenta/azul pra acompanhar a marca. */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center" style={{ filter: 'drop-shadow(0 0 14px var(--logo-glow, rgba(168,85,247,0.35)))' }}>
          <img
            src={marcaLogo}
            alt={marcaNome}
            width={40}
            height={40}
            className="h-10 w-10 rounded-lg"
          />
        </div>
        {!collapsed && (
          <>
            <div className="min-w-0">
              <div className="text-[15px] font-bold tracking-tight text-white">{marcaNome}</div>
              <div className="text-[10.5px] text-text-muted">{marcaTagline}</div>
            </div>
            <CollapseToggle collapsed={collapsed} onClick={toggleCollapsed} className="ml-auto -mr-1" />
          </>
        )}
      </div>

      {/* Colapsada: o toggle ganha a própria linha, centrado — não cabe ao
          lado do logo em 64px. */}
      {collapsed && (
        <div className="hidden justify-center pb-2 md:flex">
          <CollapseToggle collapsed={collapsed} onClick={toggleCollapsed} />
        </div>
      )}

      <div className={`${collapsed ? 'mx-2' : 'mx-5'} my-2 h-px`} style={{ background: 'var(--border-subtle)' }} />

      <nav className={`flex-1 ${collapsed ? 'px-2' : 'px-3'} py-2`}>
        {!collapsed && <div className="section-label px-3 pt-3 pb-2">Principal</div>}
        {collapsed && <div className="pt-3" />}
        <ul className="flex flex-col gap-1">
          {(() => {
            // Um item "contém" a rota atual quando é prefixo dela. Como
            // /configuracoes/email vive DENTRO de /configuracoes, os dois
            // casariam e acenderiam juntos — o ativo é só o mais específico.
            const casa = (to: string) => pathname === to || pathname?.startsWith(to + '/');
            const maisEspecifico = visible
              .filter((x) => casa(x.to))
              .sort((a, b) => b.to.length - a.to.length)[0]?.to;
            const linkCls = (active: boolean) => [
              'group relative flex items-center rounded-lg text-[13px] font-medium transition-all duration-150',
              collapsed ? 'h-10 justify-center' : 'gap-3 px-3 py-2.5',
              active ? 'text-blue-mid' : 'text-[#64748B] hover:text-text-secondary hover:bg-[rgba(var(--accent-mid-rgb),0.06)]',
            ].join(' ');
            const linkStyle = (active: boolean) => active
              ? { background: 'var(--accent-deep)', boxShadow: '-3px 0 12px rgba(var(--accent-mid-rgb),0.25), inset 2px 0 0 0 var(--accent-mid)' }
              : undefined;
            // Filho ativo: mesma rota base + o `canal` da URL bate (default
            // whatsapp quando ausente). Ex.: /crm?canal=email.
            const canalAtual = searchParams.get('canal') === 'email' ? 'email' : 'whatsapp';
            const filhoAtivo = (to: string) => {
              const [base, query] = to.split('?');
              if (!casa(base)) return false;
              const canalDoFilho = query?.includes('canal=email') ? 'email' : 'whatsapp';
              return canalDoFilho === canalAtual;
            };
            return visible.map((it) => {
            const Icon = it.icon;
            const isActive = it.to === maisEspecifico;

            // Item com filhos: grupo expansível. Colapsada (64px) não comporta
            // submenu — vira link direto pro 1º filho (WhatsApp).
            if (it.children && it.children.length > 0) {
              if (collapsed) {
                return (
                  <li key={it.to}>
                    <Link href={it.children[0].to} title={it.label} className={linkCls(isActive)} style={linkStyle(isActive)}>
                      <Icon size={18} strokeWidth={1.6} />
                    </Link>
                  </li>
                );
              }
              const aberto = gruposAbertos[it.to] ?? isActive;
              return (
                <li key={it.to}>
                  <button
                    type="button"
                    onClick={() => alternaGrupo(it.to)}
                    aria-expanded={aberto}
                    className={`${linkCls(isActive)} w-full`}
                    style={linkStyle(isActive)}
                  >
                    <Icon size={18} strokeWidth={1.6} />
                    <span className="flex-1 text-left">{it.label}</span>
                    <ChevronDown size={15} strokeWidth={1.8} className={`transition-transform ${aberto ? '' : '-rotate-90'}`} />
                  </button>
                  {aberto && (
                    <ul className="mt-1 flex flex-col gap-1 pl-4">
                      {it.children.map((sub) => {
                        const SubIcon = sub.icon;
                        const subActive = filhoAtivo(sub.to);
                        return (
                          <li key={sub.to}>
                            <Link href={sub.to} className={linkCls(subActive)} style={linkStyle(subActive)}>
                              <SubIcon size={16} strokeWidth={1.6} />
                              <span className="flex-1">{sub.label}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            }

            return (
              <li key={it.to}>
                <Link
                  href={it.to}
                  title={collapsed ? it.label : undefined}
                  className={linkCls(isActive)}
                  style={linkStyle(isActive)}
                >
                  <Icon size={18} strokeWidth={1.6} />
                  {!collapsed && <span className="flex-1">{it.label}</span>}
                </Link>
              </li>
            );
            });
          })()}
        </ul>
      </nav>

      {/* Footer: card do usuário (expandido) ou só avatar + sair (colapsado) */}
      {collapsed ? (
        <div className="mb-4 flex flex-col items-center gap-2 px-2">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-primary/25 text-[12px] font-bold text-blue-light"
            title={`${user.name || user.email} · ${roleLabel}`}
          >
            {initials}
          </div>
          <button
            onClick={handleLogout}
            title="Sair"
            aria-label="Sair"
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted hover:bg-[rgba(248,113,113,0.08)] hover:text-error-text"
          >
            <LogOut size={14} strokeWidth={1.8} />
          </button>
        </div>
      ) : (
        <div className="mx-3 mb-4 rounded-xl border p-3" style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-primary/25 text-[12px] font-bold text-blue-light">{initials}</div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-white">{user.name || 'Usuário'}</div>
              <div className="truncate text-[10.5px] text-text-muted">{user.email}</div>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: roleBg, color: roleColor }}>
              {roleLabel}
            </span>
            <button onClick={handleLogout} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-text-muted transition-colors hover:bg-[rgba(248,113,113,0.08)] hover:text-error-text" title="Sair">
              <LogOut size={12} strokeWidth={1.8} />
              Sair
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}

/**
 * Alternador de largura da sidebar.
 *
 * Antes era uma faixa de largura inteira escrita "Recolher": ocupava uma linha
 * de conteúdo pra dizer o que a seta já diz, e competia visualmente com os
 * itens de navegação logo abaixo. Agora é um alvo de 28px encostado no header,
 * discreto até o hover — a seta gira 180° em vez de trocar de ícone, o que dá
 * continuidade ao gesto em vez de um corte seco.
 */
function CollapseToggle({
  collapsed,
  onClick,
  className = '',
}: {
  collapsed: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
      aria-expanded={!collapsed}
      title={collapsed ? 'Expandir menu' : 'Recolher menu'}
      className={`hidden h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors duration-150 hover:bg-[rgba(var(--accent-mid-rgb),0.10)] hover:text-blue-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-mid/60 md:flex ${className}`}
    >
      <ChevronLeft
        size={16}
        strokeWidth={2}
        className={`transition-transform duration-200 ${collapsed ? 'rotate-180' : ''}`}
      />
    </button>
  );
}
