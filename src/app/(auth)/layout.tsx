import { Manrope } from 'next/font/google';

/**
 * Layout do grupo (auth) — hoje só a tela de login.
 *
 * Existe por causa da fonte. O CSS que veio com o front pede `Manrope` pelo
 * nome literal, e sem ela tudo cai em `system-ui`: os pesos 700/800 dos títulos
 * somem e a tela deixa de parecer o que foi desenhado.
 *
 * `next/font` em vez do `<link>` do Google Fonts que o HTML original usava: a
 * fonte passa a ser servida junto com o app, sem requisição a terceiro no
 * carregamento — e `next/font` já declara a família com o nome real, então o
 * `font-family: Manrope` do CSS continua resolvendo sem precisar tocar nele.
 *
 * Fica NESTE grupo e não no layout raiz de propósito: o resto do CRM usa o
 * design system de `globals.css` e não deve herdar a tipografia da vitrine.
 */
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
});

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <div className={manrope.className}>{children}</div>;
}
