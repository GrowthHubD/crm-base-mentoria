import { pgTable, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { connections } from './connections';

// Metadados específicos de instâncias uazapi
export const whatsappInstances = pgTable('whatsapp_instances', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  connectionId: text('connection_id')
    .notNull()
    .unique()
    .references(() => connections.id, { onDelete: 'cascade' }),
  // Instance ID da uazapi
  instanceId: text('instance_id').notNull().unique(),
  // Número conectado
  phone: text('phone'),
  // Nome do perfil WhatsApp
  profileName: text('profile_name'),
  // QR code base64 (temporário durante conexão)
  qrCode: text('qr_code'),
  qrExpiresAt: timestamp('qr_expires_at'),
  // Webhook URL configurada nesta instância
  webhookUrl: text('webhook_url'),
  // Estatísticas
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  lastSeenAt: timestamp('last_seen_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
