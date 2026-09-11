import { pgTable, text, integer, timestamp, boolean } from 'drizzle-orm/pg-core';

// Configuração dos timers de escalação automática
export const pipelineConfig = pgTable('pipeline_config', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  // Minutos sem resposta para escalar Novo → Prioridade
  newToPriorityMinutes: integer('new_to_priority_minutes').notNull().default(15),
  // Minutos sem resposta para escalar Prioridade → Urgência
  priorityToUrgencyMinutes: integer('priority_to_urgency_minutes').notNull().default(30),
  // Master switch: liga/desliga escalação automática por tempo
  autoEscalationEnabled: boolean('auto_escalation_enabled').notNull().default(true),
  // Notificar atendente ao escalar
  notifyOnEscalation: boolean('notify_on_escalation').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
