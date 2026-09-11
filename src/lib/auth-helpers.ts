/**
 * Helpers de autorização pra API routes — single-tenant, 2 roles.
 *
 *   admin:      acesso total (config, canais, IA, usuários)
 *   attendant:  atende leads no CRM, sem páginas administrativas
 */
import { NextResponse, type NextRequest } from 'next/server';
import { auth } from './auth';
import { db } from './db/client';
import { users } from './db/schema/users';
import { eq } from 'drizzle-orm';
import { logger } from './logger';
import { describeDbError } from './db/errors';

export type UserRole = 'admin' | 'attendant';

export interface AuthedRequestUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  /** Unidade do usuário. NULO = enxerga todas as filiais. Carregado junto com
   *  a sessão porque TODA consulta com recorte de unidade depende dele — se
   *  viesse de outro lugar, haveria caminho para a tela mandar um valor e o
   *  servidor acreditar. */
  unitId: string | null;
}

/**
 * Verifica sessão e carrega user com role.
 */
export async function requireSession(
  req: NextRequest
): Promise<{ user: AuthedRequestUser } | { response: NextResponse }> {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session?.user?.id) {
    return { response: NextResponse.json({ error: 'unauthenticated' }, { status: 401 }) };
  }

  // Esta consulta roda em TODA requisição autenticada — é o portão por onde
  // tudo passa, e por isso é onde o 500 intermitente aparecia, sorteando qual
  // tela levava o tombo. O try/catch aqui é só para gravar a CAUSA: sem ele o
  // log recebia apenas o "Failed query: ..." que o Drizzle monta, que diz qual
  // consulta caiu e nada sobre o motivo.
  //
  // O erro é relançado igual: o comportamento não muda, só passa a deixar
  // rastro.
  let row: AuthedRequestUser | undefined;
  try {
    [row] = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        name: users.name,
        unitId: users.unitId,
      })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
  } catch (err) {
    logger.error(
      { ...describeDbError(err), rota: req.nextUrl?.pathname },
      'falha ao carregar usuário da sessão'
    );
    throw err;
  }

  if (!row) {
    return { response: NextResponse.json({ error: 'user not found' }, { status: 401 }) };
  }

  return { user: row };
}

/**
 * Admin. Atendentes recebem 403.
 */
export async function requireAdmin(
  req: NextRequest
): Promise<{ user: AuthedRequestUser } | { response: NextResponse }> {
  const result = await requireSession(req);
  if ('response' in result) return result;
  if (result.user.role !== 'admin') {
    return {
      response: NextResponse.json({ error: 'forbidden — admin only' }, { status: 403 }),
    };
  }
  return result;
}
