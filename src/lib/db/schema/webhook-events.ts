/**
 * Eventos crus de webhook, gravados ANTES de qualquer processamento.
 *
 * Existe por causa de uma assimetria da WhatsApp Cloud API: ela é
 * webhook-only e **nunca retransmite depois que respondemos 200**. Se o
 * processamento falhar após a resposta — banco fora, erro de parse, isolate
 * derrubado — a mensagem do cliente deixa de existir para nós, e a Meta
 * considera entregue. Na uazapi dava pra reconsultar o histórico da
 * instância; aqui não há a quem pedir de novo.
 *
 * Então o request path faz o mínimo: grava o payload cru, responde 200, e o
 * processamento acontece depois a partir desta linha. Se falhar, a linha
 * continua `pending` e o `/api/cron/tick` retenta.
 *
 * `eventKey` é UNIQUE e carrega o id da mensagem/status do provedor: entrega
 * duplicada da Meta (que acontece) vira no-op no INSERT, sem precisar de
 * transação nem lock.
 */
import { pgTable, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core';

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    /** Provedor de origem: 'cloud-api' | 'uazapi'. Texto, não enum: um
     *  provedor novo não deve exigir migration só pra ser registrado. */
    provider: text('provider').notNull(),
    /** Connection a que o evento pertence. Sem FK: o evento precisa sobreviver
     *  à remoção da connection pra não sumir do diagnóstico. */
    connectionIdText: text('connection_id_text'),
    /** Chave de deduplicação — `<provider>:<tipo>:<id do provedor>`. */
    eventKey: text('event_key').notNull().unique(),
    /** Payload cru, exatamente como chegou. É o que permite reprocessar. */
    payload: jsonb('payload').notNull(),
    /** pending → processando na próxima varredura · done → concluído ·
     *  failed → estourou o teto de tentativas, exige olho humano. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    receivedAt: timestamp('received_at').notNull().defaultNow(),
    processedAt: timestamp('processed_at'),
  },
  (t) => [
    // O sweeper busca por (status, receivedAt) a cada minuto.
    index('idx_webhook_events_status').on(t.status, t.receivedAt),
  ]
);
