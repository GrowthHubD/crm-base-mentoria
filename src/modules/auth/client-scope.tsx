'use client';

import { createContext, useContext, useMemo } from 'react';
import { definirEscopoAutenticado } from '@/lib/useDados';

export interface AuthScope {
  userId: string;
  role: 'admin' | 'attendant';
  veTudo: boolean;
  kanbanManual: boolean;
}

const AuthScopeContext = createContext<AuthScope | null>(null);

export function AuthScopeProvider({
  userId,
  role,
  veTudo,
  kanbanManual,
  children,
}: AuthScope & {
  children: React.ReactNode;
}) {
  definirEscopoAutenticado(userId);
  const value = useMemo(
    () => ({ userId, role, veTudo, kanbanManual }),
    [userId, role, veTudo, kanbanManual]
  );
  return (
    <AuthScopeContext.Provider value={value}>
      {children}
    </AuthScopeContext.Provider>
  );
}

/** Identidade estavel usada apenas para isolar estado e cache no navegador. */
export function useAuthScopeKey(): string | null {
  return useContext(AuthScopeContext)?.userId ?? null;
}

export function useAuthScope(): AuthScope {
  const scope = useContext(AuthScopeContext);
  if (!scope) throw new Error('AuthScopeProvider ausente no layout autenticado');
  return scope;
}
