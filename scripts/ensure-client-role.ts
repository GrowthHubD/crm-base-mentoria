/**
 * Cria o usuário Postgres de um cliente, preso ao schema dele.
 *
 * POR QUE ISSO EXISTE (e não é preciosismo)
 *
 * A tentativa anterior era mandar `search_path` na conexão. Não funciona
 * atrás do Hyperdrive: ele termina a conexão na borda e descarta tanto o
 * parâmetro de handshake quanto o `options=-c search_path=` embutido na
 * string de origem. Ambos foram testados — o Worker pedia `cliente_acme` e o
 * banco respondia `public`. O efeito era pior que um erro: a instância de um
 * cliente lia os dados de OUTRO sem falhar em lugar nenhum.
 *
 * O que sobrevive é o padrão gravado no PRÓPRIO usuário
 * (`ALTER ROLE ... SET search_path`): o Postgres aplica no login, não há o que
 * a borda descartar.
 *
 * E o ganho maior é de segurança. Antes, todas as instâncias usavam o mesmo
 * usuário dono do banco — o `search_path` era conveniência, não fronteira: uma
 * query com nome qualificado (`select * from outro_cliente.leads`) atravessava
 * numa boa. Com um usuário por cliente e GRANT só no schema dele, atravessar
 * passa a ser negado pelo banco.
 *
 * Uso:
 *   DB_SCHEMA=cliente_acme npx tsx scripts/ensure-client-role.ts
 *
 * Escreve a string de conexão em `.credenciais/<PASTA>/<schema>.conn.txt`,
 * onde <PASTA> vem de CLIENT_FOLDER (o nome comercial). Uma pasta por cliente
 * porque cada um acumula meia dúzia de arquivos — conexão, segredos, Meta —
 * e tudo solto na raiz vira garimpo na hora da urgência.
 * (ignorado pelo git) — é ela que vai no `wrangler hyperdrive create`.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import postgres from 'postgres';

const SCHEMA = process.env.DB_SCHEMA?.trim() || '';

async function main() {
  if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA) || SCHEMA === 'public') {
    console.error('Defina DB_SCHEMA com o schema do cliente (não pode ser public).');
    process.exit(1);
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL não configurada.');
    process.exit(1);
  }

  const role = `${SCHEMA}_app`;
  const password = randomBytes(24).toString('base64url');
  const sql = postgres(url, { max: 1, ssl: 'require' });

  try {
    const [existing] = await sql`select 1 from pg_roles where rolname = ${role}`;
    if (existing) {
      // Senha nova a cada execução: é o jeito de rodar isto de novo sem
      // precisar do valor antigo, que não guardamos em lugar nenhum.
      await sql.unsafe(`alter role "${role}" with login password '${password}'`);
      console.log(`Usuário "${role}" já existia — senha rotacionada.`);
    } else {
      await sql.unsafe(`create role "${role}" with login password '${password}'`);
      console.log(`Usuário "${role}" criado.`);
    }

    // O search_path fica no usuário: aplicado no login pelo próprio Postgres.
    await sql.unsafe(`alter role "${role}" set search_path = "${SCHEMA}", public`);

    // Acesso SÓ ao schema do cliente. Sem GRANT nos outros, o banco recusa.
    await sql.unsafe(`grant usage on schema "${SCHEMA}" to "${role}"`);
    await sql.unsafe(`grant all on all tables in schema "${SCHEMA}" to "${role}"`);
    await sql.unsafe(`grant all on all sequences in schema "${SCHEMA}" to "${role}"`);
    // Tabelas criadas por migrations futuras já nascem acessíveis.
    await sql.unsafe(
      `alter default privileges in schema "${SCHEMA}" grant all on tables to "${role}"`
    );
    await sql.unsafe(
      `alter default privileges in schema "${SCHEMA}" grant all on sequences to "${role}"`
    );
    // `public` fica só para leitura de extensões — nada de dados de vizinho.
    await sql.unsafe(`grant usage on schema public to "${role}"`);
    console.log('Permissões aplicadas (apenas no schema do cliente).');

    // Monta a string com o novo usuário. No pooler do Supabase o usuário
    // carrega o ref do projeto: `<user>.<ref>`.
    const m = url.match(/^postgresql:\/\/([^:]+):([^@]+)@(.+)$/);
    if (!m) throw new Error('DATABASE_URL em formato inesperado');
    const [, currentUser, , rest] = m;
    const ref = currentUser.includes('.') ? currentUser.split('.').slice(1).join('.') : null;
    const newUser = ref ? `${role}.${ref}` : role;
    const conn = `postgresql://${newUser}:${encodeURIComponent(password)}@${rest}`;

    const pasta = process.env.CLIENT_FOLDER?.trim()
      ? `.credenciais/${process.env.CLIENT_FOLDER.trim()}`
      : '.credenciais';
    mkdirSync(pasta, { recursive: true });
    const file = `${pasta}/${SCHEMA}.conn.txt`;
    writeFileSync(file, conn + '\n');
    console.log(`\nString de conexão salva em ${file}`);
    console.log('Use no `wrangler hyperdrive create` deste cliente.');
  } finally {
    await sql.end();
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
