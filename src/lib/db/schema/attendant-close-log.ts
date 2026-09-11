/**
 * Log de fechamento de leads por atendente — fonte de verdade do "tempo médio
 * de atendimento" no ranking. Persiste mesmo se o lead for deletado depois,
 * por isso `lead_id_text` não é FK.
 */
import { pgTable, text, timestamp, bigint } from 'drizzle-orm/pg-core';
import { users } from './users';

export const attendantCloseLog = pgTable('attendant_close_log', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
  leadIdText: text('lead_id_text').notNull(),
  action: text('action').notNull(), // 'converted' | 'deleted'
  durationMs: bigint('duration_ms', { mode: 'number' }).notNull(),
  closedAt: timestamp('closed_at').notNull().defaultNow(),
});

export type AttendantCloseLogRow = typeof attendantCloseLog.$inferSelect;
export type AttendantCloseLogInsert = typeof attendantCloseLog.$inferInsert;
