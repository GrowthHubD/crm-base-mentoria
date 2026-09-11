import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  pgEnum,
  index,
} from 'drizzle-orm/pg-core';
import { leads } from './leads';

/**
 * Engine de automações — dispara mensagens em sequência baseadas em triggers
 * (primeira mensagem do lead, lead inativo, mudança de stage, etc).
 *
 * Adaptado do padrão usado em `crm_parceria_lagos`.
 */

// ── Tipos de gatilho ──────────────────────────────────────────
export const automationTriggerEnum = pgEnum('automation_trigger', [
  'first_message', // disparado na primeira mensagem do lead
  'lead_inactive', // disparado quando lead não responde por X tempo
  'stage_enter', // disparado quando lead entra numa stage específica
  'tag_added', // disparado quando uma tag é adicionada
  'manual', // dispara apenas via chamada explícita
]);

// ── Tipos de step ─────────────────────────────────────────────
export const automationStepTypeEnum = pgEnum('automation_step_type', [
  'send_text', // envia mensagem de texto
  'send_media', // envia imagem/vídeo/áudio/documento
  'wait', // espera X minutos antes do próximo step
  'set_status', // muda status do lead
  'add_tag', // adiciona tag ao lead
  'notify_human', // notifica atendentes (sino)
]);

// ── Status de log ─────────────────────────────────────────────
export const automationLogStatusEnum = pgEnum('automation_log_status', [
  'pending', // agendado
  'running', // executando
  'completed', // executado com sucesso
  'failed', // erro
  'skipped', // condição não atendida (ex: lead já respondeu)
  'cancelled', // cancelado manualmente
]);

// ============================================================
// AUTOMATION — definição de um fluxo
// ============================================================
export const automations = pgTable(
  'automations',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text('name').notNull(),
    description: text('description'),
    trigger: automationTriggerEnum('trigger').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    // Config específica do trigger:
    //   first_message: {}
    //   lead_inactive: { days: 3 }
    //   stage_enter:   { stage: 'priority' }
    //   tag_added:     { tag: 'hot-lead' }
    triggerConfig: jsonb('trigger_config').$type<Record<string, unknown>>(),
    // Filtros opcionais (ex: só leads com tag X, só de canal Y)
    filters: jsonb('filters').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_automations_trigger').on(table.trigger),
    index('idx_automations_enabled').on(table.enabled),
  ]
);

// ============================================================
// AUTOMATION_STEP — passos individuais do fluxo
// ============================================================
export const automationSteps = pgTable(
  'automation_steps',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(), // 1, 2, 3...
    type: automationStepTypeEnum('type').notNull(),
    // Config específica:
    //   send_text:    { body: 'Olá {{name}}', delay_minutes: 5 }
    //   send_media:   { url: '...', mediaType: 'image', caption: '...', delay_minutes: 0 }
    //   wait:         { minutes: 60 }
    //   set_status:   { status: 'attending' }
    //   add_tag:      { tag: 'follow-up-1' }
    //   notify_human: { message: 'Cliente sem resposta há 3 dias' }
    config: jsonb('config').notNull().$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('idx_automation_steps_automation_id').on(table.automationId)]
);

// ============================================================
// AUTOMATION_LOG — execução de cada step (idempotência + auditoria)
// ============================================================
export const automationLogs = pgTable(
  'automation_logs',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    stepId: text('step_id').references(() => automationSteps.id, { onDelete: 'set null' }),
    leadId: text('lead_id')
      .notNull()
      .references(() => leads.id, { onDelete: 'cascade' }),
    status: automationLogStatusEnum('status').notNull().default('pending'),
    // Quando deve executar (BullMQ delayed job aponta pra esse timestamp)
    scheduledAt: timestamp('scheduled_at').notNull(),
    executedAt: timestamp('executed_at'),
    // ID do job no BullMQ (pra cancelar)
    bullJobId: text('bull_job_id'),
    // Erro / contexto da execução
    error: text('error'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_automation_logs_lead_id').on(table.leadId),
    index('idx_automation_logs_status').on(table.status),
    index('idx_automation_logs_scheduled_at').on(table.scheduledAt),
  ]
);
