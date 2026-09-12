/**
 * Contas de e-mail conectadas — uma por pessoa, não uma por instalação.
 *
 * É a diferença central em relação ao Gmail da preventiva, que guarda UM
 * `GOOGLE_REFRESH_TOKEN` em variável de ambiente e manda tudo por uma conta só.
 * Aqui cada SDR conecta o próprio Google e passa a disparar e receber com o
 * endereço dele — que é o que faz o cliente responder para a pessoa certa, e o
 * que permite tirar o acesso de um vendedor que saiu sem mexer nos outros.
 *
 * Sobre os tokens: o `refresh_token` é permanente e vale tanto quanto a senha
 * da conta — quem o tem lê e envia e-mail como aquela pessoa, indefinidamente.
 * Por isso vai cifrado com a mesma `ENCRYPTION_KEY` dos tokens de WhatsApp, e
 * por isso o `access_token` (que vive 1h) fica em memória, nunca no banco.
 */
import { pgTable, text, timestamp, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';

export const emailAccounts = pgTable(
  'email_accounts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /** Dono da conta. Some junto se o usuário for removido. */
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Provedor. Hoje só `gmail`; a coluna existe para o dia do Outlook. */
    provider: text('provider').notNull().default('gmail'),

    /** O endereço em si — é o que aparece como remetente. */
    email: text('email').notNull(),

    /** Nome de exibição do remetente ("Fulano | Growth Hub"). */
    displayName: text('display_name'),

    /**
     * `refresh_token` cifrado. Nunca sai daqui em claro, e não é devolvido por
     * nenhuma rota — a UI mostra o e-mail e o estado, jamais o token.
     */
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),

    /**
     * Escopos concedidos. Guardados porque o Google pode conceder MENOS do que
     * foi pedido (a pessoa desmarca uma caixa na tela de consentimento), e
     * descobrir isso na hora de enviar produz um erro incompreensível.
     */
    scopes: text('scopes'),

    /**
     * Conta ativa? Vira `false` quando o Google recusa o refresh — senha
     * trocada, acesso revogado, app removido. Fica registrado em vez de a
     * conta sumir, para a tela poder dizer "reconecte" em vez de mostrar
     * nada e deixar a pessoa achando que nunca conectou.
     */
    active: boolean('active').notNull().default(true),

    /** Último erro do provedor, legível — é o que a tela mostra ao pedir reconexão. */
    lastError: text('last_error'),

    /** Última sincronização de entrada, para o polling saber de onde continuar. */
    lastSyncAt: timestamp('last_sync_at'),

    /** Marcador de histórico do Gmail, para buscar só o que chegou depois. */
    lastHistoryId: text('last_history_id'),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    // A mesma pessoa não conecta duas vezes o mesmo endereço — reconectar
    // atualiza o token em vez de criar uma segunda linha, senão o envio
    // passaria a depender de qual das duas o código pegasse primeiro.
    contaUnica: uniqueIndex('email_accounts_user_email_uq').on(t.userId, t.email),
  })
);
