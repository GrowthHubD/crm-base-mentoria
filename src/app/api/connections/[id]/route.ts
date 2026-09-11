/**
 * DELETE /api/connections/[id] — desconecta (logout uazapi best-effort) e remove a connection.
 *
 * Cascade do FK em whatsapp_instances deleta a row associada automaticamente.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { garantirAcessoAConexao } from '@/lib/escopo-dono';
import { disconnectInstance } from '@/modules/channels/service';
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { eq } from 'drizzle-orm';
import { logger } from '@/lib/logger';

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // APAGAR conexão derruba o atendimento inteiro do cliente: some o número,
  // e os leads ligados a ele ficam órfãos. Estava em `requireSession`, ou seja,
  // qualquer atendente logado podia apagar pela API — só não via o menu.
  // Esconder na navegação nunca foi bloquear.
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAConexao(guard.user, id);
  if ('response' in acesso) return acesso.response;

  const [conn] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.id, id))
    .limit(1);
  if (!conn) {
    return NextResponse.json({ error: 'conexão não encontrada' }, { status: 404 });
  }

  try {
    await disconnectInstance(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, connectionId: id },
      '[DELETE /api/connections/:id] falha'
    );
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 500 }
    );
  }
}
