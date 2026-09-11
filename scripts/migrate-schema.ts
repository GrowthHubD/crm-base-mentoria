/**
 * Aplica as migrations dentro de UM schema.
 *
 * Por que não usamos `drizzle-kit migrate` aqui: ele guarda o que já rodou em
 * UMA tabela global (`drizzle.__drizzle_migrations`) e decide por ela. Com
 * vários clientes no mesmo Postgres isso falha em silêncio — as migrations
 * já constavam aplicadas pelo primeiro cliente, então o segundo recebia
 * "migrations applied successfully" e ZERO tabelas criadas. Configurar
 * `migrations.schema` move onde ele ESCREVE, mas não onde ele LÊ.
 *
 * Este script faz o simples e determinístico: lê o journal, executa cada
 * arquivo .sql com o `search_path` do schema alvo, e registra o que aplicou
 * numa tabela DENTRO daquele schema. Cada cliente tem seu próprio histórico.
 *
 * Uso:
 *   DB_SCHEMA=cliente_acme npx tsx scripts/migrate-schema.ts
 *
 * Idempotente: rodar de novo não repete o que já passou.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';

const SCHEMA = process.env.DB_SCHEMA?.trim() || 'public';
const DIR = join(process.cwd(), 'drizzle');

interface JournalEntry { idx: number; tag: string }

function loadJournal(): JournalEntry[] {
  const raw = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: JournalEntry[];
  };
  return [...raw.entries].sort((a, b) => a.idx - b.idx);
}

async function main() {
  if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) {
    console.error(`DB_SCHEMA inválido: "${SCHEMA}"`);
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não configurada.');
    process.exit(1);
  }

  const sql = postgres(url, { max: 1, ssl: 'require' });
  console.log(`Aplicando migrations no schema "${SCHEMA}"\n`);

  try {
    await sql.unsafe(`create schema if not exists "${SCHEMA}"`);
    await sql.unsafe(`
      create table if not exists "${SCHEMA}"."__migrations_applied" (
        tag text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const applied = new Set(
      (await sql.unsafe(`select tag from "${SCHEMA}"."__migrations_applied"`)).map(
        (r: Record<string, unknown>) => r.tag as string
      )
    );

    let ran = 0;
    for (const entry of loadJournal()) {
      if (applied.has(entry.tag)) {
        console.log(`  = ${entry.tag} (já aplicada)`);
        continue;
      }

      let file = readFileSync(join(DIR, `${entry.tag}.sql`), 'utf8');

      // O drizzle-kit CRAVA o schema no SQL gerado: `CREATE TYPE
      // "public"."user_role"`, `CREATE TABLE "public"."leads"` — 32 ocorrências
      // só no primeiro arquivo. Com isso, rodar a migration em outro schema
      // criaria tudo em `public` de novo (e falha com "already exists"), por
      // mais que o search_path aponte pro schema do cliente.
      //
      // Reescrevemos o prefixo. É seguro porque todo `"public".` nesses
      // arquivos é objeto NOSSO — os tipos e tabelas que o próprio drizzle
      // acabou de declarar. Extensões do Postgres não aparecem aqui.
      if (SCHEMA !== 'public') {
        file = file.replaceAll('"public".', `"${SCHEMA}".`);
      }
      // O drizzle separa comandos com este marcador — rodar o arquivo inteiro
      // de uma vez falha em statements que não podem ir no mesmo lote.
      const statements = file
        .split('--> statement-breakpoint')
        .map(s => s.trim())
        .filter(Boolean);

      // Transação por arquivo: uma migration entra inteira ou não entra.
      await sql.begin(async tx => {
        await tx.unsafe(`set local search_path to "${SCHEMA}", public`);
        for (const statement of statements) {
          await tx.unsafe(statement);
        }
        await tx.unsafe(
          `insert into "${SCHEMA}"."__migrations_applied" (tag) values ('${entry.tag}')`
        );
      });

      console.log(`  ✓ ${entry.tag} (${statements.length} comandos)`);
      ran++;
    }

    const [{ n }] = (await sql.unsafe(
      `select count(*)::int as n from information_schema.tables
       where table_schema = '${SCHEMA}' and table_type = 'BASE TABLE'`
    )) as unknown as [{ n: number }];

    console.log(`\n${ran} migration(s) aplicada(s). Schema tem ${n} tabelas.`);
  } finally {
    await sql.end();
  }
  process.exit(0);
}

main().catch(err => {
  console.error('\nFalhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
