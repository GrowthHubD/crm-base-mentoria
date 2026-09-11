/**
 * Troca o e-mail e/ou a senha de um usuário existente, preservando o id.
 *
 * Existe por causa de uma conta específica: o `seed.ts` criava
 * `atendente@crm.local` com a senha escrita no próprio arquivo, em TODA
 * instância. Quem lesse o repositório entrava como atendente no CRM de
 * qualquer cliente. O seed já foi corrigido, mas as contas que ele criou
 * continuam vivas nos bancos.
 *
 * Preserva o id de propósito: `messages.sent_by_id` e `leads.converted_by_id`
 * apontam para ele. Apagar e recriar o usuário zeraria a autoria das mensagens
 * já enviadas e o ranking de conversões — o histórico do cliente é dele, não
 * nosso para descartar.
 *
 * A senha é gravada pelo MESMO caminho do better-auth (`auth.$context`), e não
 * por um hash montado à mão: o formato é interno da biblioteca e escrever um
 * hash "equivalente" é como o login para de funcionar sem ninguém entender.
 *
 * Uso:
 *   DB_SCHEMA=cliente_acme npx tsx scripts/rotacionar-usuario.ts \
 *     --de atendente@crm.local --para atendente@acme.lidy
 *
 *   ... --senha <valor>   para fixar uma senha em vez de sortear
 *   ... --so-senha        mantém o e-mail, troca só a senha
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { auth } from '../src/lib/auth';
import { db, DB_SCHEMA } from '../src/lib/db/client';
import { users, accounts } from '../src/lib/db/schema/users';

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const de = (arg('de') ?? '').trim().toLowerCase();
const para = (arg('para') ?? '').trim().toLowerCase();
const soSenha = argv.includes('--so-senha');

if (!de) {
  console.error('--de <email atual> é obrigatório.');
  process.exit(1);
}
if (!soSenha && !para) {
  console.error('--para <email novo> é obrigatório (ou use --so-senha).');
  process.exit(1);
}

/** Sem caracteres ambíguos (0/O, 1/l/I): esta senha vai ser lida em voz alta. */
const senha =
  arg('senha') ??
  Array.from(randomBytes(14))
    .map(b => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 55])
    .join('');

async function main() {
  console.log(`\nschema: ${DB_SCHEMA}`);

  const [usuario] = await db.select().from(users).where(eq(users.email, de)).limit(1);
  if (!usuario) {
    console.error(`Não achei usuário com e-mail ${de} neste schema.`);
    process.exit(1);
  }
  console.log(`encontrado: ${usuario.email}  (${usuario.role})  id=${usuario.id}`);

  // Hash pelo caminho interno do better-auth — mesmo algoritmo e mesmo formato
  // que o signUp usa, então o login continua funcionando.
  const ctx = await auth.$context;
  const hash = await ctx.password.hash(senha);

  const atualizadas = await db
    .update(accounts)
    .set({ password: hash, updatedAt: new Date() })
    .where(eq(accounts.userId, usuario.id))
    .returning({ id: accounts.id });

  if (atualizadas.length === 0) {
    console.error('Usuário existe mas não tem credencial de senha — nada a rotacionar.');
    process.exit(1);
  }
  console.log(`senha trocada (${atualizadas.length} credencial)`);

  if (!soSenha) {
    await db
      .update(users)
      .set({ email: para, updatedAt: new Date() })
      .where(eq(users.id, usuario.id));
    console.log(`e-mail: ${de} → ${para}`);
  }

  console.log(`
═══════════════════════════════════════════
  ACESSO ATUALIZADO
  usuário: ${soSenha ? de : para}
  senha:   ${senha}
  papel:   ${usuario.role}
═══════════════════════════════════════════
`);
  process.exit(0);
}

main().catch(err => {
  console.error('falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
