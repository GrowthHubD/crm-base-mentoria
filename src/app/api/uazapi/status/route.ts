/**
 * GET /api/uazapi/status — retorna status da instância configurada.
 * Útil pra UI da página /conexoes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getStatus } from '@/modules/channels/whatsapp/client';
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { whatsappInstances } from '@/lib/db/schema/whatsapp-instances';
import { eq } from 'drizzle-orm';
import { decrypt } from '@/lib/encryption';
import { requireSession } from '@/lib/auth-helpers';

export async function GET(req: NextRequest) {
  // Sem esta guarda a rota devolvia id da conexão, número e status de conexão
  // pra qualquer um com um cookie inventado — e ainda gastava chamada na uazapi
  // por conta do cliente. O middleware não cobre: ele só vê se o cookie existe.
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const url = new URL(req.url);
  const connectionId = url.searchParams.get('connectionId');

  let row;
  if (connectionId) {
    [row] = await db.select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  } else {
    [row] = await db.select().from(connections).where(eq(connections.type, 'whatsapp')).limit(1);
  }

  if (!row) return NextResponse.json({ status: 'not_configured' });

  let token: string | undefined;
  if (row.accessTokenEncrypted) {
    try {
      token = decrypt(row.accessTokenEncrypted);
    } catch { /* ignore */ }
  }
  token = token ?? process.env.UAZAPI_TOKEN;

  // Lookup phone via whatsapp_instances
  const [inst] = await db
    .select({ instanceId: whatsappInstances.instanceId, phone: whatsappInstances.phone })
    .from(whatsappInstances)
    .where(eq(whatsappInstances.connectionId, row.id))
    .limit(1);

  const remote = token ? await getStatus(token) : { status: 'unknown' };
  return NextResponse.json({
    connection: {
      id: row.id,
      status: row.status,
      externalId: row.externalId,
      phoneNumber: row.phoneNumber,
      displayName: row.displayName,
    },
    instance: inst ?? null,
    remote,
  });
}
