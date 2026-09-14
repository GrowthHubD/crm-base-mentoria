/**
 * Seed inicial — single-tenant:
 *   1. Cria um usuário admin (se ainda não existir)
 *   2. Cria um atendente de exemplo (opcional)
 *
 * A config do agente IA é criada sob demanda no primeiro acesso a /agente-ia
 * (getOrInitConfig), então não precisa seedar aqui.
 *
 * Uso:
 *   ADMIN_EMAIL=admin@crm.local ADMIN_PASSWORD=senha123 npm run db:seed
 *
 * Sem ADMIN_PASSWORD a senha é SORTEADA e impressa uma única vez. Não existe
 * senha padrão: um default fixo no código é a mesma senha em toda instalação
 * que seguir o README — e este repositório é público.
 */
import 'dotenv/config';
import { auth } from '../src/lib/auth';
import { db } from '../src/lib/db/client';
import { users } from '../src/lib/db/schema';
import { eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

async function ensureUser(args: {
  email: string;
  password: string;
  name: string;
  role: 'admin' | 'attendant';
}): Promise<'created' | 'existed' | 'failed'> {
  const [existing] = await db.select().from(users).where(eq(users.email, args.email)).limit(1);
  if (existing) {
    // Conta existente não é tocada: o seed não pode promover a admin uma
    // conta qualquer só por ter o mesmo e-mail.
    console.log(`  ↳ user ${args.email} já existe — senha, papel e unidade preservados`);
    return 'existed';
  }
  try {
    await auth.api.signUpEmail({
      body: { email: args.email, password: args.password, name: args.name },
    });
  } catch (err) {
    console.error(`  ✗ falha criando ${args.email}:`, err);
    return 'failed';
  }
  await db
    .update(users)
    .set({ role: args.role, updatedAt: new Date() })
    .where(eq(users.email, args.email));
  console.log(`  ✓ user ${args.email} (${args.role}) criado`);
  return 'created';
}

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@crm.local';
  const senhaInformada = !!process.env.ADMIN_PASSWORD;
  const adminPassword = process.env.ADMIN_PASSWORD ?? randomBytes(12).toString('base64url');
  const adminName = process.env.ADMIN_NAME ?? 'Admin';

  console.log('\n═══════════════════════════════════════════');
  console.log('  SEED — CRM WhatsApp');
  console.log('═══════════════════════════════════════════\n');

  const admin = await ensureUser({ email: adminEmail, password: adminPassword, name: adminName, role: 'admin' });

  // Atendente de exemplo — SÓ quando pedido explicitamente.
  //
  // Antes era criado sempre, com e-mail e senha fixos no código. O efeito é que
  // toda instância de cliente nascia com uma conta de atendente cuja senha está
  // escrita neste arquivo: quem lê o repositório entra no CRM de qualquer
  // cliente. Foi encontrada viva no banco de um cliente real.
  //
  // Conta de exemplo serve para dev e demonstração; num cliente pagante ela é
  // porta dos fundos. Por isso opt-in, e com senha sorteada quando ligada.
  if (process.env.SEED_ATENDENTE_EXEMPLO === '1') {
    const senha = process.env.ATENDENTE_PASSWORD ?? randomBytes(9).toString('base64url');
    await ensureUser({
      email: process.env.ATENDENTE_EMAIL ?? 'atendente@crm.local',
      password: senha,
      name: 'Atendente',
      role: 'attendant',
    });
    console.log(`  (atendente de exemplo — senha: ${senha})`);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  CREDENCIAIS');
  console.log('═══════════════════════════════════════════');
  if (admin === 'created') {
    console.log(`Admin:      ${adminEmail} / ${adminPassword}`);
    if (!senhaInformada) {
      console.log('            (senha sorteada — guarde agora, não é gravada em lugar nenhum)');
    }
  } else if (admin === 'existed') {
    console.log(`Admin:      ${adminEmail} (já existia — a senha continua a de antes)`);
  }

  console.log('\nLogin: http://localhost:9876/login\n');
  process.exit(admin === 'failed' ? 1 : 0);
}

main().catch((err) => {
  console.error('Seed falhou:', err);
  process.exit(1);
});
