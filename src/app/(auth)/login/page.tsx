/**
 * A tela em si vive em `login-client.tsx` — este arquivo só resolve QUAL marca
 * ela veste. Precisa ser Server Component: a marca vem de variável de ambiente
 * em runtime (um build, sete Workers), e o client não enxerga `process.env`.
 * As cores por marca ficam em `login.css`, sob `html[data-marca]`.
 */
import { marcaDoDeploy } from '@/lib/marca';
import LoginClient from './login-client';

const IDENTIDADE = {
  lidy: { nome: 'Lidy', logoHorizontal: '/lidy-logo-horizontal.png', logoIcone: '/logo.png' },
  // A Acme não tem versão horizontal do logotipo — o ícone serve nos três
  // lugares (cabeçalho, vitrine e tela de sucesso), dimensionado pelo CSS.
  acme: { nome: 'Acme', logoHorizontal: '/logo-acme.png', logoIcone: '/logo-acme.png' },
} as const;

export default function LoginPage() {
  return <LoginClient marca={IDENTIDADE[marcaDoDeploy()]} />;
}
