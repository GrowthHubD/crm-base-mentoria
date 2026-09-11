import { pgTable, text, timestamp, jsonb, boolean } from 'drizzle-orm/pg-core';

// Configuração de turnos dos atendentes
export const shiftConfig = pgTable('shift_config', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text('name').notNull(),
  // Horários: { start: "08:00", end: "16:00", days: [1,2,3,4,5] }
  schedule: jsonb('schedule')
    .notNull()
    .$type<{ start: string; end: string; days: number[] }>(),
  // Quando fora do turno, IA assume automaticamente?
  autoAiOutsideShift: boolean('auto_ai_outside_shift').notNull().default(false),
  // Mensagem automática de fora do horário
  outsideShiftMessage: text('outside_shift_message'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
