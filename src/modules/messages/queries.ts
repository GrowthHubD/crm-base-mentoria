/**
 * Queries (read-only) do módulo messages.
 */
import { db } from '@/lib/db/client';
import { messages } from '@/lib/db/schema/messages';
import { users } from '@/lib/db/schema/users';
import { eq, and, asc, desc, lt, gt, ne, inArray, getTableColumns } from 'drizzle-orm';
import type { Message, MessageDirection, MessageType, MessageSender, MessageStatus, MessageReaction } from './types';
import type { UserRole } from '@/lib/auth-helpers';

type MessageRow = typeof messages.$inferSelect;
type MessageListRow = Omit<MessageRow, 'embedding'>;

// O embedding pode ter 1.536 números e nunca é exibido no histórico. Excluí-lo
// na projeção SQL evita que o Postgres, o Worker e o navegador transportem e
// desserializem esse JSON em cada poll do chat.
const { embedding: embeddingColumn, ...messageListColumns } = getTableColumns(messages);
void embeddingColumn;

function rowToMessage(
  row: MessageRow | MessageListRow,
  senderRole?: UserRole | null
): Message {
  return {
    id: row.id,
    externalId: row.externalId,
    leadId: row.leadId,
    direction: row.direction as MessageDirection,
    type: row.type as MessageType,
    sender: row.sender as MessageSender,
    sentById: row.sentById,
    body: row.body,
    mediaUrl: row.mediaUrl,
    mediaCaption: row.mediaCaption,
    mimeType: row.mimeType,
    fileName: row.fileName,
    quotedMessageId: row.quotedMessageId,
    quotedContent: row.quotedContent,
    senderName: row.senderName,
    senderRole: senderRole ?? null,
    status: row.status as MessageStatus,
    delivered: row.delivered,
    read: row.read,
    failedReason: row.failedReason,
    isStarred: row.isStarred,
    reactions: (row.reactions ?? null) as MessageReaction[] | null,
    ...('embedding' in row ? { embedding: row.embedding ?? null } : {}),
    metadata: row.metadata ?? null,
    timestamp: row.timestamp,
    createdAt: row.createdAt,
  };
}

/**
 * Resolve o role atual do user (via sentById). É um JOIN simples — sentById é
 * indexado por FK. Quando role muda, mensagens passadas refletem o novo cargo:
 * comportamento desejado (Carlos atendente vira gerente → mensagens antigas
 * passam a aparecer como "Gerente Carlos").
 */
export async function getMessageById(id: string): Promise<Message | null> {
  const [row] = await db
    .select({
      message: messages,
      senderRole: users.role,
    })
    .from(messages)
    .leftJoin(users, eq(messages.sentById, users.id))
    .where(eq(messages.id, id))
    .limit(1);
  return row ? rowToMessage(row.message, row.senderRole as UserRole | null) : null;
}

/**
 * Lookup por externalId (idempotência do webhook). Retorna null se não existe.
 */
export async function findMessageByExternalId(externalId: string): Promise<Message | null> {
  const [row] = await db
    .select({
      message: messages,
      senderRole: users.role,
    })
    .from(messages)
    .leftJoin(users, eq(messages.sentById, users.id))
    .where(eq(messages.externalId, externalId))
    .limit(1);
  return row ? rowToMessage(row.message, row.senderRole as UserRole | null) : null;
}

/**
 * Lista mensagens de um lead em ordem cronológica. Default 50 mais recentes.
 */
export async function listMessagesByLead(
  leadId: string,
  opts: { limit?: number; before?: Date; order?: 'asc' | 'desc' } = {}
): Promise<Message[]> {
  const conditions = [eq(messages.leadId, leadId)];
  if (opts.before) conditions.push(lt(messages.timestamp, opts.before));

  const rows = await db
    .select({
      message: messageListColumns,
      senderRole: users.role,
    })
    .from(messages)
    .leftJoin(users, eq(messages.sentById, users.id))
    .where(and(...conditions))
    .orderBy(opts.order === 'asc' ? asc(messages.timestamp) : desc(messages.timestamp))
    .limit(opts.limit ?? 50);

  return rows.map((r) => rowToMessage(r.message, r.senderRole as UserRole | null));
}

/**
 * Histórico recente em ordem cronológica ASC (oldest → newest), pronto pra
 * usar como contexto do AI agent.
 */
export async function getConversationHistory(leadId: string, limit = 20): Promise<Message[]> {
  // Pega N mais recentes, depois inverte
  const recent = await listMessagesByLead(leadId, { limit, order: 'desc' });
  return recent.slice().reverse();
}

/**
 * Conta quantos outbounds (sender 'ai' ou 'human' — exclui 'owner' que é eco
 * do celular do dono) saíram pro lead DESDE o último inbound dele.
 *
 * Se nunca houve inbound, conta TODOS os outbounds desde o início. Isso é
 * intencional: lead que nunca respondeu uma única vez é candidato a circuit
 * breaker (provavelmente bloqueou, trocou número, shadow-ban etc).
 *
 * Usado pelo scheduler antes de disparar follow-up: se contagem >= N, cancela.
 * Evita insistir em conversa morta — caso clássico do shadow-ban Cozumel
 * (06/2026) onde a IA seguia "respondendo" mas WhatsApp dropava tudo.
 */
export async function countOutboundsSinceLastInbound(leadId: string): Promise<number> {
  const [lastInbound] = await db
    .select({ ts: messages.timestamp })
    .from(messages)
    .where(and(eq(messages.leadId, leadId), eq(messages.direction, 'inbound')))
    .orderBy(desc(messages.timestamp))
    .limit(1);

  const conditions = [
    eq(messages.leadId, leadId),
    eq(messages.direction, 'outbound'),
    inArray(messages.sender, ['ai', 'human']),
  ];
  if (lastInbound?.ts) {
    conditions.push(gt(messages.timestamp, lastInbound.ts));
  }

  const rows = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(...conditions));

  return rows.length;
}

/**
 * Outbound anterior à mensagem `currentMessageId` no mesmo lead. Considera só
 * `sender` em ('human','ai','owner') — ignora eco do dono pra fins de
 * comparação se desejado pelo caller. Usado pelo worker outbound pra decidir
 * se assina (`*Atendente Nome*\n\n...`):
 *   - Se a anterior tinha mesmo sender+senderName → não assina (sequência
 *     consecutiva do mesmo ator).
 *   - Se ausente ou diferente → assina (1ª mensagem ou troca de ator).
 *
 * Ordena por timestamp desc e usa `currentMessageId` pra excluir a própria
 * (evita pegar a si mesmo quando a outbound já foi inserida).
 */
export async function getPreviousOutboundForSignature(
  leadId: string,
  currentMessageId: string
): Promise<{ sender: MessageSender; senderName: string | null } | null> {
  const [row] = await db
    .select({
      sender: messages.sender,
      senderName: messages.senderName,
    })
    .from(messages)
    .where(
      and(
        eq(messages.leadId, leadId),
        eq(messages.direction, 'outbound'),
        inArray(messages.sender, ['human', 'ai', 'owner']),
        ne(messages.id, currentMessageId),
      )
    )
    .orderBy(desc(messages.timestamp), desc(messages.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    sender: row.sender as MessageSender,
    senderName: row.senderName,
  };
}
