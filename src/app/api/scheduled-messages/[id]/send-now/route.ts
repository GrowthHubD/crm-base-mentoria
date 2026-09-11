/**
 * POST /api/scheduled-messages/[id]/send-now — dispara o envio imediatamente
 * (remove o delay do job BullMQ). Idempotente — falha se já enviado/cancelado.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { db } from '@/lib/db/client';
import { scheduledMessages } from '@/lib/db/schema/scheduled-messages';
import { eq } from 'drizzle-orm';
import { sendNow } from '@/modules/scheduler/service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;

  const [row] = await db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, id))
    .limit(1);
  if (!row) return NextResponse.json({ error: 'agendamento não encontrado' }, { status: 404 });

  try {
    await sendNow(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'erro' }, { status: 400 });
  }
}
