/**
 * PUT    /api/admin/quick-replies/[id] — atualiza atalho.
 * DELETE /api/admin/quick-replies/[id] — remove atalho.
 *
 * Liberado pra qualquer membro autenticado (atendente incluso).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { update, remove, type QuickReplyInput } from '@/modules/quick-replies';

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;

  let body: QuickReplyInput;
  try {
    body = (await req.json()) as QuickReplyInput;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  try {
    const row = await update(id, body);
    if (!row) return NextResponse.json({ error: 'atalho não encontrado' }, { status: 404 });
    return NextResponse.json({ item: row });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro inesperado';
    if (/duplicate key/i.test(message) || /unique constraint/i.test(message)) {
      return NextResponse.json({ error: 'já existe um atalho com esse gatilho' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;

  const ok = await remove(id);
  if (!ok) return NextResponse.json({ error: 'atalho não encontrado' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
