/**
 * Middleware Next.js
 * - Protege rotas do dashboard (redireciona pra login)
 * - Bloqueia atendentes de /agente-ia/* (apenas admin) — verificação na page server
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSessionCookie } from 'better-auth/cookies';
import { readPlanFeatures, isPathAllowed } from '@/lib/plan';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // HTTP → HTTPS, antes de qualquer outra coisa.
  //
  // O cookie de sessão do better-auth usa o prefixo `__Secure-`, e o navegador
  // DESCARTA um cookie com esse prefixo recebido por conexão insegura. O efeito
  // é cruel: o login responde 200, a tela de sucesso aparece, o cookie é jogado
  // fora em silêncio, e o /dashboard seguinte não tem sessão — o usuário fica
  // preso na animação de boas-vindas, sem erro nenhum na tela.
  //
  // Foi o que aconteceu com um cliente no celular. Aceitar origem `http` no
  // `trustedOrigins` (para resolver um "Invalid origin") transformou um erro
  // visível nesta armadilha silenciosa; o certo é nunca deixar a sessão nascer
  // em http.
  const proto = req.headers.get('x-forwarded-proto');
  // Setup local não tem TLS na frente. Só dispensa o redirect quando a URL
  // configurada da app E o host da requisição são loopback — um Host forjado
  // não pode desligar o HTTPS em produção.
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  let localSetup = false;
  try {
    const configured = new URL(process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:9876');
    localSetup = loopback.has(configured.hostname) && loopback.has(req.nextUrl.hostname);
  } catch {
    // Configuração inválida nunca dispensa o HTTPS.
  }
  if (proto === 'http' && !localSetup) {
    const seguro = new URL(req.url);
    seguro.protocol = 'https:';
    return NextResponse.redirect(seguro, 308);
  }

  // CADASTRO PÚBLICO FECHADO.
  //
  // O better-auth expõe `/api/auth/sign-up/email` junto com o login, e ele
  // estava respondendo a qualquer um na internet: descoberto ao criar um
  // usuário de teste SEM estar logado. Num CRM interno isso é grave — bastava
  // conhecer a URL para virar usuário e, nas instalações sem carteira por
  // pessoa (onde a fila é compartilhada), enxergar as conversas do cliente.
  //
  // Fechado aqui, no middleware, e não com `disableSignUp` na configuração do
  // better-auth, porque a criação legítima passa por `auth.api.signUpEmail`
  // dentro de `/api/superadmin/users` — que é uma chamada de FUNÇÃO e não
  // atravessa o middleware. `disableSignUp` mataria as duas portas junto.
  //
  // 404 e não 403: quem varre não recebe confirmação de que a rota existe.
  if (pathname.startsWith('/api/auth/sign-up')) {
    console.log(
      JSON.stringify({
        evento: 'cadastro-publico-bloqueado',
        origin: req.headers.get('origin') ?? '(ausente)',
        ua: (req.headers.get('user-agent') ?? '').slice(0, 80),
      })
    );
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Diagnóstico de "Invalid origin".
  //
  // O better-auth compara o `Origin` por string exata e devolve 403 sem dizer
  // QUAL origem recusou. Sem isso, investigar vira adivinhação: um cliente
  // ficou sem entrar enquanto funcionava para quem testava, e só descobrimos
  // testando grafia por grafia às cegas.
  //
  // Registra a origem de toda tentativa de login. É informação de requisição,
  // não credencial — nenhum dado do corpo é lido nem gravado.
  if (pathname.startsWith('/api/auth/sign-in')) {
    console.log(
      JSON.stringify({
        evento: 'tentativa-login',
        origin: req.headers.get('origin') ?? '(ausente)',
        referer: req.headers.get('referer') ?? '(ausente)',
        host: req.headers.get('host') ?? '(ausente)',
        proto: req.headers.get('x-forwarded-proto') ?? '(ausente)',
        ua: (req.headers.get('user-agent') ?? '').slice(0, 80),
      })
    );
  }

  // Rotas públicas
  if (
    pathname.startsWith('/login') ||
    // Privacidade e termos precisam abrir SEM login: o Google exige as duas URLs
    // para publicar o app OAuth e as visita como visitante anônimo. Atrás da
    // sessão, ele receberia o HTML da tela de login e recusaria a publicação.
    pathname === '/privacidade' ||
    pathname === '/termos' ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/webhooks') ||
    pathname.startsWith('/api/media/') ||  // serve arquivos pra uazapi/CDN — NÃO redirecionar
    pathname === '/api/health' ||          // monitor externo não tem sessão; sem isto devolve o HTML do login
    pathname.startsWith('/api/cron/') ||   // Cron Trigger não tem sessão; a rota se protege por CRON_SECRET
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    // Ícones e logos das marcas — assets em public/, um conjunto por marca
    // (o favicon é escolhido em runtime pelo generateMetadata do layout; um
    // arquivo-convenção `src/app/icon.png` seria o MESMO para os sete
    // Workers). Sem a isenção, o navegador pede o ícone, leva redirect pro
    // /login e recebe HTML no lugar da imagem: aba sem ícone, sem erro no
    // console — já aconteceu.
    pathname === '/icon-lidy.png' ||
    pathname === '/apple-icon-lidy.png' ||
    pathname === '/logo.png' ||
    pathname === '/logo-acme.png' ||
    pathname === '/lidy-logo-horizontal.png'
  ) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(req);

  if (!sessionCookie) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  // Módulo não contratado é 404 — pra página e pra API.
  //
  // O layout já barra as PÁGINAS, mas rota de API não passa por layout: sem
  // isto, `/api/admin/ai-config` respondia 200 num deploy sem o agente no
  // plano. 404 e não 403 de propósito: pra quem não comprou, o módulo não
  // existe, e a resposta não confirma que existiria mediante upgrade.
  if (!isPathAllowed(pathname, readPlanFeatures())) {
    return pathname.startsWith('/api/')
      ? NextResponse.json({ error: 'not found' }, { status: 404 })
      : NextResponse.redirect(new URL('/dashboard', req.url));
  }

  // Forward pathname pra layout poder fazer role-check sem hack
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-pathname', pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
