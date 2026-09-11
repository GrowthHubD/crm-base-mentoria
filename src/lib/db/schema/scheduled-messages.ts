import { pgTable, text, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { leads } from './leads';
import { users } from './users';

export const scheduledMessageStatusEnum = pgEnum('scheduled_message_status', [
  'pending',
  'sent',
  'cancelled',
  'failed',
]);

export const scheduledMessages = pgTable('scheduled_messages', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  leadId: text('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'cascade' }),
  createdById: text('created_by_id').references(() => users.id),
  status: scheduledMessageStatusEnum('status').notNull().default('pending'),
  // Conteúdo da mensagem
  body: text('body').notNull(),
  mediaUrl: text('media_url'),
  // Horário de envio
  scheduledAt: timestamp('scheduled_at').notNull(),
  sentAt: timestamp('sent_at'),
  // ID do job BullMQ (para cancelamento)
  bullJobId: text('bull_job_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
