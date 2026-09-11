import { pgTable, text, timestamp, pgEnum } from 'drizzle-orm/pg-core';
import { leads } from './leads';
import { users } from './users';

export const attendanceActionEnum = pgEnum('attendance_action', [
  'assigned',
  'unassigned',
  'status_changed',
  'ai_enabled',
  'ai_disabled',
  'converted',
  'lost',
  'note_added',
]);

// Log de todas as ações no pipeline (auditoria)
export const attendanceLog = pgTable('attendance_log', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  leadId: text('lead_id')
    .notNull()
    .references(() => leads.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id),
  action: attendanceActionEnum('action').notNull(),
  fromValue: text('from_value'),
  toValue: text('to_value'),
  note: text('note'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
