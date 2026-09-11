/**
 * POST /api/connections/[id]/webhook — (re)configura o webhook da instância.
 * Útil quando a instância foi criada fora da UI (painel uazapi, scripts) ou
 * quando o webhook precisa ser ressincronizado.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { eq } from 'drizzle-orm';
import { decrypt } from '@/lib/encryption';
import { setWebhook } from '@/modules/channels/whatsapp/client';
import { buildInstanceWebhookUrl } from '@/modules/channels/service';
import { logger } from '@/lib/logger';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const [conn] = await db
    .select({ id: connections.id, accessTokenEncrypted: connections.accessTokenEncrypted })
    .from(connections)
    .where(eq(connections.id, id))
    .limit(1);

  if (!conn) return NextResponse.json({ error: 'Connection não encontrada' }, { status: 404 });

  let token: string | undefined;
  if (conn.accessTokenEncrypted) {
    try { token = decrypt(conn.accessTokenEncrypted); } catch {}
  }
  if (!token) {
    return NextResponse.json(
      { error: 'Connection sem token de instância no DB' },
      { status: 400 }
    );
  }

  const baseUrl = process.env.NEXTAUTH_URL || process.env.BETTER_AUTH_URL;
  if (!baseUrl) {
    return NextResponse.json(
      { error: 'NEXTAUTH_URL/BETTER_AUTH_URL ausente no servidor' },
      { status: 500 }
    );
  }

  const webhookUrl = buildInstanceWebhookUrl(baseUrl, id);
  try {
    const ok = await setWebhook(webhookUrl, token);
    if (!ok) {
      return NextResponse.json(
        { error: 'Falha ao configurar webhook na uazapi' },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true, webhookUrl });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, connectionId: id }, '[POST webhook] erro');
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 500 }
    );
  }
}
