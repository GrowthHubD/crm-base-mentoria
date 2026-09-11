import { pgTable, text, timestamp, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { units } from './units';
import { users } from './users';

export const connectionTypeEnum = pgEnum('connection_type', ['whatsapp']);
export const connectionStatusEnum = pgEnum('connection_status', [
  'pending',
  'qr_pending',
  'connected',
  'disconnected',
  'error',
]);

// Canais conectados (instâncias WhatsApp uazapi).
export const connections = pgTable('connections', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** Filial dona deste número de WhatsApp. NULO = atende o cliente inteiro.
   *  É por aqui que a mensagem que chega sabe de qual unidade é: o inbound
   *  resolve a connection e herda a unidade dela. */
  unitId: text('unit_id').references(() => units.id),
  /**
   * PESSOA dona deste número — quem conectou o QR code.
   *
   * Eixo diferente de `unitId`: unidade é "qual filial", dono é "qual pessoa".
   * Um time de prospecção tem um número por BDR, e o que cada um conversa não
   * é assunto dos outros. É daqui que sai a visibilidade — o lead que entra
   * por esta conexão nasce pertencendo a este usuário.
   *
   * NULO = número da casa, que só o admin enxerga. O default fechado é
   * deliberado: uma conexão criada por um caminho que esqueceu de marcar o
   * dono não pode virar, por omissão, conexão que o time inteiro vê.
   */
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'set null' }),
  type: connectionTypeEnum('type').notNull(),
  status: connectionStatusEnum('status').notNull().default('pending'),
  // WhatsApp: instance_id uazapi | Instagram: page_id
  externalId: text('external_id').notNull().unique(),
  displayName: text('display_name'),
  phoneNumber: text('phone_number'),
  // Token criptografado (encrypt/decrypt de src/lib/encryption.ts)
  accessTokenEncrypted: text('access_token_encrypted'),
  // Quando o token expira (Instagram User Token = 60d). NULL pra WhatsApp
  // (uazapi não expira o token de instância). Cron de refresh consulta isso
  // diariamente e renova quando faltar ≤7d.
  tokenExpiresAt: timestamp('token_expires_at'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});
