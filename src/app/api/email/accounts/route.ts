/**
 * GET    /api/email/accounts      — caixas de e-mail no escopo do usuário
 * DELETE /api/email/accounts?id=  — desconecta uma
 *
 * `requireSession` e não `requireAdmin` porque o BDR administra a PRÓPRIA caixa.
 * O recorte é por dono (ver `escopoDono`): ADMIN vê e desconecta TODAS as
 * caixas; o BDR só a dele — o `userId` da sessão entra na consulta e é o que
 * impede um BDR de ver ou remover a conta de outro.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { listAccounts, disconnect } from '@/modules/email/service';
import { escopoDono } from '@/lib/escopo-dono';

// Traduz o escopo de dono para a listagem de caixas: admin vê todas.
function escoparContas(user: { id: string; role: 'admin' | 'attendant' }) {
  const d = escopoDono(user);
  return { userId: user.id, veTudo: d.veTudo };
}
import { isGmailConfigured } from '@/modules/email/gmail-client';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  try {
    return NextResponse.json({
      // A tela usa isto para mostrar "peça ao administrador" em vez de um
      // botão que só daria erro.
      configurado: isGmailConfigured(),
      accounts: await listAccounts(escoparContas(guard.user)),
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[email] listar contas falhou');
    return NextResponse.json({ error: 'Erro ao listar contas' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'Informe o id da conta' }, { status: 400 });

  try {
    const ok = await disconnect(escoparContas(guard.user), id);
    if (!ok) return NextResponse.json({ error: 'Conta não encontrada' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[email] desconectar falhou');
    return NextResponse.json({ error: 'Erro ao desconectar' }, { status: 500 });
  }
}
