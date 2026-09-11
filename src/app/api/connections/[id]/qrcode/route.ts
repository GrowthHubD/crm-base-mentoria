/**
 * GET /api/connections/[id]/qrcode — busca QR code atual da instância.
 *
 * Polled pela UI durante onboarding até `connected: true`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAConexao } from '@/lib/escopo-dono';
import { getInstanceQrCode } from '@/modules/channels/service';
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
    const result = await getInstanceQrCode(id);
    return NextResponse.json(result);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, connectionId: id },
      '[GET /api/connections/:id/qrcode] falha'
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
