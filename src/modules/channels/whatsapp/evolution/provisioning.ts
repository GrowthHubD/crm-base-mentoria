/**
 * Provisionamento de instância Evolution pela tela de Conexões.
 *
 * É o equivalente ao `provisionWhatsAppInstance` da uazapi: o cliente clica em
 * "Conectar número", escaneia o QR e pronto — ninguém abre o painel da
 * Evolution, ninguém copia key, ninguém roda script.
 *
 * A ordem aqui não é estética. O `connectionId` é gerado ANTES de falar com a
 * Evolution porque ele entra na URL do webhook, que é registrada no nascimento
 * da instância. Registrar o webhook depois abriria uma janela em que o número
 * já conectou e as mensagens chegam sem destino — e mensagem de WhatsApp não
 * volta.
 *
 * Sobre segredos: a key GLOBAL do servidor (env `EVOLUTION_GLOBAL_API_KEY`) é
 * usada só para criar a instância e nunca é persistida. O que vai para o banco,
 * criptografado, é a key DA INSTÂNCIA — que só opera aquele número.
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { eq } from 'drizzle-orm';
import { encrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { createInstance, connectInstance, instanceStatus } from './client';
import { EVOLUTION_PROVIDER, getEvolutionConnection, mapConnectionState } from './provider';

export class EvolutionConfigError extends Error {}

function serverConfig(): { baseUrl: string; globalKey: string } {
  const baseUrl = process.env.EVOLUTION_URL?.trim();
  const globalKey = process.env.EVOLUTION_GLOBAL_API_KEY?.trim();
  if (!baseUrl || !globalKey) {
    throw new EvolutionConfigError(
      'Evolution não configurada neste deploy: defina EVOLUTION_URL e EVOLUTION_GLOBAL_API_KEY.'
    );
  }
  return { baseUrl, globalKey };
}

/** Está configurada? A tela usa isto para decidir se mostra a opção. */
export function isEvolutionConfigured(): boolean {
  return Boolean(process.env.EVOLUTION_URL?.trim() && process.env.EVOLUTION_GLOBAL_API_KEY?.trim());
}

/**
 * Nome da instância no servidor Evolution.
 *
 * Derivado do nome que o usuário digitou, mas com sufixo aleatório: o servidor
 * é compartilhado entre clientes, e dois "Comercial" colidiriam. A colisão não
 * daria erro visível — o segundo simplesmente falharia ao criar.
 */
function nomeInstancia(displayName: string): string {
  const base = displayName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return `${base || 'instancia'}-${randomBytes(3).toString('hex')}`;
}

export interface ProvisionResult {
  id: string;
  instanceName: string;
  status: 'qr_pending' | 'connected';
  qrcode: string | null;
}

export async function provisionEvolutionInstance(input: {
  displayName: string;
  /** Base pública deste deploy, para montar a URL do webhook. */
  appBaseUrl: string;
  /**
   * Quem clicou em conectar — vira dono do número, e é dele a conversa que
   * entrar por aqui. Sem isto a conexão nasce sem dono, e um número sem dono
   * é visível só para o admin (ver `lib/escopo-dono.ts`).
   */
  ownerId?: string | null;
}): Promise<ProvisionResult> {
  const { baseUrl, globalKey } = serverConfig();

  const connectionId = randomUUID();
  const webhookToken = randomBytes(24).toString('hex');
  const instanceName = nomeInstancia(input.displayName);
  const webhookUrl = `${input.appBaseUrl.replace(/\/+$/, '')}/api/webhooks/evolution/${connectionId}`;

  const { instance, error } = await createInstance(baseUrl, globalKey, {
    instanceName,
    webhookUrl,
    webhookToken,
  });

  if (!instance || error) {
    throw new Error(`Evolution recusou criar a instância: ${error ?? 'resposta inesperada'}`);
  }
  if (!instance.apiKey) {
    // Sem a key da instância só restaria usar a global no dia a dia — que é
    // exatamente o que este desenho evita. Melhor falhar alto.
    throw new Error('Evolution criou a instância mas não devolveu a key dela');
  }

  await db.insert(connections).values({
    id: connectionId,
    type: 'whatsapp',
    status: 'qr_pending',
    externalId: instanceName,
    displayName: input.displayName,
    ownerId: input.ownerId ?? null,
    accessTokenEncrypted: encrypt(instance.apiKey),
    metadata: { provider: EVOLUTION_PROVIDER, baseUrl, webhookToken },
  });

  logger.info(
    { connectionId, instanceName, webhookUrl },
    '[evolution] instância provisionada e webhook registrado'
  );

  return {
    id: connectionId,
    instanceName,
    status: 'qr_pending',
    qrcode: instance.qrcodeBase64,
  };
}

/**
 * QR novo para uma connection Evolution existente.
 *
 * O QR do WhatsApp expira em ~60s; a tela chama isto de novo enquanto o
 * usuário não escaneia. Assim que o número conecta, devolve `connected` — e é
 * esse retorno que faz a tela parar de pedir QR e fechar o modal.
 */
export async function getEvolutionQrCode(connectionId: string): Promise<{
  qrcode: string | null;
  connected: boolean;
  status: 'qr_pending' | 'connected' | 'disconnected';
}> {
  const conn = await getEvolutionConnection(connectionId);
  if (!conn) throw new Error(`Connection ${connectionId} não é Evolution ou não existe`);

  const estado = await instanceStatus(conn.credentials);

  if (mapConnectionState(estado.state) === 'connected') {
    await marcarConectada(connectionId, estado.phone);
    return { qrcode: null, connected: true, status: 'connected' };
  }

  const r = await connectInstance(conn.credentials);
  if (r.error) throw new Error(`Evolution não devolveu QR: ${r.error}`);

  return { qrcode: r.qrcodeBase64, connected: false, status: 'qr_pending' };
}

/** Sincroniza o estado remoto com o banco (usado pelo polling da tela). */
export async function syncEvolutionStatus(connectionId: string): Promise<{
  status: 'connected' | 'qr_pending' | 'disconnected';
  phone: string | null;
}> {
  const conn = await getEvolutionConnection(connectionId);
  if (!conn) throw new Error(`Connection ${connectionId} não é Evolution ou não existe`);

  const estado = await instanceStatus(conn.credentials);

  // Não consegui falar com o servidor. Isso NÃO é desconexão: marcar a
  // connection como caída por uma falha de rede faria a tela anunciar que o
  // número do cliente saiu do ar quando ele está conversando normalmente.
  if (estado.state === null) {
    logger.warn(
      { connectionId, erro: estado.error },
      '[evolution] não consegui ler o estado — mantendo o status atual'
    );
    return {
      status: conn.status as 'connected' | 'qr_pending' | 'disconnected',
      phone: null,
    };
  }

  const status = mapConnectionState(estado.state);

  if (status === 'connected') {
    const phone = await marcarConectada(connectionId, estado.phone);
    return { status, phone };
  }

  await db
    .update(connections)
    .set({ status, updatedAt: new Date() })
    .where(eq(connections.id, connectionId));

  return { status, phone: null };
}

/** Marca conectada e guarda o número que veio junto do estado. */
async function marcarConectada(connectionId: string, phone: string | null): Promise<string | null> {
  await db
    .update(connections)
    .set({
      status: 'connected',
      ...(phone ? { phoneNumber: phone } : {}),
      updatedAt: new Date(),
    })
    .where(eq(connections.id, connectionId));

  return phone;
}
