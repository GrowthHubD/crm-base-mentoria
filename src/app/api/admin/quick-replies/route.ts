/**
 * GET  /api/admin/quick-replies — lista atalhos.
 *   Aberto pra qualquer atendente autenticado (precisa pra montar o picker do "/").
 * POST /api/admin/quick-replies — cria atalho.
 *   Liberado pra qualquer membro autenticado (atendente incluso): textos rápidos
 *   são ferramenta de equipe.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { listByUnit, create, type QuickReplyInput } from '@/modules/quick-replies';

export async function GET(req: NextRequest) {
  // GET aberto pra qualquer user autenticado — atendente precisa
  // pra montar o picker do slash command.
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const items = await listByUnit();
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  let body: QuickReplyInput;
  try {
    body = (await req.json()) as QuickReplyInput;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  try {
    const row = await create(body);
    return NextResponse.json({ item: row }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro inesperado';
    // Erro de unique constraint vem como "duplicate key value" do PG.
    if (/duplicate key/i.test(message) || /unique constraint/i.test(message)) {
      return NextResponse.json({ error: 'já existe um atalho com esse gatilho' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
