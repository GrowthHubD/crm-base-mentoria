import { pgTable, text, timestamp, boolean, pgEnum } from 'drizzle-orm/pg-core';
import { units } from './units';

/**
 * Roles (single-tenant):
 *  - admin: acesso total (config, canais, IA, usuários).
 *  - attendant: atende leads no CRM, sem acesso às telas de admin.
 */
export const userRoleEnum = pgEnum('user_role', ['admin', 'attendant']);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  /** Unidade do usuário. NULO = enxerga TODAS (o dono, o gerente geral).
   *  Preenchido, o atendente só vê a filial dele — recorte aplicado no
   *  servidor, nunca só na tela. */
  unitId: text('unit_id').references(() => units.id),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: userRoleEnum('role').notNull().default('attendant'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Sessões better-auth
export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  expiresAt: timestamp('expires_at').notNull(),
  token: text('token').notNull().unique(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// OAuth accounts better-auth
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at'),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

// Verificações de email/OTP better-auth
export const verifications = pgTable('verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export type UserRole = (typeof userRoleEnum.enumValues)[number];
