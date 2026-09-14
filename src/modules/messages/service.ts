/**
 * Service layer do módulo messages — orquestra queries+mutations e expõe
 * regras de negócio (idempotência, sanitização, persistência+emission).
 */
import {
  insertMessage,
  insertMessageIdempotent,
  updateMessageStatus,
  setExternalId,
  setEmbedding,
  type InsertMessageInput,
} from './mutations';
import { getMessageById, listMessagesByLead, getConversationHistory, findMessageByExternalId, getPreviousOutboundForSignature, countOutboundsSinceLastInbound } from './queries';
import { bumpActivity, reads as leadReads } from '@/modules/leads/service';
import { getAdapterForLead } from '@/modules/channels/service';
import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema/messages';
import { users } from '@/lib/db/schema/users';
import { eq, and, gt, inArray, isNull } from 'drizzle-orm';
import { emitToEmpresa } from '@/lib/socket';
import { logger } from '@/lib/logger';
import { rolePrefix } from '@/lib/role-label';
import type { UserRole } from '@/lib/auth-helpers';
import type { Message, MessageStatus } from './types';

/** Single-tenant: existe uma única sala Socket.IO pra todo o CRM. */
const CRM_ROOM = 'crm';

export const reads = {
  getById: getMessageById,
  byLead: listMessagesByLead,
  conversation: getConversationHistory,
  byExternalId: findMessageByExternalId,
  previousOutboundForSignature: getPreviousOutboundForSignature,
  countOutboundsSinceLastInbound,
};

/**
 * Persiste mensagem inbound (vinda do webhook). Idempotente por externalId.
 *   - Insere na DB
 *   - Faz bump no lead.lastMessageAt e ajusta status pipeline
 *   - Emite Socket.IO 'message:new'
 *
 * Retorna `{ message, isNew }` — `isNew=false` indica duplicata detectada
 * (caller pode pular o resto do pipeline).
 */
export async function recordInboundMessage(
  input: Omit<InsertMessageInput, 'direction' | 'sender'> & { senderName?: string | null }
): Promise<{ message: Message; isNew: boolean }> {
  const { id, isNew } = await insertMessageIdempotent({
    ...input,
    direction: 'inbound',
    sender: 'lead',
    status: 'sent',
  });

  const message = await getMessageById(id);
  if (!message) throw new Error(`Message ${id} sumiu após insert`);

  if (isNew) {
    await bumpActivity(input.leadId, 'inbound', message.timestamp);
    emitToEmpresa(CRM_ROOM, 'message:new', { message });
  }
  return { message, isNew };
}

/**
 * Cria registro de mensagem outbound (sender atendente ou IA) com status
 * 'pending'. O envio real é feito pelo worker `outbound-message` que vai
 * setar 'sent' (ou 'failed') depois da chamada uazapi.
 */
export async function recordPendingOutbound(
  input: Omit<InsertMessageInput, 'direction'> & { senderName?: string | null }
): Promise<Message> {
  const { id } = await insertMessage({
    ...input,
    direction: 'outbound',
    status: 'pending',
  });
  const message = await getMessageById(id);
  if (!message) throw new Error(`Message ${id} sumiu após insert`);
  emitToEmpresa(CRM_ROOM, 'message:new', { message });
  return message;
}

/**
 * Persiste mensagem que foi enviada PELO CELULAR DO DONO (fromMe via webhook).
 *
 * Idempotência em 2 etapas, pra mitigar race entre webhook e markSent:
 *   1. external_id direto: se já existe linha com esse external_id, retorna
 *      (caso comum — webhook chega depois do markSent persistir).
 *   2. Claim: se NÃO achou por external_id mas chegou um eco com external_id
 *      definido, procura outbound recente (60s) sem external_id e com sender
 *      'human'/'ai' que case com o conteúdo. Se achar, ATUALIZA o external_id
 *      desse registro em vez de criar um eco duplicado. Isso resolve o caso
 *      onde o webhook chega ANTES do worker terminar o markSent.
 *   3. Senão, insere como novo eco do dono (sender='owner').
 */
export async function recordOwnerOutbound(
  input: Omit<InsertMessageInput, 'direction' | 'sender' | 'status'> & { senderName?: string | null }
): Promise<{ message: Message; isNew: boolean }> {
  // Etapa 1: idempotência por external_id
  if (input.externalId) {
    const existing = await findMessageByExternalId(input.externalId);
    if (existing) {
      return { message: existing, isNew: false };
    }
  }

  // Etapa 2: tenta claim de mensagem outbound recente sem external_id
  if (input.externalId) {
    const claimed = await tryClaimRecentOutbound({
      leadId: input.leadId,
      externalId: input.externalId,
      body: input.body ?? null,
      type: input.type ?? 'text',
    });
    if (claimed) {
      logger.info(
        { messageId: claimed.id, externalId: input.externalId, leadId: input.leadId },
        '[messages] eco fromMe deduplicado — external_id reclamado por mensagem CRM existente'
      );
      return { message: claimed, isNew: false };
    }
  }

  // Etapa 3: insert genuíno do eco
  const { id, isNew } = await insertMessageIdempotent({
    ...input,
    direction: 'outbound',
    sender: 'owner',
    status: 'sent',
  });
  const message = await getMessageById(id);
  if (!message) throw new Error(`Message ${id} sumiu após insert`);
  if (isNew) {
    await bumpActivity(input.leadId, 'outbound', message.timestamp);
    emitToEmpresa(CRM_ROOM, 'message:new', { message });
  }
  return { message, isNew };
}

/**
 * Procura uma mensagem outbound recente (último 60s) do mesmo lead, sender
 * `human` ou `ai`, sem external_id e com conteúdo que case. Se achar,
 * "reclama" setando o external_id e retorna a mensagem atualizada.
 *
 * Match por:
 *   - text → text: body exato OU versão assinada (`*Cargo Nome*\n\n${body}`)
 *     bate com input.body (caso comum quando assinatura é adicionada na saída).
 *   - text → mídia (image/video/document): a uazapi às vezes entrega o eco
 *     fromMe da mensagem image+caption como DOIS webhooks separados — um pra
 *     imagem (sem texto) e outro pra texto da caption. Esse 2º vem com
 *     input.type='text'; aceitamos match contra candidates de mídia
 *     comparando o `mediaCaption` (cru) com input.body, considerando também
 *     a versão assinada. Sem isso, o sistema gravava um eco `owner` paralelo
 *     e a mensagem do atendente ficava duplicada na coluna "Celular".
 *   - mídia → mídia (mesmo type): confia em type+janela 60s (URLs da CDN
 *     diferem da uazapi, sem como comparar — risco baixo).
 */
async function tryClaimRecentOutbound(input: {
  leadId: string;
  externalId: string;
  body: string | null;
  type: NonNullable<InsertMessageInput['type']>;
}): Promise<Message | null> {
  const cutoff = new Date(Date.now() - 60_000);

  // Busca candidatos recentes desse lead (outbound, sem external_id, sender
  // human/ai). NÃO restringe por `type` na query — o match cross-type
  // (text → mídia com caption) precisa enxergar todos os types em janela.
  // Match efetivo é feito no `find()` abaixo.
  const candidates = await db
    .select({
      message: messages,
      senderRole: users.role,
    })
    .from(messages)
    .leftJoin(users, eq(messages.sentById, users.id))
    .where(
      and(
        eq(messages.leadId, input.leadId),
        eq(messages.direction, 'outbound'),
        isNull(messages.externalId),
        gt(messages.createdAt, cutoff),
        inArray(messages.sender, ['human', 'ai']),
      )
    );

  const matchRow = candidates.find(({ message: c, senderRole }) => {
    const isMediaCandidate = c.type === 'image' || c.type === 'video' || c.type === 'document';

    // Caso 1: input mídia, candidate da mesma mídia → confia em type+janela.
    if (input.type !== 'text' && c.type === input.type) {
      return true;
    }

    // Casos 2 e 3 exigem comparar body do input.
    if (!input.body) return false;
    // Assinatura atual (só o nome — cargo foi removido em 09/06). Para reconciliar
    // ecos antigos que foram enviados com prefixo de cargo, mantemos os matchers
    // legacy abaixo. Após ~30 dias de janela (cutoff é curto, ~minutos), podem
    // ser removidos.
    const signedCaption = c.mediaCaption && c.senderName
      ? `*${c.senderName}*\n\n${c.mediaCaption}`
      : null;
    const signedBody = c.body && c.senderName
      ? `*${c.senderName}*\n\n${c.body}`
      : null;
    const legacySignedCaption = c.mediaCaption && c.senderName
      ? `*${rolePrefix(senderRole as UserRole | null)} ${c.senderName}*\n\n${c.mediaCaption}`
      : null;
    const legacySignedBody = c.body && c.senderName
      ? `*${rolePrefix(senderRole as UserRole | null)} ${c.senderName}*\n\n${c.body}`
      : null;

    // Caso 2: input text, candidate text → exato ou assinado (novo ou legacy).
    if (input.type === 'text' && c.type === 'text') {
      if (c.body === input.body) return true;
      if (signedBody === input.body) return true;
      if (legacySignedBody === input.body) return true;
      return false;
    }

    // Caso 3: input text, candidate mídia com caption → uazapi entregou o eco
    // como texto separado. Match contra mediaCaption (cru, assinado novo ou legacy).
    if (input.type === 'text' && isMediaCandidate) {
      if (c.mediaCaption === input.body) return true;
      if (signedCaption === input.body) return true;
      if (legacySignedCaption === input.body) return true;
      return false;
    }

    return false;
  });
  const match = matchRow?.message;

  if (!match) return null;

  try {
    await setExternalId(match.id, input.externalId);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, messageId: match.id, externalId: input.externalId },
      '[messages] claim falhou — provavelmente outra race; deixa fluir'
    );
    return null;
  }

  return getMessageById(match.id);
}

/**
 * Marca mensagem como enviada após envio bem-sucedido pelo adapter.
 * Atualiza externalId (uazapi message_id) e status='sent'.
 *
 * IMPORTANTE: follow-up automático (`metadata.source === 'followup'`) NÃO
 * atualiza `lastOutboundAt`. Senão o card vai marcar "Respondido" só porque
 * a IA mandou um lembrete — mas o cliente nunca foi efetivamente respondido
 * a algo que ele perguntou. `lastOutboundAt` reflete RESPOSTA real (humano
 * ou IA reagindo a inbound dele), não tentativa de reengajamento.
 */
export async function markSent(messageId: string, externalId?: string | null): Promise<void> {
  if (externalId) await setExternalId(messageId, externalId);
  await updateMessageStatus(messageId, 'sent', { externalId });
  const msg = await getMessageById(messageId);
  if (msg) {
    const source = (msg.metadata as { source?: string } | null | undefined)?.source;
    const isFollowup = source === 'followup';
    if (!isFollowup) {
      await bumpActivity(msg.leadId, 'outbound', new Date());
    }
    emitToEmpresa(CRM_ROOM, 'message:statusChanged', {
      messageId,
      status: 'sent',
      externalId,
    });
  }
}

export async function markFailed(messageId: string, reason: string): Promise<void> {
  await updateMessageStatus(messageId, 'failed', { failedReason: reason });
  emitToEmpresa(CRM_ROOM, 'message:statusChanged', {
    messageId,
    status: 'failed',
    reason,
  });
  logger.warn({ messageId, reason }, '[messages] envio falhou');
}

export async function updateExternalStatus(externalId: string, status: MessageStatus): Promise<void> {
  const msg = await findMessageByExternalId(externalId);
  if (!msg) {
    logger.debug({ externalId, status }, '[messages] status update ignorado (mensagem desconhecida)');
    return;
  }
  await updateMessageStatus(msg.id, status);
  emitToEmpresa(CRM_ROOM, 'message:statusChanged', { messageId: msg.id, status });
}

export { setEmbedding };
export { updateInboundMessageBody } from './mutations';

/**
 * Toggle is_starred (favorito) de uma mensagem. DB only — não toca uazapi.
 */
export async function toggleStar(messageId: string): Promise<Message> {
  const msg = await getMessageById(messageId);
  if (!msg) throw new Error('Mensagem não encontrada');
  await db.update(messages).set({ isStarred: !msg.isStarred }).where(eq(messages.id, messageId));
  const updated = await getMessageById(messageId);
  if (!updated) throw new Error('Mensagem sumiu após update');
  emitToEmpresa(CRM_ROOM, 'message:updated', { message: updated });
  return updated;
}

/**
 * Apaga mensagem do CRM. Se for outbound com external_id, tenta apagar
 * também no WhatsApp via uazapi (best-effort — não falha se uazapi rejeitar).
 *
 * Mensagens inbound só somem do CRM (não temos como "desreceber" no WhatsApp).
 */
export async function deleteMessageFromCRM(messageId: string): Promise<void> {
  const msg = await getMessageById(messageId);
  if (!msg) throw new Error('Mensagem não encontrada');

  if (msg.externalId && msg.direction === 'outbound') {
    try {
      const adapter = await getAdapterForLead(msg.leadId);
      await adapter.deleteMessage(msg.externalId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, messageId, externalId: msg.externalId },
        '[messages] uazapi delete falhou (best-effort)'
      );
    }
  }

  await db.delete(messages).where(eq(messages.id, messageId));
  // A mensagem já não existe para o socket descobrir o lead — vai no payload.
  emitToEmpresa(CRM_ROOM, 'message:deleted', { messageId, leadId: msg.leadId });
}

/**
 * Edita o texto de uma mensagem outbound. Atualiza tanto no WhatsApp (via
 * uazapi) quanto no DB. Só funciona pra mensagens type='text' com
 * external_id setado.
 */
export async function editMessageBody(messageId: string, newBody: string): Promise<Message> {
  const msg = await getMessageById(messageId);
  if (!msg) throw new Error('Mensagem não encontrada');
  if (msg.direction !== 'outbound') throw new Error('Só dá pra editar mensagens enviadas');
  if (msg.type !== 'text') throw new Error('Só dá pra editar texto');
  if (!msg.externalId) throw new Error('Mensagem sem external_id (não chegou ao WhatsApp ainda)');

  const lead = await leadReads.getById(msg.leadId);
  // Pra WhatsApp lead.phone === externalContactId; pra IG só temos externalContactId.
  const contactId = lead?.phone ?? lead?.externalContactId;
  if (!contactId) throw new Error('Lead sem identificador externo');

  const adapter = await getAdapterForLead(msg.leadId);
  await adapter.editMessage(msg.externalId, contactId, newBody);

  await db.update(messages).set({ body: newBody }).where(eq(messages.id, messageId));
  const updated = await getMessageById(messageId);
  if (!updated) throw new Error('Mensagem sumiu após update');
  emitToEmpresa(CRM_ROOM, 'message:updated', { message: updated });
  return updated;
}
