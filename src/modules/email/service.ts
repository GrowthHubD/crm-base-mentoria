/**
 * Contas de e-mail: conectar, listar, usar e desconectar.
 *
 * Regra que atravessa o módulo: **o token nunca sai daqui**. As rotas recebem
 * ids e devolvem estado; quem decifra e fala com o Google é este arquivo. É o
 * que impede um `select *` distraído numa rota de vazar refresh_token para a
 * tela.
 */
import { db } from '@/lib/db/client';
import { emailAccounts } from '@/lib/db/schema/email-accounts';
import { users } from '@/lib/db/schema/users';
import { alias } from 'drizzle-orm/pg-core';
import { and, eq, desc } from 'drizzle-orm';
import { encrypt, decrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import {
  exchangeCode,
  getAccessToken,
  getProfileEmail,
  sendEmail as gmailSend,
  listInbox as gmailInbox,
  GmailAuthError,
  type SendInput,
  type InboxMessage,
} from './gmail-client';

/** O que a tela pode ver. Note que não há token nenhum aqui. */
export interface EmailAccountView {
  id: string;
  email: string;
  displayName: string | null;
  provider: string;
  active: boolean;
  lastError: string | null;
  lastSyncAt: Date | null;
  createdAt: Date;
  /** Dono da caixa. Preenchido só na visão de admin (lista de todos). */
  ownerId?: string | null;
  ownerName?: string | null;
}

/**
 * Escopo de quem enxerga as caixas. `veTudo` (admin) lista TODAS, com o dono;
 * caso contrário só as do próprio `userId`. É o mesmo recorte das conexões de
 * WhatsApp: o admin administra tudo, o BDR só o dele.
 */
export interface EscopoContas {
  userId: string;
  veTudo: boolean;
}

export async function listAccounts(escopo: EscopoContas): Promise<EmailAccountView[]> {
  const donos = alias(users, 'donos_email');
  const q = db
    .select({
      id: emailAccounts.id,
      email: emailAccounts.email,
      displayName: emailAccounts.displayName,
      provider: emailAccounts.provider,
      active: emailAccounts.active,
      lastError: emailAccounts.lastError,
      lastSyncAt: emailAccounts.lastSyncAt,
      createdAt: emailAccounts.createdAt,
      ownerId: emailAccounts.userId,
      ownerName: donos.name,
    })
    .from(emailAccounts)
    .leftJoin(donos, eq(donos.id, emailAccounts.userId));
  const rows = escopo.veTudo
    ? await q.orderBy(desc(emailAccounts.createdAt))
    : await q.where(eq(emailAccounts.userId, escopo.userId)).orderBy(desc(emailAccounts.createdAt));
  return rows;
}

/**
 * Finaliza a autorização: troca o code, descobre o endereço e grava.
 *
 * Reconectar o mesmo endereço ATUALIZA a linha em vez de criar outra — e
 * reativa a conta, que é o caminho de volta de quem teve o acesso revogado.
 */
export async function connectGmail(params: {
  userId: string;
  code: string;
  redirectUri: string;
  displayName?: string | null;
}): Promise<EmailAccountView> {
  const { refreshToken, accessToken, scope } = await exchangeCode({
    code: params.code,
    redirectUri: params.redirectUri,
  });

  const email = await getProfileEmail(accessToken);
  if (!email) {
    throw new GmailAuthError('Não consegui ler o endereço da conta autorizada.');
  }

  const [row] = await db
    .insert(emailAccounts)
    .values({
      userId: params.userId,
      provider: 'gmail',
      email,
      displayName: params.displayName ?? null,
      refreshTokenEncrypted: encrypt(refreshToken),
      scopes: scope,
      active: true,
      lastError: null,
    })
    .onConflictDoUpdate({
      target: [emailAccounts.userId, emailAccounts.email],
      set: {
        refreshTokenEncrypted: encrypt(refreshToken),
        scopes: scope,
        active: true,
        lastError: null,
        updatedAt: new Date(),
      },
    })
    .returning({
      id: emailAccounts.id,
      email: emailAccounts.email,
      displayName: emailAccounts.displayName,
      provider: emailAccounts.provider,
      active: emailAccounts.active,
      lastError: emailAccounts.lastError,
      lastSyncAt: emailAccounts.lastSyncAt,
      createdAt: emailAccounts.createdAt,
    });

  logger.info({ userId: params.userId, email }, '[email] conta conectada');
  return row;
}

/**
 * Remove a conta do CRM.
 *
 * NÃO revoga o acesso no Google — quem quiser cortar de vez faz isso em
 * myaccount.google.com/permissions. Revogar aqui derrubaria o acesso de
 * qualquer outro sistema que a pessoa tenha autorizado com o mesmo app.
 */
export async function disconnect(escopo: EscopoContas, accountId: string): Promise<boolean> {
  // Admin desconecta qualquer caixa (administra todas); BDR só a dele — o
  // `and(userId)` é o que impede um BDR de derrubar a caixa de outro pela URL.
  const cond = escopo.veTudo
    ? eq(emailAccounts.id, accountId)
    : and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, escopo.userId));
  const r = await db
    .delete(emailAccounts)
    .where(cond)
    .returning({ id: emailAccounts.id });
  return r.length > 0;
}

/** Carrega a conta com o token decifrado. Interno — nunca exposto por rota. */
async function loadAccount(userId: string, accountId: string) {
  const [row] = await db
    .select()
    .from(emailAccounts)
    .where(and(eq(emailAccounts.id, accountId), eq(emailAccounts.userId, userId)))
    .limit(1);

  if (!row) throw new Error('Conta de e-mail não encontrada');
  return { row, refreshToken: decrypt(row.refreshTokenEncrypted) };
}

/**
 * Marca a conta como precisando de reconexão.
 *
 * Só para falha de AUTORIZAÇÃO. Erro de rede ou instabilidade do Google não
 * deve desativar a conta de ninguém — o SDR abriria a tela no dia seguinte com
 * "reconecte" sem que nada tivesse mudado.
 */
async function marcarInativa(accountId: string, motivo: string) {
  await db
    .update(emailAccounts)
    .set({ active: false, lastError: motivo, updatedAt: new Date() })
    .where(eq(emailAccounts.id, accountId));
}

export async function sendFromAccount(
  userId: string,
  accountId: string,
  input: SendInput
): Promise<{ messageId: string; threadId: string | null }> {
  const { row, refreshToken } = await loadAccount(userId, accountId);

  try {
    const r = await gmailSend(refreshToken, row.email, row.displayName, input);
    if (!row.active) {
      // Funcionou: a conta estava marcada como inativa por um erro que já
      // passou. Reativar aqui evita que a pessoa precise reconectar à toa.
      await db
        .update(emailAccounts)
        .set({ active: true, lastError: null, updatedAt: new Date() })
        .where(eq(emailAccounts.id, accountId));
    }
    return r;
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await marcarInativa(accountId, err.message);
    }
    throw err;
  }
}

export async function inboxFromAccount(
  userId: string,
  accountId: string,
  opts: { max?: number; query?: string } = {}
): Promise<InboxMessage[]> {
  const { row, refreshToken } = await loadAccount(userId, accountId);

  try {
    const msgs = await gmailInbox(refreshToken, opts);
    await db
      .update(emailAccounts)
      .set({ lastSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(emailAccounts.id, row.id));
    return msgs;
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await marcarInativa(accountId, err.message);
    }
    throw err;
  }
}

/** Renova o acesso só para checar se a autorização ainda vale. */
export async function testAccount(userId: string, accountId: string): Promise<boolean> {
  const { refreshToken } = await loadAccount(userId, accountId);
  try {
    await getAccessToken(refreshToken);
    await db
      .update(emailAccounts)
      .set({ active: true, lastError: null, updatedAt: new Date() })
      .where(eq(emailAccounts.id, accountId));
    return true;
  } catch (err) {
    if (err instanceof GmailAuthError) {
      await marcarInativa(accountId, err.message);
    }
    return false;
  }
}
