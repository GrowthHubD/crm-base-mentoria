import 'dotenv/config';
import type { Config } from 'drizzle-kit';

/**
 * As migrations precisam cair no MESMO schema que a app lê. Sem isto o
 * drizzle-kit criaria tudo em `public` enquanto a instância do cliente lê do
 * schema dela — e o app subiria reclamando de tabela inexistente.
 *
 * O `options=-c search_path=...` é repassado ao Postgres no handshake; foi
 * verificado que o postgres.js encaminha o parâmetro.
 */
const DB_SCHEMA = process.env.DB_SCHEMA?.trim() || 'public';
const SEARCH_PATH = DB_SCHEMA === 'public' ? 'public' : `${DB_SCHEMA},public`;
const BASE_URL = process.env.DATABASE_URL ?? '';
const URL_WITH_SCHEMA =
  DB_SCHEMA === 'public'
    ? BASE_URL
    : `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SEARCH_PATH}`)}`;

export default {
  schema: './src/lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: URL_WITH_SCHEMA,
  },
  // Só olha o schema desta instalação — senão o diff enxerga as tabelas dos
  // outros clientes no mesmo banco e tenta "corrigir".
  schemaFilter: [DB_SCHEMA],
  /**
   * O CONTROLE de migrations também precisa ser por schema.
   *
   * Por padrão o drizzle-kit registra o que já rodou em
   * `drizzle.__drizzle_migrations` — uma tabela só, global ao banco. Com
   * vários clientes no mesmo Postgres isso quebra em silêncio: as migrations
   * já constavam como aplicadas (do primeiro cliente), então o segundo
   * recebia "migrations applied successfully" e ZERO tabelas criadas. Foi
   * exatamente o que aconteceu ao criar o cliente_acme.
   *
   * Cada schema passa a ter o próprio registro dentro de si. `public` fica
   * apontando pro `drizzle` histórico pra não reprocessar o que já rodou lá.
   */
  migrations: {
    table: '__drizzle_migrations',
    schema: DB_SCHEMA === 'public' ? 'drizzle' : DB_SCHEMA,
  },
  verbose: true,
  strict: true,
} satisfies Config;
