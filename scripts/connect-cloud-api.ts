/**
 * Cadastra (ou atualiza) a conexão do WhatsApp OFICIAL — Cloud API da Meta.
 *
 * Por que é script e não tela: a tela de Conexões existe para o fluxo da
 * uazapi, que é QR code. O canal oficial não tem QR — ele tem credencial, e
 * credencial se cola uma vez, no onboarding. Enquanto a tela não cobrir os
 * dois canais, isto aqui é o caminho honesto.
 *
 * Antes de rodar, tenha em mãos (Meta Business → WhatsApp → Configuração da API):
 *   - phone_number_id  (o ID do número, NÃO o telefone)
 *   - token permanente do System User com `whatsapp_business_messaging`
 *   - waba_id          (opcional, só referência)
 *
 * Uso:
 *   npx tsx scripts/connect-cloud-api.ts \
 *     --phone-number-id 123456789012345 \
 *     --token EAAG... \
 *     --waba-id 987654321098765
 *
 * O token é gravado criptografado (`ENCRYPTION_KEY`), como o da uazapi.
 * O script é idempotente: rodar de novo com o mesmo phone_number_id atualiza
 * a conexão existente em vez de criar outra.
 */
import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db } from '../src/lib/db/client';
import { connections } from '../src/lib/db/schema';
import { encrypt } from '../src/lib/encryption';
import { fetchPhoneNumber } from '../src/modules/channels/whatsapp/cloud-api/client';
import { CLOUD_API_PROVIDER } from '../src/modules/channels/whatsapp/cloud-api/provider';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const phoneNumberId = arg('phone-number-id');
  const accessToken = arg('token');
  const wabaId = arg('waba-id') ?? null;

  if (!phoneNumberId || !accessToken) {
    console.error('Faltou --phone-number-id e/ou --token. Veja o cabeçalho do arquivo.');
    process.exit(1);
  }

  // Confere a credencial ANTES de gravar: um token errado gravado gera um CRM
  // que parece conectado e falha em toda mensagem.
  const info = await fetchPhoneNumber({ phoneNumberId, accessToken });
  if (!info) {
    console.error(
      'A Meta não aceitou essa combinação de phone_number_id + token.\n' +
        'Confira se o token é do System User certo e tem whatsapp_business_messaging.'
    );
    process.exit(1);
  }

  console.log(`Número confirmado na Meta: ${info.displayPhoneNumber ?? '(sem display)'} — ${info.verifiedName ?? '(sem nome verificado)'}`);

  const [existing] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(eq(connections.externalId, phoneNumberId))
    .limit(1);

  const values = {
    type: 'whatsapp' as const,
    externalId: phoneNumberId,
    displayName: info.verifiedName ?? 'WhatsApp Oficial',
    phoneNumber: info.displayPhoneNumber ?? null,
    accessTokenEncrypted: encrypt(accessToken),
    status: 'connected' as const,
    metadata: { provider: CLOUD_API_PROVIDER, wabaId },
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(connections).set(values).where(eq(connections.id, existing.id));
    console.log(`Conexão atualizada: ${existing.id}`);
    printWebhook(existing.id);
    return;
  }

  const [created] = await db.insert(connections).values(values).returning({ id: connections.id });
  console.log(`Conexão criada: ${created.id}`);
  printWebhook(created.id);
}

function printWebhook(connectionId: string) {
  const base = process.env.NEXTAUTH_URL ?? 'https://SEU-DOMINIO';
  console.log('\nAgora, no painel da Meta (WhatsApp → Configuração → Webhook):');
  console.log(`  URL de callback:   ${base}/api/webhooks/meta/${connectionId}`);
  console.log('  Token de verificação: o valor de META_VERIFY_TOKEN');
  console.log('  Campos assinados:  messages');
  console.log('\nE garanta META_APP_SECRET no ambiente — sem ele o webhook aceita qualquer payload.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
