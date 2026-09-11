'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from '@/lib/auth-client';
import './login.css';
import './neon.css';

/**
 * Tela de login.
 *
 * O visual veio de um front estático entregue pronto (HTML/CSS/JS). O CSS foi
 * mantido como está e é importado SÓ por esta rota — ele traz seletores globais
 * (`:root`, `body`, `footer`) que sobrescreveriam o design system do app se
 * fossem carregados no layout raiz. O Next só serve CSS nas rotas que o
 * importam, então o alcance dele termina aqui.
 *
 * O que foi retirado do original, e por quê:
 *
 *  - Botões Google / Meta / Apple: não existe OAuth no backend. Botão que não
 *    faz nada numa tela de login é pior do que botão nenhum — o usuário clica,
 *    não acontece nada, e ele conclui que o sistema está quebrado.
 *  - "Esqueceu a senha?": não existe fluxo de recuperação. Mesmo motivo.
 *  - "Manter conectado": a sessão do better-auth já dura 7 dias para todo
 *    mundo; a caixinha sugeriria uma escolha que não existe.
 *
 * Nada disso é difícil de acrescentar depois — o que não dá é anunciar na porta
 * de entrada algo que o produto ainda não faz.
 */
export default function LoginClient({
  marca,
}: {
  /** Identidade desta instalação, resolvida no SERVIDOR — ver o page.tsx. */
  marca: { nome: string; logoHorizontal: string; logoIcone: string };
}) {
  const APP_NAME = marca.nome;
  const router = useRouter();

  // Vem preenchido quando a pessoa passou pelo acesso central
  // (`seudominio.com.br`), que resolve de qual cliente ela é e redireciona para
  // cá com `?acesso=`. Só o identificador viaja na URL — a senha nunca sai
  // deste domínio, que é o motivo de a conferência acontecer aqui e não lá.
  const [email, setEmail] = useState(() => {
    if (typeof window === 'undefined') return '';
    const v = new URLSearchParams(window.location.search).get('acesso') ?? '';
    return v.trim().slice(0, 200);
  });
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [erroEmail, setErroEmail] = useState('');
  const [erroSenha, setErroSenha] = useState('');
  const [erroGeral, setErroGeral] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sucesso, setSucesso] = useState(false);
  // Só valida enquanto o usuário digita DEPOIS da primeira tentativa. Validar a
  // cada tecla desde o início acusa "e-mail inválido" no primeiro caractere.
  const [tentou, setTentou] = useState(false);

  // Partículas da tela de sucesso: posições sorteadas uma vez. Fora do render
  // porque `Math.random()` a cada render faria elas saltarem, e no servidor
  // geraria markup diferente do cliente (erro de hidratação).
  const particulas = useMemo(
    () =>
      Array.from({ length: 34 }, () => ({
        x: `${8 + Math.random() * 84}%`,
        y: `${8 + Math.random() * 84}%`,
        delay: `${Math.random() * 2.2}s`,
        size: `${2 + Math.random() * 4}px`,
        drift: `${-35 + Math.random() * 70}px`,
      })),
    []
  );
  const [montado, setMontado] = useState(false);
  useEffect(() => setMontado(true), []);

  const redirecionou = useRef(false);

  function validar(): boolean {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
    const senhaOk = password.length >= 4;
    setErroEmail(emailOk ? '' : 'Informe um e-mail válido.');
    setErroSenha(senhaOk ? '' : 'A senha precisa ter pelo menos 4 caracteres.');
    return emailOk && senhaOk;
  }

  useEffect(() => {
    if (tentou) validar();
    // `validar` depende de email/senha; reexecutar a cada mudança é o objetivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, password, tentou]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setTentou(true);
    setErroGeral(null);
    if (!validar()) return;

    setLoading(true);
    const res = await signIn.email({ email: email.trim(), password });

    if (res.error) {
      // Mensagem única para credencial errada: dizer "este e-mail não existe"
      // confirmaria quais e-mails têm conta nesta instância.
      setErroGeral(res.error.message ?? 'E-mail ou senha incorretos.');
      setLoading(false);
      return;
    }

    // A animação de entrada roda enquanto o dashboard já é buscado, então ela
    // não custa tempo ao usuário — a navegação dispara junto, não depois.
    setSucesso(true);
    if (!redirecionou.current) {
      redirecionou.current = true;
      router.push('/dashboard');
      router.refresh();
    }

    // Rede de segurança: se em 4s ainda estivermos no /login, a navegação não
    // aconteceu — o `router.push` foi devolvido para cá pelo middleware (sessão
    // ausente) ou o roteador do cliente ficou preso.
    //
    // Sem isto o usuário fica olhando a animação de boas-vindas para sempre,
    // porque a tela de sucesso cobre a página inteira e nada a fecha. Foi o que
    // um cliente viveu no celular: login aceito, tela bonita, e nenhum caminho
    // para frente nem para trás.
    //
    // A navegação dura recarrega a página, o que reenvia o cookie e desmonta
    // esta tela de qualquer jeito — se a sessão existir, ele entra; se não
    // existir, ele vê o formulário de novo, que é ruim mas é honesto.
    setTimeout(() => {
      if (window.location.pathname.startsWith('/login')) {
        window.location.assign('/dashboard');
      }
    }, 4000);
  }

  return (
    <>
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <main className="page-shell">
        <section className="story-panel" aria-labelledby="story-title">
          <span className="brand" aria-label={`${APP_NAME} — início`}>
            <img
              className="brand-logo"
              src={marca.logoHorizontal}
              alt={`${APP_NAME} — CRM inteligente`}
            />
          </span>

          <div className="story-copy">
            <span className="eyebrow">
              <i /> CRM INTELIGENTE
            </span>
            <h1 id="story-title">
              Conecte. Gerencie.
              <br />
              Transforme <span>resultados.</span>
            </h1>
            <p>
              Automatize conversas, acompanhe resultados e transforme cada contato em uma nova
              oportunidade.
            </p>

            <div className="benefits">
              <article>
                <span className="benefit-icon">⌁</span>
                <div>
                  <strong>Gestão sem fricção</strong>
                  <small>Organize sua operação em um só lugar.</small>
                </div>
              </article>
              <article>
                <span className="benefit-icon">◌</span>
                <div>
                  <strong>Conversas inteligentes</strong>
                  <small>Atenda melhor e converta mais.</small>
                </div>
              </article>
              <article>
                <span className="benefit-icon">⌁</span>
                <div>
                  <strong>Decisões em tempo real</strong>
                  <small>Dados claros para avançar com confiança.</small>
                </div>
              </article>
            </div>
          </div>

          {/* Decoração de vitrine: números ilustrativos, não dados desta
              instância. `aria-hidden` porque leitor de tela anunciando métrica
              inventada seria informação falsa, não enfeite. */}
          <div className="dashboard-card" aria-hidden="true">
            <div className="dash-top">
              <span className="mini-brand">
                <img src={marca.logoIcone} alt="" /> {APP_NAME.toUpperCase()}
              </span>
              <span>•••</span>
            </div>
            <div className="dash-title">
              <small>Visão geral</small>
              <b>Performance</b>
            </div>
            <div className="metric-row">
              <div>
                <small>Novos leads</small>
                <strong>2.548</strong>
                <em>+12,5%</em>
              </div>
              <svg viewBox="0 0 150 50">
                <path d="M2 41 C18 38 20 20 36 28 S58 42 71 20 S93 9 106 18 S126 27 148 6" />
              </svg>
            </div>
            <div className="chart-area">
              <div className="donut">
                <span>
                  <b>2.548</b>
                  <small>Total</small>
                </span>
              </div>
              <div className="bars">
                {['34%', '58%', '42%', '76%', '60%', '92%'].map((h, i) => (
                  <i key={i} style={{ ['--h' as string]: h } as React.CSSProperties} />
                ))}
              </div>
            </div>
            <div className="dash-foot">
              <span />
              <span />
              <span />
            </div>
          </div>

          {/* O selo flutuante "Segurança e confiança" foi removido: era uma
              DUPLICATA do terceiro benefício da lista e, por ser absoluto
              (left/bottom fixos), pousava em cima da própria lista em telas de
              altura comum — dois "Segurança e confiança" sobrepostos. */}
        </section>

        <section className="login-panel" aria-labelledby="login-title">
          <div
            className="official-api-badge"
            aria-label="Sistema integrado com a API oficial do WhatsApp e Meta"
          >
            <span className="api-copy">
              <small>SISTEMA COM</small>
              <strong>API OFICIAL</strong>
            </span>
            <span className="api-separator" />
            <span className="api-logo whatsapp-logo" title="WhatsApp">
              <svg viewBox="0 0 48 48" role="img" aria-label="WhatsApp">
                <path d="M24 5.2A18.5 18.5 0 0 0 8 33l-2.5 9.5 9.8-2.5A18.6 18.6 0 1 0 24 5.2Z" />
                <path
                  className="phone"
                  d="M17.2 14.8c-.5-1.2-1-1.2-1.5-1.2h-1.2c-.5 0-1.2.2-1.8 1-.6.7-2.3 2.3-2.3 5.6s2.4 6.4 2.7 6.9c.3.4 4.7 7.5 11.6 10 5.7 2 6.9 1.6 8.1 1.5 1.3-.1 4-1.7 4.6-3.3.6-1.6.6-3 .4-3.3-.2-.3-.7-.5-1.5-.9l-4.7-2.2c-.7-.3-1.2-.5-1.7.3-.5.7-1.9 2.3-2.3 2.8-.4.5-.8.6-1.6.2-.7-.4-3.1-1.2-5.9-3.8a22 22 0 0 1-4.1-5.1c-.4-.7 0-1.1.3-1.5l1.1-1.3c.4-.4.5-.7.7-1.2.3-.5.1-.9 0-1.3l-1.9-4.2Z"
                />
              </svg>
            </span>
            <span className="api-logo meta-logo" title="Meta">
              <svg viewBox="0 0 64 40" role="img" aria-label="Meta">
                <path d="M6 30.5C6 20 11.5 8.5 18.7 8.5c6.6 0 11.3 10.8 13.7 15.3 2.6 4.9 5.2 8 9.4 8 6.7 0 12-8.6 12-17 0-4.2-1.5-6.3-4.3-6.3-4.7 0-9.9 7.2-14.2 14.2L30 31c-4.7 7-7.4 8-11 8C11.2 39 6 35.5 6 30.5Z" />
              </svg>
            </span>
          </div>

          <div className="lead-notifications" aria-hidden="true">
            <article className="lead-push push-one">
              <span className="lead-avatar">
                MC<i />
              </span>
              <div>
                <small>NOVO LEAD</small>
                <strong>Mariana Costa</strong>
                <p>Solicitou uma demonstração</p>
              </div>
              <time>agora</time>
            </article>
            <article className="lead-push push-two">
              <span className="lead-avatar avatar-blue">
                RL<i />
              </span>
              <div>
                <small>LEAD QUALIFICADO</small>
                <strong>Rafael Lima</strong>
                <p>Respondeu pelo WhatsApp</p>
              </div>
              <time>1 min</time>
            </article>
            <article className="lead-push push-three">
              <span className="lead-avatar avatar-pink">
                AS<i />
              </span>
              <div>
                <small>NOVA OPORTUNIDADE</small>
                <strong>Ana Souza</strong>
                <p>Avançou para negociação</p>
              </div>
              <time>2 min</time>
            </article>
          </div>

          <div className="login-content">
            <div className="mobile-brand brand">
              <img
                className="brand-logo"
                src={marca.logoHorizontal}
                alt={`${APP_NAME} — CRM inteligente`}
              />
            </div>

            <div className="login-heading">
              <span className="welcome-icon">✦</span>
              <h2 id="login-title">Bem-vindo de volta</h2>
              <p>Entre para continuar sua jornada.</p>
            </div>

            <form id="loginForm" onSubmit={handleLogin} noValidate>
              <div className={`field${erroEmail ? ' invalid' : ''}`}>
                <label htmlFor="email">E-mail</label>
                <div className="input-wrap">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 5.5h16v13H4zM4.5 6l7.5 6 7.5-6" />
                  </svg>
                  <input
                    id="email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    placeholder="voce@empresa.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    required
                  />
                </div>
                <small className="error">{erroEmail}</small>
              </div>

              <div className={`field${erroSenha ? ' invalid' : ''}`}>
                <div className="label-row">
                  <label htmlFor="password">Senha</label>
                </div>
                <div className="input-wrap">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M6 10h12v10H6zM8.5 10V7.5a3.5 3.5 0 0 1 7 0V10" />
                  </svg>
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Digite sua senha"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    required
                  />
                  <button
                    className="password-toggle"
                    type="button"
                    aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword(v => !v)}
                  >
                    <svg viewBox="0 0 24 24">
                      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
                      <circle cx="12" cy="12" r="2.5" />
                    </svg>
                  </button>
                </div>
                <small className="error">{erroSenha}</small>
              </div>

              {erroGeral && (
                <small className="error" role="alert" style={{ marginBottom: 14 }}>
                  {erroGeral}
                </small>
              )}

              <button className="submit-button" type="submit" disabled={loading}>
                <span>{loading ? 'Autenticando...' : 'Entrar no sistema'}</span>
                <b>→</b>
                <i />
              </button>
            </form>
          </div>
        </section>
      </main>

      <footer>
        <span>
          © {new Date().getFullYear()} {APP_NAME.toUpperCase()} CRM.
        </span>
      </footer>

      <div className={`success-screen${sucesso ? ' open' : ''}`} aria-hidden={!sucesso}>
        <div className="energy-grid" />
        <div className="energy-ring ring-one" />
        <div className="energy-ring ring-two" />
        <div className="particles" aria-hidden="true">
          {montado &&
            particulas.map((p, i) => (
              <i
                key={i}
                style={
                  {
                    ['--x' as string]: p.x,
                    ['--y' as string]: p.y,
                    ['--delay' as string]: p.delay,
                    ['--size' as string]: p.size,
                    ['--drift' as string]: p.drift,
                  } as React.CSSProperties
                }
              />
            ))}
        </div>
        <div className="light-scan" />
        <div className="success-glow" />
        <div className="success-brand success-identity">
          <img
            className="success-wordmark"
            src={marca.logoHorizontal}
            alt={`${APP_NAME} — CRM inteligente`}
          />
        </div>
        <div className="success-check">✓</div>
        <h2>Que bom ter você aqui.</h2>
        <p>Seu universo está pronto para começar.</p>
        <div className="loader">
          <i />
        </div>
      </div>
    </>
  );
}
