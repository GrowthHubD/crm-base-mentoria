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
 * Ou com defaults:
 *   npm run db:seed
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
}) {
  const [existing] = await db.select().from(users).where(eq(users.email, args.email)).limit(1);
  if (existing) {
    await db
      .update(users)
      .set({ role: args.role, updatedAt: new Date() })
      .where(eq(users.id, existing.id));
    console.log(`  ↳ user ${args.email} já existe — role sincronizada`);
    return;
  }
  try {
    await auth.api.signUpEmail({
      body: { email: args.email, password: args.password, name: args.name },
    });
  } catch (err) {
    console.error(`  ✗ falha criando ${args.email}:`, err);
    return;
  }
  await db
    .update(users)
    .set({ role: args.role, updatedAt: new Date() })
    .where(eq(users.email, args.email));
  console.log(`  ✓ user ${args.email} (${args.role}) criado`);
}

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL ?? 'admin@crm.local';
  const adminPassword = process.env.ADMIN_PASSWORD ?? 'admin12345';
  const adminName = process.env.ADMIN_NAME ?? 'Admin';

  console.log('\n═══════════════════════════════════════════');
  console.log('  SEED — CRM WhatsApp');
  console.log('═══════════════════════════════════════════\n');

  await ensureUser({ email: adminEmail, password: adminPassword, name: adminName, role: 'admin' });

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
  console.log(`Admin:      ${adminEmail} / ${adminPassword}`);
  
  console.log('\nLogin: http://localhost:9876/login\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed falhou:', err);
  process.exit(1);
});
