/**
 * PATCH  /api/messages/[id] — toggle star OR edit body (type=text outbound only).
 * DELETE /api/messages/[id] — apaga do CRM (e tenta apagar no WhatsApp se outbound).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAMensagem } from '@/lib/escopo-dono';
import { toggleStar, deleteMessageFromCRM, editMessageBody } from '@/modules/messages/service';
import { logger } from '@/lib/logger';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAMensagem(guard.user, id);
  if ('response' in acesso) return acesso.response;
  let body: { action?: string; body?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  try {
    if (body.action === 'toggleStar') {
      const message = await toggleStar(id);
      return NextResponse.json({ message });
    }
    if (body.action === 'edit') {
      if (typeof body.body !== 'string' || !body.body.trim()) {
        return NextResponse.json({ error: 'body obrigatório pra edit' }, { status: 400 });
      }
      const message = await editMessageBody(id, body.body.trim());
      return NextResponse.json({ message });
    }
    return NextResponse.json({ error: 'action inválida (toggleStar | edit)' }, { status: 400 });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, id }, '[PATCH messages/:id] falha');
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 400 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAMensagem(guard.user, id);
  if ('response' in acesso) return acesso.response;
  try {
    await deleteMessageFromCRM(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, id }, '[DELETE messages/:id] falha');
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 400 }
    );
  }
}
