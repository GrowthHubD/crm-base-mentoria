/**
 * GET /api/connections/[id]/status — sincroniza status remoto da uazapi com o DB.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAConexao } from '@/lib/escopo-dono';
import { syncInstanceStatus } from '@/modules/channels/service';
import { UazapiError } from '@/modules/channels/whatsapp/client';
import { logger } from '@/lib/logger';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAConexao(guard.user, id);
  if ('response' in acesso) return acesso.response;
  try {
    const result = await syncInstanceStatus(id);
    return NextResponse.json(result);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, connectionId: id },
      '[GET /api/connections/:id/status] falha'
    );
    if (err instanceof UazapiError) {
      return NextResponse.json(
        { error: err.message, transient: err.isTransient() },
        { status: err.isTransient() ? 502 : 400 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 500 }
    );
  }
}
