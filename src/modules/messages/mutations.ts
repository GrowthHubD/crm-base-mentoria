/**
 * Mutations (writes) do módulo messages.
 */
import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema/messages';
import { eq } from 'drizzle-orm';
import type { Message, MessageDirection, MessageType, MessageSender, MessageStatus } from './types';

export interface InsertMessageInput {
  leadId: string;
  externalId?: string | null;
  direction: MessageDirection;
  type?: MessageType;
  sender: MessageSender;
  sentById?: string | null;
  body?: string | null;
  mediaUrl?: string | null;
  mediaCaption?: string | null;
  mimeType?: string | null;
  fileName?: string | null;
  quotedMessageId?: string | null;
  quotedContent?: string | null;
  senderName?: string | null;
  status?: MessageStatus;
  failedReason?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Timestamp da mensagem (default: now). Útil pra mensagens vindas do webhook
   *  com timestamp original do WhatsApp. */
  timestamp?: Date;
}

/**
 * Insere mensagem nova. Lança erro se externalId já existir (constraint UNIQUE).
 * Use `insertMessageIdempotent` para tolerar duplicatas.
 */
export async function insertMessage(input: InsertMessageInput): Promise<{ id: string }> {
  const [created] = await db
    .insert(messages)
    .values({
      leadId: input.leadId,
      externalId: input.externalId ?? null,
      direction: input.direction,
      type: input.type ?? 'text',
      sender: input.sender,
      sentById: input.sentById,
      body: input.body,
      mediaUrl: input.mediaUrl,
      mediaCaption: input.mediaCaption,
      mimeType: input.mimeType,
      fileName: input.fileName,
      quotedMessageId: input.quotedMessageId,
      quotedContent: input.quotedContent,
      senderName: input.senderName,
      status: input.status ?? (input.direction === 'inbound' ? 'sent' : 'pending'),
      failedReason: input.failedReason,
      metadata: input.metadata,
      timestamp: input.timestamp ?? new Date(),
    })
    .returning({ id: messages.id });
  return created;
}

/**
 * Insere com idempotência por externalId. Retorna `{ id, isNew }`. Se já
 * existia, retorna o id antigo sem inserir nada.
 */
export async function insertMessageIdempotent(
  input: InsertMessageInput
): Promise<{ id: string; isNew: boolean }> {
  if (input.externalId) {
    const [existing] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.externalId, input.externalId))
      .limit(1);
    if (existing) return { id: existing.id, isNew: false };
  }
  const created = await insertMessage(input);
  return { id: created.id, isNew: true };
}

/**
 * Atualiza status de uma mensagem (entrega, leitura, falha) — chamado pelo
 * webhook `messages_update` da uazapi e pelo worker outbound.
 */
export async function updateMessageStatus(
  id: string,
  status: MessageStatus,
  opts: { failedReason?: string | null; externalId?: string | null } = {}
): Promise<void> {
  const update: Record<string, unknown> = { status };
  if (status === 'delivered') update.delivered = true;
  if (status === 'read') {
    update.delivered = true;
    update.read = true;
  }
  if (opts.failedReason !== undefined) update.failedReason = opts.failedReason;
  if (opts.externalId !== undefined) update.externalId = opts.externalId;
  await db.update(messages).set(update).where(eq(messages.id, id));
}

/**
 * Atualiza externalId quando o adapter retorna o uazapi message_id depois do envio.
 */
export async function setExternalId(id: string, externalId: string): Promise<void> {
  await db.update(messages).set({ externalId }).where(eq(messages.id, id));
}

/**
 * Atualiza o body de uma mensagem inbound a partir do externalId. Usado para
 * persistir edições de mensagem recebidas via webhook (`messages_update` da
 * uazapi quando carrega novo texto). Retorna a linha resultante (id, leadId,
 * oldBody) ou null se a mensagem não existe.
 */
export async function updateInboundMessageBody(
  externalId: string,
  newBody: string
): Promise<{ id: string; leadId: string; oldBody: string | null } | null> {
  const [existing] = await db
    .select({ id: messages.id, leadId: messages.leadId, oldBody: messages.body })
    .from(messages)
    .where(eq(messages.externalId, externalId))
    .limit(1);
  if (!existing) return null;
  if (existing.oldBody === newBody) return existing;
  await db.update(messages).set({ body: newBody }).where(eq(messages.id, existing.id));
  return existing;
}

export async function setEmbedding(id: string, embedding: number[]): Promise<void> {
  await db.update(messages).set({ embedding }).where(eq(messages.id, id));
}

import type { MessageReaction } from '@/lib/db/schema/messages';
export type { MessageReaction };

/**
 * Adiciona/atualiza uma reação à mensagem. Substitui qualquer reação anterior
 * do MESMO sender (WhatsApp-style: 1 reação por pessoa). `emoji=''` REMOVE a
 * reação desse sender. Retorna a lista atualizada de reactions.
 */
export async function upsertMessageReaction(
  messageId: string,
  reaction: MessageReaction
): Promise<MessageReaction[]> {
  const [row] = await db
    .select({ reactions: messages.reactions })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  if (!row) throw new Error(`message ${messageId} não encontrada`);
  const current = (row.reactions ?? []) as MessageReaction[];

  // Filtra reações antigas do mesmo sender (e mesmo externalSenderId quando aplicável).
  const filtered = current.filter(r => {
    if (r.sender !== reaction.sender) return true;
    if (reaction.externalSenderId && r.externalSenderId !== reaction.externalSenderId) return true;
    return false;
  });
  const next = reaction.emoji ? [...filtered, reaction] : filtered;
  await db.update(messages).set({ reactions: next }).where(eq(messages.id, messageId));
  return next;
}

/** Idem `upsertMessageReaction` mas localiza a msg pelo externalId. */
export async function upsertMessageReactionByExternalId(
  externalId: string,
  reaction: MessageReaction
): Promise<{ messageId: string; leadId: string; reactions: MessageReaction[] } | null> {
  const [row] = await db
    .select({ id: messages.id, leadId: messages.leadId, reactions: messages.reactions })
    .from(messages)
    .where(eq(messages.externalId, externalId))
    .limit(1);
  if (!row) return null;
  const current = (row.reactions ?? []) as MessageReaction[];
  const filtered = current.filter(r => {
    if (r.sender !== reaction.sender) return true;
    if (reaction.externalSenderId && r.externalSenderId !== reaction.externalSenderId) return true;
    return false;
  });
  const next = reaction.emoji ? [...filtered, reaction] : filtered;
  await db.update(messages).set({ reactions: next }).where(eq(messages.id, row.id));
  return { messageId: row.id, leadId: row.leadId, reactions: next };
}
