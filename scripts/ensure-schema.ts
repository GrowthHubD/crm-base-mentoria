/**
 * Cria o schema desta instalação, se ainda não existir.
 *
 * Roda ANTES das migrations quando um cliente novo entra. O `db:migrate` já
 * escreve no schema certo (ver drizzle.config.ts), mas não cria o schema —
 * e a migration falha com "schema does not exist" se ninguém criou antes.
 *
 * Uso:
 *   DB_SCHEMA=cliente_acme npm run db:schema
 *
 * Só executa CREATE SCHEMA IF NOT EXISTS. Nunca apaga nada.
 */
import 'dotenv/config';
import postgres from 'postgres';

const SCHEMA = process.env.DB_SCHEMA?.trim() || 'public';

async function main() {
  if (SCHEMA === 'public') {
    console.log('DB_SCHEMA=public — nada a criar (é o schema padrão do Postgres).');
    process.exit(0);
  }

  // Nome de schema não é parametrizável em DDL, então validamos à mão em vez
  // de interpolar o que vier. Só letras, números e underscore.
  if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
    console.error(`DB_SCHEMA inválido: "${SCHEMA}". Use letras minúsculas, números e _.`);
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não configurada.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, ssl: 'require' });
  try {
    const [existing] = await sql`
      select schema_name from information_schema.schemata where schema_name = ${SCHEMA}
    `;
    if (existing) {
      console.log(`Schema "${SCHEMA}" já existe — nada a fazer.`);
    } else {
      await sql.unsafe(`create schema "${SCHEMA}"`);
      console.log(`Schema "${SCHEMA}" criado.`);
    }
    console.log('\nPróximo passo: npm run db:migrate (vai escrever dentro dele).');
  } finally {
    await sql.end();
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
