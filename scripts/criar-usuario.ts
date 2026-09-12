/**
 * Cria um usuário novo num schema, com senha gerada.
 *
 * Existe porque o cadastro público foi FECHADO (o `/api/auth/sign-up/email`
 * respondia a qualquer um na internet — ver `middleware.ts`), e a rota do
 * painel exige uma sessão de admin. Para criar o primeiro acesso de alguém, ou
 * um login de teste, este é o caminho.
 *
 * A senha é gravada pelo MESMO caminho do better-auth (`auth.$context`), e não
 * por um hash montado à mão: o formato é interno da biblioteca, e um hash
 * "equivalente" é como o login para de funcionar sem ninguém entender por quê.
 *
 * Uso:
 *   DATABASE_URL=... DB_SCHEMA=cliente_acme6 npx tsx scripts/criar-usuario.ts \
 *     --email fulano@acme6.crm --nome "Fulano" [--papel admin] [--senha <valor>]
 */
import 'dotenv/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth } from '../src/lib/auth';
import { db, DB_SCHEMA } from '../src/lib/db/client';
import { users, accounts } from '../src/lib/db/schema/users';

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const email = (arg('email') ?? '').trim().toLowerCase();
const nome = (arg('nome') ?? '').trim();
const papel = (arg('papel') ?? 'attendant').trim() as 'admin' | 'attendant';

if (!email || !nome) {
  console.error('Uso: --email <e-mail> --nome "<nome>" [--papel admin|attendant]');
  process.exit(1);
}
if (papel !== 'admin' && papel !== 'attendant') {
  console.error(`--papel inválido: "${papel}" (use admin ou attendant)`);
  process.exit(1);
}

/** Sem caracteres ambíguos (0/O, 1/l/I): esta senha vai ser lida em voz alta. */
const senha =
  arg('senha') ??
  Array.from(randomBytes(14))
    .map((b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 55])
    .join('');

async function main() {
  console.log(`\nschema: ${DB_SCHEMA}`);

  const [existente] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existente) {
    console.error(`Já existe usuário com ${email} neste schema (papel: ${existente.role}).`);
    console.error('Para trocar a senha dele, use scripts/rotacionar-usuario.ts --so-senha.');
    process.exit(1);
  }

  const ctx = await auth.$context;
  const hash = await ctx.password.hash(senha);
  const agora = new Date();

  // O `id` é gerado pela APLICAÇÃO (`$defaultFn` no schema), não pelo banco —
  // omiti-lo faz o Drizzle mandar `default` e o Postgres recusar por NOT NULL.
  const userId = randomUUID();

  const [criado] = await db
    .insert(users)
    .values({
      id: userId,
      email,
      name: nome,
      role: papel,
      emailVerified: true, // sistema interno — não há fluxo de verificação
      createdAt: agora,
      updatedAt: agora,
    })
    .returning({ id: users.id });

  await db.insert(accounts).values({
    id: randomUUID(),
    userId: criado.id,
    // O better-auth identifica a credencial de senha por este par; é o que o
    // login procura ao receber e-mail + senha.
    providerId: 'credential',
    accountId: criado.id,
    password: hash,
    createdAt: agora,
    updatedAt: agora,
  });

  console.log(`\ncriado: ${email}  (${papel})  id=${criado.id}`);
  console.log(`senha:  ${senha}`);
  console.log('\nTroque a senha no primeiro acesso.');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('Falhou:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
);
