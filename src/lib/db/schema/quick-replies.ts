/**
 * Textos rápidos (slash commands) cadastrados pelo admin. Atendente digita "/"
 * no chat e escolhe um atalho — o `body` é inserido no campo.
 *
 * Unique em (shortcut) pra evitar dois atalhos com o mesmo gatilho.
 */
import { pgTable, text, timestamp, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';

export const quickReplies = pgTable(
  'quick_replies',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    /** Atalho digitado após "/" (case-insensitive). Sem espaços, max 40 chars. */
    shortcut: text('shortcut').notNull(),
    /** Texto inserido no campo de mensagem. Conta como a 1ª variação. */
    body: text('body').notNull(),
    /**
     * Variações alternativas do mesmo texto (anti-ban). Ao usar o atalho, o
     * sistema escolhe aleatoriamente entre `body` e estas — assim a mesma
     * saudação não sai byte-a-byte idêntica pra dezenas de contatos novos,
     * que é o que dispara o anti-spam do WhatsApp. Null/[] = só usa `body`.
     */
    variations: jsonb('variations').$type<string[]>(),
    /** Rótulo opcional pra UI (se vazio, mostra o atalho). */
    label: text('label'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('idx_quick_replies_shortcut').on(table.shortcut)]
);

export type QuickReplyRow = typeof quickReplies.$inferSelect;
