/**
 * Cria o índice composto `messages(lead_id, timestamp DESC)` — sem travar a tabela.
 *
 * É o índice que sustenta as duas varreduras mais quentes do produto:
 *
 *   1. o kanban, que pede a última mensagem de cada lead do board
 *      (`DISTINCT ON (lead_id) ORDER BY lead_id, timestamp DESC`);
 *   2. a paginação do chat, que pede as N mensagens mais recentes de um lead.
 *
 * Os índices simples que já existem não servem: com `idx_messages_lead_id` o
 * Postgres acha as linhas do lead mas ordena em memória para achar a mais
 * recente — e é esse sort, repetido por lead e por polling de 10s, que satura
 * o compute pequeno do Supabase. No Sistema Motel, que tem o mesmo desenho,
 * isso derrubou o CRM: `statement_timeout` até em `count(*)`, e conexão nova
 * passando a falhar.
 *
 * Por que um script e não `db:push`:
 *
 *  - `CREATE INDEX CONCURRENTLY` não roda dentro de transação, e o drizzle-kit
 *    envolve as migrations numa. Sem CONCURRENTLY o índice trava escrita na
 *    tabela — em produção isso é o CRM parado no meio do expediente.
 *  - O índice precisa ser criado por quem é DONO da tabela. O role de cada
 *    cliente (`<schema>_app`) tem SELECT/INSERT/UPDATE, não DDL — de propósito.
 *    Por isso este script usa a `DATABASE_URL` administrativa.
 *
 * Uso:
 *   npm run db:index                    # aplica no DB_SCHEMA do .env
 *   DB_SCHEMA=cliente_acme npm run db:index
 *   npm run db:index -- --todos         # varre todo schema que tenha `messages`
 *
 * Idempotente: `IF NOT EXISTS`, e detecta índice inválido deixado por uma
 * tentativa interrompida (CONCURRENTLY que falha no meio deixa um índice
 * inválido que o Postgres NÃO usa e que `IF NOT EXISTS` considera existente —
 * silenciosamente inútil).
 */
import 'dotenv/config';
import postgres from 'postgres';

const NOME = 'idx_messages_lead_id_timestamp';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL ausente. Este script exige a conexão ADMINISTRATIVA');
    console.error('(dona das tabelas) — o role de cliente não tem permissão de DDL.');
    process.exit(1);
  }

  const todos = process.argv.includes('--todos');
  const sql = postgres(url, {
    max: 1,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : 'require',
  });

  try {
    const schemas: string[] = todos
      ? (
          await sql<{ table_schema: string }[]>`
            select distinct table_schema from information_schema.tables
            where table_name = 'messages'
              and table_schema not in ('information_schema', 'pg_catalog')
            order by table_schema`
        ).map(r => r.table_schema)
      : [process.env.DB_SCHEMA?.trim() || 'public'];

    if (!schemas.length) {
      console.log('Nenhum schema com tabela `messages`.');
      return;
    }

    for (const schema of schemas) {
      const existe = await sql`
        select 1 from information_schema.tables
        where table_schema = ${schema} and table_name = 'messages'`;
      if (!existe.length) {
        console.log(`${schema}: sem tabela \`messages\` — pulando`);
        continue;
      }

      // Um CONCURRENTLY interrompido deixa índice INVÁLIDO. O Postgres não o
      // usa, e o IF NOT EXISTS o considera existente — então some do radar sem
      // nunca ter servido. Derruba antes de recriar.
      const invalido = await sql`
        select 1 from pg_class c
        join pg_index i on i.indexrelid = c.oid
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname = ${NOME} and n.nspname = ${schema} and not i.indisvalid`;
      if (invalido.length) {
        console.log(`${schema}: índice inválido de tentativa anterior — removendo`);
        await sql.unsafe(`drop index concurrently if exists "${schema}"."${NOME}"`);
      }

      const antes = Date.now();
      await sql.unsafe(
        `create index concurrently if not exists "${NOME}"
         on "${schema}".messages (lead_id, "timestamp" desc)`
      );

      const ok = await sql`
        select 1 from pg_class c
        join pg_index i on i.indexrelid = c.oid
        join pg_namespace n on n.oid = c.relnamespace
        where c.relname = ${NOME} and n.nspname = ${schema} and i.indisvalid`;

      console.log(
        ok.length
          ? `${schema}: índice pronto e válido (${Date.now() - antes}ms)`
          : `${schema}: FALHOU — índice ausente ou inválido`
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch(err => {
  console.error('falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
