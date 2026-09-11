/**
 * POST /api/messages/[id]/react — atendente reage à mensagem com emoji.
 *
 * Body: { emoji: string }  ('' remove reação anterior do mesmo sender).
 *
 * Fluxo:
 *  1. Persiste a reação localmente (upsertMessageReaction — substitui reação
 *     anterior do mesmo sender, WhatsApp-style).
 *  2. Best-effort: chama adapter.reactToMessage pra refletir no WhatsApp.
 *     Falha de adapter NÃO derruba a request — a reação fica no CRM mesmo
 *     que o WA não tenha sido informado (provider sem suporte, sem token, etc.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAMensagem } from '@/lib/escopo-dono';
import { reads as messageReads } from '@/modules/messages/service';
import { upsertMessageReaction } from '@/modules/messages/mutations';
import { reads as leadReads } from '@/modules/leads/service';
import { getAdapterForLead } from '@/modules/channels/service';
import { logger } from '@/lib/logger';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/users';
import { eq } from 'drizzle-orm';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAMensagem(guard.user, id);
  if ('response' in acesso) return acesso.response;
  let body: { emoji?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const emoji = typeof body.emoji === 'string' ? body.emoji.slice(0, 4) : '';

  const message = await messageReads.getById(id);
  if (!message) return NextResponse.json({ error: 'mensagem não encontrada' }, { status: 404 });

  const [userRow] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, guard.user.id))
    .limit(1);
  const senderName = userRow?.name ?? null;

  // Reação como 'human' — o atendente humano logado é o reactor. Se mais de
  // um atendente da unit reagir na mesma msg, mantemos uma entrada por user
  // via externalSenderId = userId.
  const reactions = await upsertMessageReaction(id, {
    emoji,
    sender: 'human',
    senderName,
    externalSenderId: guard.user.id,
    timestamp: new Date().toISOString(),
  });

  // Propaga pro WhatsApp se a msg tem external_id (já chegou no WA) e há
  // connection viável. Se não tiver external_id (msg ainda pending), pula —
  // a reação no WA exige que a msg target já exista lá.
  if (message.externalId) {
    const lead = await leadReads.getById(message.leadId);
    const contactId = lead?.externalContactId;
    if (lead && contactId) {
      try {
        const adapter = await getAdapterForLead(message.leadId);
        await adapter.reactToMessage(message.externalId, contactId, emoji);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, messageId: id, externalId: message.externalId },
          '[api:messages.react] propagar pro WhatsApp falhou (reação local mantida)'
        );
      }
    }
  }

  return NextResponse.json({ reactions });
}
