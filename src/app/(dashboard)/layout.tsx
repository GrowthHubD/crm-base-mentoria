import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/users';
import { eq } from 'drizzle-orm';
import NavShell from '@/components/NavShell';
import { readPlanFeatures, isPathAllowed } from '@/lib/plan';
import { escopoPorDonoAtivo, rotuloDoPapel } from '@/lib/escopo-dono';
import { densidadeKanban } from '@/lib/kanban-densidade';
import { identidadeDaMarca } from '@/lib/marca';
import { AuthScopeProvider } from '@/modules/auth/client-scope';
import { cardsSoPorArraste } from '@/modules/pipeline/modo';

// Layout SEMPRE dinâmico — a role pode ter mudado no banco e não queremos
// servir cache de RSC com a versão antiga.
export const dynamic = 'force-dynamic';

// Rotas que exigem admin (gerente). /conexoes ficou FORA: atendente pode
// gerenciar as conexões (conectar números), mas segue sem acesso a
// /agente-ia, /configuracoes, /admin e /superadmin (gestão de usuários).
const ADMIN_ONLY_PATHS = ['/agente-ia', '/configuracoes', '/admin', '/superadmin'];

/**
 * Telas que somem para quem só enxerga a PRÓPRIA carteira.
 *
 * Dashboard e Ranking somam o time inteiro. Para um BDR que só vê os leads
 * dele, seriam números de conversas que ele não pode abrir — e um placar do
 * desempenho dos colegas.
 */
const PATHS_DE_TIME = ['/dashboard', '/ranking'];

/**
 * Exceção dentro de `/configuracoes`, que é admin.
 *
 * A caixa de e-mail é pessoal: cada um conecta a sua e a API já devolve só as
 * dele. Barrar aqui deixaria o BDR sem como conectar o e-mail — que é
 * justamente o que ele precisa fazer sozinho.
 */
const PATHS_PESSOAIS_COM_CARTEIRA = ['/conexoes', '/configuracoes/email'];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const session = await auth.api.getSession({ headers: h });

  if (!session) {
    redirect('/login');
  }

  const [row] = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);

  if (!row) redirect('/login');

  const pathname = h.get('x-pathname') ?? '';
  const casa = (p: string) => pathname === p || pathname.startsWith(`${p}/`);

  const carteiraPropria = escopoPorDonoAtivo() && row.role !== 'admin';
  // Para onde mandar quem bateu numa porta fechada. Não pode ser /dashboard
  // quando essa é justamente uma das telas que sumiram — seria um redirect em
  // círculo, e o usuário veria a tela piscar sem sair do lugar.
  const inicio = carteiraPropria ? '/crm' : '/dashboard';

  const isAdminPath =
    ADMIN_ONLY_PATHS.some(casa) &&
    !(carteiraPropria && PATHS_PESSOAIS_COM_CARTEIRA.some(casa));

  // Atendente nunca acessa páginas admin
  if (isAdminPath && row.role === 'attendant') {
    redirect(inicio);
  }

  // Telas de time não abrem nem por URL direta para quem tem carteira própria.
  // Esconder do menu é cosmético — este é o bloqueio de verdade.
  if (carteiraPropria && PATHS_DE_TIME.some(casa)) {
    redirect('/crm');
  }

  // Módulo não contratado não abre nem por URL direta. Esconder do menu é
  // cosmético — sem isto, `/agente-ia` respondia 200 num deploy que não tem
  // o agente no plano.
  const features = readPlanFeatures();
  if (pathname && !isPathAllowed(pathname, features)) {
    redirect(inicio);
  }

  return (
    <AuthScopeProvider
      userId={row.id}
      role={row.role}
      veTudo={!carteiraPropria}
      kanbanManual={cardsSoPorArraste()}
    >
      {/* `data-kanban` decide a aparência do quadro pelas variáveis de
          `globals.css`. Resolvido aqui, no servidor: um build, sete Workers. */}
      <div className="min-h-screen" data-kanban={densidadeKanban()}>
      {/* O plano é resolvido AQUI, no servidor, e desce por prop. Ler no
          cliente voltaria a ser build-time e todos os deploys do mesmo build
          teriam o mesmo menu — ver o cabeçalho de lib/plan.ts. */}
      <NavShell
        user={row}
        features={features}
        carteiraPropria={carteiraPropria}
        papelLabel={rotuloDoPapel(row.role)}
        {...(() => { const m = identidadeDaMarca(); return { marcaNome: m.nome, marcaLogo: m.logo, marcaTagline: m.tagline }; })()}
      >
        <main
          className="relative min-h-screen pt-[56px] md:pt-0 md:ml-[var(--sidebar-width,220px)] transition-[margin] duration-200"
          style={{
            background:
              'radial-gradient(ellipse at 50% 0%, rgba(var(--accent-rgb),0.06) 0%, transparent 55%), #09090B',
          }}
        >
          {children}
        </main>
      </NavShell>
      </div>
    </AuthScopeProvider>
  );
}
