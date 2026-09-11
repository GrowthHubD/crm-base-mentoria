/**
 * PUT    /api/scheduled-messages/[id] — edita body / scheduledAt / nota interna
 * DELETE /api/scheduled-messages/[id] — cancela
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { db } from '@/lib/db/client';
import { scheduledMessages } from '@/lib/db/schema/scheduled-messages';
import { eq } from 'drizzle-orm';
import { editScheduled, cancelById, getById } from '@/modules/scheduler/service';

async function assertExists(id: string) {
  const [row] = await db
    .select({ id: scheduledMessages.id })
    .from(scheduledMessages)
    .where(eq(scheduledMessages.id, id))
    .limit(1);
  if (!row) return { ok: false as const, status: 404, error: 'agendamento não encontrado' };
  return { ok: true as const };
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const check = await assertExists(id);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  let body: { body?: string; scheduledAt?: string | number; internalNote?: string | null; mediaUrl?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const patch: Parameters<typeof editScheduled>[1] = {};
  if (body.body !== undefined) {
    if (!body.body.trim()) return NextResponse.json({ error: 'mensagem vazia' }, { status: 400 });
    patch.body = body.body.trim();
  }
  if (body.scheduledAt !== undefined) {
    const d = new Date(body.scheduledAt);
    if (Number.isNaN(d.getTime())) return NextResponse.json({ error: 'scheduledAt inválido' }, { status: 400 });
    patch.scheduledAt = d;
  }
  if (body.internalNote !== undefined) patch.internalNote = body.internalNote;
  if (body.mediaUrl !== undefined) patch.mediaUrl = body.mediaUrl;

  try {
    await editScheduled(id, patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'erro' }, { status: 400 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const check = await assertExists(id);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  await cancelById(id, 'cancelled_by_user');
  return NextResponse.json({ ok: true });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const check = await assertExists(id);
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: check.status });

  const row = await getById(id);
  return NextResponse.json({ scheduled: row });
}
