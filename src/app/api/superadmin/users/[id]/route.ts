/**
 * PUT    /api/superadmin/users/[id] — altera nome, e-mail de login, senha, role
 * DELETE /api/superadmin/users/[id] — remove usuário
 *
 * Senha e e-mail entraram porque o admin precisa administrar o acesso dos BDRs
 * (resetar senha esquecida, corrigir o e-mail de login) sem depender de script.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, type UserRole } from '@/lib/auth-helpers';
import { unidadesAtivas } from '@/lib/units';
import { auth } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { users, accounts } from '@/lib/db/schema/users';
import { eq, and, ne, sql } from 'drizzle-orm';

const VALID_ROLES: UserRole[] = ['admin', 'attendant'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;
  // Administrar contas é global: admin preso a uma unidade não cria conta
  // global nem troca a senha de outra unidade para furar o recorte de leads.
  if (unidadesAtivas() && guard.user.unitId) {
    return NextResponse.json({ error: 'Administração de contas exige acesso global' }, { status: 403 });
  }

  const { id } = await params;
  let body: { name?: string; role?: UserRole; email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  if (body.role !== undefined && !VALID_ROLES.includes(body.role)) {
    return NextResponse.json({ error: 'role inválida' }, { status: 400 });
  }
  // Rebaixar a si mesmo tira o próprio acesso admin — recusa, é quase sempre
  // engano e deixaria o admin trancado para fora da gestão.
  if (id === guard.user.id && body.role !== undefined && body.role !== 'admin') {
    return NextResponse.json({ error: 'não é possível remover seu próprio acesso de admin' }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.role !== undefined) patch.role = body.role;

  if (body.email !== undefined) {
    const email = body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: 'e-mail inválido' }, { status: 400 });
    }
    // O login É o e-mail; dois usuários com o mesmo e-mail deixariam o login
    // ambíguo. Recusa antes de gravar.
    const [jaUsa] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, email), ne(users.id, id)))
      .limit(1);
    if (jaUsa) {
      return NextResponse.json({ error: 'já existe um usuário com esse e-mail' }, { status: 409 });
    }
    patch.email = email;
  }

  await db.update(users).set(patch).where(eq(users.id, id));

  // Senha vive em `accounts`, não em `users`, e o hash tem que sair do MESMO
  // caminho do better-auth (formato interno da lib) — hash montado à mão quebra
  // o login sem erro visível.
  if (body.password !== undefined) {
    const senha = body.password;
    if (senha.length < 6) {
      return NextResponse.json({ error: 'senha muito curta (mín. 6)' }, { status: 400 });
    }
    const ctx = await auth.$context;
    const hash = await ctx.password.hash(senha);
    const upd = await db
      .update(accounts)
      .set({ password: hash, updatedAt: new Date() })
      .where(and(eq(accounts.userId, id), eq(accounts.providerId, 'credential')))
      .returning({ id: accounts.id });
    if (upd.length === 0) {
      return NextResponse.json(
        { error: 'usuário sem credencial de senha' },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;
  // Administrar contas é global: admin preso a uma unidade não cria conta
  // global nem troca a senha de outra unidade para furar o recorte de leads.
  if (unidadesAtivas() && guard.user.unitId) {
    return NextResponse.json({ error: 'Administração de contas exige acesso global' }, { status: 403 });
  }

  const { id } = await params;
  if (id === guard.user.id) {
    return NextResponse.json({ error: 'não é possível remover a si mesmo' }, { status: 400 });
  }

  // Antes de apagar, o que este usuário ainda "segura". Várias FKs para
  // `users` não têm regra de exclusão (messages.sent_by_id, leads.assigned_to_id,
  // converted_by_id, scheduled_messages, attendance_log): o Postgres recusa o
  // DELETE e, sem isto, a rota estourava em 500 sem dizer por quê. Leads e
  // conexões por `owner_id` nem têm FK — apagar o dono deixaria carteira órfã
  // invisível para os BDRs. Regra: usuário com dado ligado NÃO se apaga; o
  // admin reatribui (ou rebaixa) primeiro. Sessão/login/e-mail caem em cascata.
  const [dep] = (await db.execute(sql`
    select
      (select count(*) from leads where owner_id = ${id} or assigned_to_id = ${id} or converted_by_id = ${id})::int as leads,
      (select count(*) from connections where owner_id = ${id})::int as conexoes,
      (select count(*) from messages where sent_by_id = ${id})::int as mensagens,
      (select count(*) from scheduled_messages where created_by_id = ${id})::int as agendamentos,
      (select count(*) from attendance_log where user_id = ${id})::int as atendimentos
  `)) as unknown as Array<{ leads: number; conexoes: number; mensagens: number; agendamentos: number; atendimentos: number }>;

  const presos: string[] = [];
  if (dep?.leads) presos.push(`${dep.leads} lead(s)`);
  if (dep?.conexoes) presos.push(`${dep.conexoes} conexão(ões)`);
  if (dep?.mensagens) presos.push(`${dep.mensagens} mensagem(ns) enviada(s)`);
  if (dep?.agendamentos) presos.push(`${dep.agendamentos} agendamento(s)`);
  if (dep?.atendimentos) presos.push(`${dep.atendimentos} registro(s) de atendimento`);
  if (presos.length) {
    return NextResponse.json(
      { error: `Este usuário ainda tem ${presos.join(', ')}. Reatribua os leads e a conexão a outra pessoa antes de remover — ou apenas mude o cargo/senha.` },
      { status: 409 }
    );
  }

  try {
    await db.delete(users).where(eq(users.id, id));
  } catch (err) {
    // Rede de segurança para uma FK que a checagem acima não conheça.
    return NextResponse.json(
      { error: 'Não foi possível remover: o usuário ainda tem dados ligados a ele.', detalhe: err instanceof Error ? err.message : String(err) },
      { status: 409 }
    );
  }
  return NextResponse.json({ ok: true });
}
