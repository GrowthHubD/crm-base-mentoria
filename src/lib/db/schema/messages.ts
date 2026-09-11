import { pgTable, text, timestamp, boolean, jsonb, pgEnum, index } from 'drizzle-orm/pg-core';
import { leads } from './leads';
import { users } from './users';

/** Reação emoji a uma mensagem (estilo WhatsApp). */
export interface MessageReaction {
  emoji: string;
  /** Quem reagiu — 'lead' (do outro lado), 'human'/'ai'/'owner' (do nosso lado). */
  sender: 'lead' | 'human' | 'ai' | 'owner';
  /** Nome opcional pra exibição (atendente que reagiu). */
  senderName?: string | null;
  /** ID externo do reactor (jid WhatsApp) — útil em grupos, opcional em 1-1. */
  externalSenderId?: string | null;
  /** ISO timestamp da reação. */
  timestamp: string;
}

export const messageDirectionEnum = pgEnum('message_direction', ['inbound', 'outbound']);
export const messageTypeEnum = pgEnum('message_type', [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'button_reply',
  'list_reply',
  'system',
]);
export const messageSenderEnum = pgEnum('message_sender', ['lead', 'human', 'ai', 'owner']);
export const messageStatusEnum = pgEnum('message_status', [
  'pending', // ainda não enviada (BullMQ na fila)
  'sent', // enviada via API
  'delivered', // confirmação de entrega WA
  'read', // lida pelo destinatário (✓✓ azul)
  'failed', // erro permanente
]);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    // ID externo do canal (uazapi message.id) — idempotência do webhook
    externalId: text('external_id').unique(),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    direction: messageDirectionEnum('direction').notNull(),
    type: messageTypeEnum('type').notNull().default('text'),
    sender: messageSenderEnum('sender').notNull(),
    // Para mensagens de humano (atendente)
    sentById: text('sent_by_id').references(() => users.id),

    // ── Conteúdo ─────────────────────────────────────────────
    body: text('body'),
    mediaUrl: text('media_url'),
    mediaCaption: text('media_caption'),
    mimeType: text('mime_type'),
    fileName: text('file_name'),

    // ── Quote (responder a mensagem específica) ──────────────
    quotedMessageId: text('quoted_message_id'),
    quotedContent: text('quoted_content'),

    // ── Sender name (útil em grupos WhatsApp) ────────────────
    senderName: text('sender_name'),

    // ── Status ───────────────────────────────────────────────
    status: messageStatusEnum('status').notNull().default('sent'),
    // Mantemos delivered/read como flags rápidas pra queries simples
    delivered: boolean('delivered').notNull().default(false),
    read: boolean('read').notNull().default(false),
    failedReason: text('failed_reason'),

    // ── User actions ─────────────────────────────────────────
    isStarred: boolean('is_starred').notNull().default(false),

    // ── Reactions (emoji) ────────────────────────────────────
    // Lista de reactions na msg. Cada entry: { emoji, sender, senderName,
    // externalSenderId?, timestamp }. WhatsApp suporta 1 reação por sender —
    // ao reagir novamente, sobrescrevemos a reação antiga do mesmo sender.
    reactions: jsonb('reactions').$type<MessageReaction[]>(),

    // ── Embedding pra RAG (OpenAI text-embedding-3-small, 1536 dims por padrão) ──
    // Armazenado como jsonb até pgvector estar ativo; migrar depois
    embedding: jsonb('embedding').$type<number[]>(),

    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    timestamp: timestamp('timestamp').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_messages_lead_id').on(table.leadId),
    index('idx_messages_timestamp').on(table.timestamp),
    index('idx_messages_status').on(table.status),
    // Composto, e é ele que sustenta as duas varreduras mais quentes do
    // produto: o `DISTINCT ON (lead_id) ORDER BY lead_id, timestamp DESC` do
    // kanban e a paginação do chat ("as N mais recentes deste lead").
    //
    // Os dois índices simples acima NÃO servem: com `idx_messages_lead_id` o
    // Postgres acha as linhas do lead mas precisa ordená-las em memória para
    // achar a mais recente, e é justamente esse sort, repetido por lead e por
    // polling, que satura o compute pequeno do Supabase.
    index('idx_messages_lead_id_timestamp').on(table.leadId, table.timestamp.desc()),
  ]
);
