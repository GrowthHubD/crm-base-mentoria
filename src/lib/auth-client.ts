/**
 * Cliente better-auth pro browser.
 * Use signIn/signOut/useSession nas páginas.
 *
 * baseURL é dinâmico: no browser usa o origin atual (funciona em qualquer porta);
 * no SSR cai no env var. Evita bug "fetch failed" quando dev server muda de porta.
 */
import { createAuthClient } from 'better-auth/react';

const baseURL =
  typeof window !== 'undefined'
    ? window.location.origin
    : process.env.NEXT_PUBLIC_AUTH_URL ?? 'http://localhost:3000';

export const authClient = createAuthClient({ baseURL });

export const { signIn, signOut, useSession, signUp } = authClient;
