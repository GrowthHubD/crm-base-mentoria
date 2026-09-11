/**
 * Configuração better-auth
 * Referência: https://www.better-auth.com/docs/installation
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './db/client';
import * as schema from './db/schema';

/**
 * Todas as formas de escrever o MESMO endereço.
 *
 * O better-auth compara o `Origin` por string exata, então
 * `http://x.com`, `https://x.com` e `https://www.x.com` são três origens
 * diferentes para ele — e duas delas viravam "Invalid origin" com o usuário
 * certo e a senha certa. Aconteceu com um cliente: funcionava na máquina de
 * quem testou e falhava na dele, porque o navegador dele mandou `http://`.
 *
 * Aceitar as variantes do MESMO host não afrouxa a proteção: o que ela impede é
 * um site de OUTRO domínio postar credencial aqui, e isso continua barrado.
 * Domínio diferente (o acesso central, por exemplo) não entra nesta lista de
 * propósito — se entrasse, a senha poderia ser postada de lá, que é justamente
 * o desenho que evitamos.
 */
function variantesDoMesmoHost(url: string | undefined): string[] {
  if (!url) return [];
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return [url];
  }
  const semWww = host.replace(/^www\./, '');
  const hosts = new Set([semWww, `www.${semWww}`]);
  return [...hosts].flatMap(h => [`https://${h}`, `http://${h}`]);
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false, // sistema interno — sem verificação de email
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 dias
    updateAge: 60 * 60 * 24, // renova se mais de 1 dia se passou
  },
  secret: process.env.BETTER_AUTH_SECRET!,
  // better-auth usa esse baseURL pra montar callbacks/redirects.
  // Lê de BETTER_AUTH_URL (convenção better-auth) ou NEXTAUTH_URL (convenção
  // do .env do projeto) — ambos funcionam.
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXTAUTH_URL ?? 'http://localhost:9876',
  trustedOrigins: [
    // Todas as grafias do endereço oficial desta instância.
    ...variantesDoMesmoHost(process.env.NEXTAUTH_URL ?? 'http://localhost:9876'),
    // Domínios PRÓPRIOS do cliente, separados por vírgula.
    //
    // Existe porque o cliente acessa o CRM pelo domínio dele (crm.cliente.com)
    // enquanto o Worker continua sendo o mesmo. Sem isto, o better-auth compara
    // o `Origin` só com o `NEXTAUTH_URL` e recusa o login com "Invalid origin" —
    // senha certa, usuário certo, e a tela dizendo que não. É por ambiente
    // (`vars` do wrangler), então ligar um domínio novo não exige mexer em código.
    // E das outras que também alcançam esta instância (endereço antigo,
    // workers.dev), cada uma com as suas variantes.
    ...(process.env.EXTRA_TRUSTED_ORIGINS ?? '')
      .split(',')
      .map(o => o.trim())
      .filter(Boolean)
      .flatMap(variantesDoMesmoHost),
    // Aliases comuns em dev — evita "Invalid origin" se acessar via 127.0.0.1 ou outra porta
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:9876',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:9876',
  ],
});

export type Session = typeof auth.$Infer.Session;
export type User = typeof auth.$Infer.Session.user;
