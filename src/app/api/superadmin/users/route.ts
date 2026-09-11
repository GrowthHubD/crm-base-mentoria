/**
 * GET  /api/superadmin/users — lista todos os usuários com role
 * POST /api/superadmin/users — cria usuário e atribui role
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, type UserRole } from '@/lib/auth-helpers';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/users';
import { auth } from '@/lib/auth';
import { asc, eq } from 'drizzle-orm';

const VALID_ROLES: UserRole[] = ['admin', 'attendant'];

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.email));

  return NextResponse.json({ items: rows });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let body: {
    email?: string;
    password?: string;
    name?: string;
    role?: UserRole;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  if (!body.email || !body.password || !body.name) {
    return NextResponse.json({ error: 'email, password e name obrigatórios' }, { status: 400 });
  }
  if (!body.role || !VALID_ROLES.includes(body.role)) {
    return NextResponse.json({ error: 'role inválida' }, { status: 400 });
  }

  try {
    await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'falha criando usuário';
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  await db
    .update(users)
    .set({
      role: body.role,
      updatedAt: new Date(),
    })
    .where(eq(users.email, body.email));

  return NextResponse.json({ ok: true }, { status: 201 });
}
