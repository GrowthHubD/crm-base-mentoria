/**
 * Unidades — as filiais de UM cliente assinante.
 *
 * Não confundir com o isolamento entre clientes. São dois níveis diferentes:
 *
 *   cliente assinante → um Worker e um SCHEMA de Postgres próprios. O
 *     isolamento é físico e garantido pelo banco; não existe código de tenant.
 *   unidade → uma linha desta tabela, DENTRO do schema do cliente. É a filial:
 *     a Acme pode ter Belenzinho e Tatuapé, com leads, números de WhatsApp e
 *     atendentes separados, mas o mesmo login e a mesma assinatura.
 *
 * O `unitId` é NULO em toda parte de propósito, e isso é o que permite ligar o
 * módulo num cliente sem migrar dado nenhum: quem não usa unidades continua com
 * tudo em `null`, e as consultas sem filtro seguem devolvendo tudo. Ligar
 * unidades depois é criar as filiais e ir marcando — nunca um big bang.
 *
 * Em `users`, `unitId` nulo significa "enxerga todas as unidades" (o dono).
 * Preenchido, o atendente vê só a dele — e isso é recorte de VISIBILIDADE
 * aplicado no servidor, não filtro de tela.
 */
import { pgTable, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';

export const units = pgTable(
  'units',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
    /** Nome comercial, como o cliente chama a filial ("Belenzinho"). */
    name: text('name').notNull(),
    /** Identificador curto e estável, para URL e integração. Único. */
    slug: text('slug').notNull().unique(),
    /** Endereço/observação livre — aparece na gestão, não no atendimento. */
    description: text('description'),
    /** Desativar em vez de apagar: os leads e as mensagens da filial fechada
     *  continuam no histórico, e apagar a linha os deixaria órfãos. */
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  t => [index('idx_units_active').on(t.active)]
);

export type Unit = typeof units.$inferSelect;
export type NewUnit = typeof units.$inferInsert;
