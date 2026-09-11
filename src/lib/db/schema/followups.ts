import { pgTable, text, timestamp, jsonb, pgEnum, integer } from 'drizzle-orm/pg-core';
import { leads } from './leads';

export const followupStatusEnum = pgEnum('followup_status', [
  'pending',
  'sent',
  'cancelled',
  'responded',
]);

// Follow-ups automáticos configurados por regra de pipeline
export const followups = pgTable('followups', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  leadId: text('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'cascade' }),
  status: followupStatusEnum('status').notNull().default('pending'),
  // Número do follow-up na sequência (1, 2, 3...)
  sequence: integer('sequence').notNull().default(1),
  body: text('body').notNull(),
  scheduledAt: timestamp('scheduled_at').notNull(),
  sentAt: timestamp('sent_at'),
  bullJobId: text('bull_job_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
