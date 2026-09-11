/**
 * Service layer do módulo channels — resolve o adapter correto pra uma
 * connection e expõe APIs de envio agnósticas ao provedor.
 *
 * Responsabilidades:
 *   - Decryptar token armazenado em `connections.access_token_encrypted`
 *   - Fazer cache curto de adapters (evita decrypt a cada send)
 *   - Resolver `instanceToken` por leadId (lead → connection → token)
 */
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { whatsappInstances } from '@/lib/db/schema/whatsapp-instances';
import { leads } from '@/lib/db/schema/leads';
import { eq } from 'drizzle-orm';
import { decrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { UazapiAdapter } from './whatsapp/adapter';
import { CloudApiAdapter } from './whatsapp/cloud-api/adapter';
import { CLOUD_API_PROVIDER } from './whatsapp/cloud-api/provider';
import { EvolutionAdapter } from './whatsapp/evolution/adapter';
import { EVOLUTION_PROVIDER } from './whatsapp/evolution/provider';
import {
  initInstance,
  connectInstance,
  getStatus,
  logout,
  setWebhook,
  isStatusConnected,
  extractPhoneFromStatus,
  getChatDetails,
} from './whatsapp/client';
import type { ChannelAdapter } from './types';

// Cache TTL curto de adapters por connectionId (token decryptado em memória).
// Invalidamos quando a connection é atualizada (via mutation).
const adapterCache = new Map<string, { adapter: ChannelAdapter; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export function invalidateAdapterCache(connectionId?: string) {
  if (connectionId) adapterCache.delete(connectionId);
  else adapterCache.clear();
}

/**
 * Esta connection é Evolution?
 *
 * Consulta só o `metadata`, sem decriptar token — é chamada nos caminhos de
 * QR/status, que rodam em polling enquanto a tela de Conexões está aberta.
 */
async function isEvolutionConnection(connectionId: string): Promise<boolean> {
  const [row] = await db
    .select({ metadata: connections.metadata })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  return (row?.metadata as { provider?: string } | null)?.provider === EVOLUTION_PROVIDER;
}

/**
 * URL canônica do webhook DESSA connection — rota dinâmica por id, evita
 * dedup do servidor uazapi quando há múltiplas instâncias na mesma unit.
 */
export function buildInstanceWebhookUrl(baseUrl: string, connectionId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/webhooks/whatsapp/${connectionId}`;
}

/**
 * Re-configura o webhook das OUTRAS conexões WhatsApp (best-effort). Chamado
 * quando provisionamos uma nova instância: garante que TODAS apontem pra URL
 * única `/api/webhooks/whatsapp/<id>`, eliminando colisão no servidor uazapi.
 */
async function resyncSiblingWebhooks(args: {
  exceptConnectionId: string;
  baseUrl: string;
}): Promise<void> {
  const siblings = await db
    .select({
      id: connections.id,
      accessTokenEncrypted: connections.accessTokenEncrypted,
    })
    .from(connections)
    .where(eq(connections.type, 'whatsapp'));

  for (const s of siblings) {
    if (s.id === args.exceptConnectionId) continue;
    if (!s.accessTokenEncrypted) continue;
    let token: string | undefined;
    try {
      token = decrypt(s.accessTokenEncrypted);
    } catch {
      continue;
    }
    if (!token) continue;
    const url = buildInstanceWebhookUrl(args.baseUrl, s.id);
    const ok = await setWebhook(url, token);
    logger.info(
      { connectionId: s.id, url, ok },
      '[channels] resync webhook irmão'
    );
  }
}

/**
 * Cria/retorna adapter pronto pra enviar mensagens via uma connection
 * WhatsApp. Faz lookup da connection, decrypta token, instancia adapter.
 *
 * Lança Error se a connection não existe, está inativa, ou sem token.
 */
export async function getWhatsAppAdapter(connectionId: string): Promise<ChannelAdapter> {
  const cached = adapterCache.get(connectionId);
  if (cached && cached.expiresAt > Date.now()) return cached.adapter;

  const [conn] = await db
    .select({
      id: connections.id,
      type: connections.type,
      status: connections.status,
      accessTokenEncrypted: connections.accessTokenEncrypted,
      externalId: connections.externalId,
      metadata: connections.metadata,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!conn) throw new Error(`Connection ${connectionId} não encontrada`);
  if (conn.type !== 'whatsapp') throw new Error(`Connection ${connectionId} não é WhatsApp`);
  if (conn.status !== 'connected') {
    logger.warn(
      { connectionId, status: conn.status },
      '[channels] tentativa de envio em connection não conectada'
    );
  }

  // De que provedor e esta connection? A oficial (Cloud API da Meta) guarda
  // `provider: "cloud-api"` no metadata, a Evolution guarda `"evolution"`; a
  // ausencia do campo significa uazapi, que era o unico canal antes de existir
  // escolha.
  const meta = (conn.metadata ?? {}) as { provider?: string; baseUrl?: string };

  if (meta.provider === EVOLUTION_PROVIDER) {
    if (!conn.accessTokenEncrypted) {
      throw new Error(`Connection ${connectionId} (Evolution) sem key da instância`);
    }
    // A Evolution é self-hosted: sem saber QUAL servidor, não há para onde
    // enviar. Falhar alto aqui é melhor que cair no fallback uazapi e mandar
    // a mensagem do cliente para o servidor errado.
    if (!meta.baseUrl) {
      throw new Error(`Connection ${connectionId} (Evolution) sem metadata.baseUrl`);
    }
    const evolution = new EvolutionAdapter({
      baseUrl: meta.baseUrl,
      instanceName: conn.externalId,
      apiKey: decrypt(conn.accessTokenEncrypted),
    });
    adapterCache.set(connectionId, { adapter: evolution, expiresAt: Date.now() + CACHE_TTL_MS });
    return evolution;
  }

  if (meta.provider === CLOUD_API_PROVIDER) {
    if (!conn.accessTokenEncrypted) {
      throw new Error(`Connection ${connectionId} (Cloud API) sem token da Meta`);
    }
    const accessToken = decrypt(conn.accessTokenEncrypted);
    // No canal oficial o `externalId` da connection E o phone_number_id — e o
    // que a Meta usa tanto pra enviar quanto pra identificar quem recebeu.
    const cloud = new CloudApiAdapter({ phoneNumberId: conn.externalId, accessToken });
    adapterCache.set(connectionId, { adapter: cloud, expiresAt: Date.now() + CACHE_TTL_MS });
    return cloud;
  }

  let token: string | undefined;
  if (conn.accessTokenEncrypted) {
    try {
      token = decrypt(conn.accessTokenEncrypted);
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err, connectionId },
        '[channels] decrypt do token falhou'
      );
    }
  }

  // Fallback dev: usa token global do .env quando connection não tem o seu.
  // Em produção isso só deve acontecer durante onboarding antes do init.
  if (!token) {
    token = process.env.UAZAPI_TOKEN || undefined;
  }

  const adapter = new UazapiAdapter({
    instanceToken: token,
    instanceId: conn.externalId,
  });

  adapterCache.set(connectionId, { adapter, expiresAt: Date.now() + CACHE_TTL_MS });
  return adapter;
}

/**
 * Resolve o adapter a partir do leadId. Lookups encadeados:
 * lead.connectionId → connection → adapter. Retorna o contrato uniforme
 * `ChannelAdapter` pra workers consumirem indistintamente do canal.
 */
export async function getAdapterForLead(leadId: string): Promise<ChannelAdapter> {
  const [lead] = await db
    .select({ connectionId: leads.connectionId, channel: leads.channel })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  if (!lead) throw new Error(`Lead ${leadId} não encontrado`);
  if (!lead.connectionId) {
    throw new Error(`Lead ${leadId} sem connection vinculada`);
  }

  if (lead.channel === 'whatsapp') return getWhatsAppAdapter(lead.connectionId);
  throw new Error(`Lead ${leadId} em canal não suportado: ${lead.channel}`);
}

/**
 * Resolve a connection ativa do canal WhatsApp pelo número da instância.
 * Usado pelo webhook handler para identificar a connection que recebeu uma
 * mensagem inbound, baseado no `instanceName` ou no `phone` recebido.
 */
export async function findConnectionByInstance(
  instanceName: string | null
): Promise<{ id: string; status: string; unitId: string | null } | null> {
  if (!instanceName) return null;

  // 1. Tentar match direto em whatsapp_instances.instance_id
  const [inst] = await db
    .select({ connectionId: whatsappInstances.connectionId })
    .from(whatsappInstances)
    .where(eq(whatsappInstances.instanceId, instanceName))
    .limit(1);

  if (inst) {
    const [conn] = await db
      .select({ id: connections.id, status: connections.status, unitId: connections.unitId })
      .from(connections)
      .where(eq(connections.id, inst.connectionId))
      .limit(1);
    return conn ?? null;
  }

  // 2. Fallback: match em connections.external_id
  const [conn] = await db
    .select({ id: connections.id, status: connections.status, unitId: connections.unitId })
    .from(connections)
    .where(eq(connections.externalId, instanceName))
    .limit(1);

  return conn ?? null;
}

/**
 * Cria connection nova com token criptografado.
 * Usado pelo lifecycle de instância (Fase D).
 */
export async function createWhatsAppConnection(input: {
  externalId: string;
  displayName?: string;
  phoneNumber?: string;
  token?: string;
  status?: 'pending' | 'qr_pending' | 'connected' | 'disconnected' | 'error';
  /** Dono do número — ver `lib/escopo-dono.ts`. */
  ownerId?: string | null;
}): Promise<{ id: string }> {
  const { encrypt } = await import('@/lib/encryption');
  const accessTokenEncrypted = input.token ? encrypt(input.token) : null;

  const [created] = await db
    .insert(connections)
    .values({
      type: 'whatsapp',
      externalId: input.externalId,
      displayName: input.displayName,
      phoneNumber: input.phoneNumber,
      ownerId: input.ownerId ?? null,
      accessTokenEncrypted,
      status: input.status ?? 'pending',
    })
    .returning({ id: connections.id });

  invalidateAdapterCache();
  return created;
}

/**
 * Atualiza token / status / phone de uma connection (após connect lifecycle).
 */
export async function updateWhatsAppConnection(
  id: string,
  patch: { token?: string; status?: 'pending' | 'qr_pending' | 'connected' | 'disconnected' | 'error'; phoneNumber?: string; displayName?: string }
): Promise<void> {
  const { encrypt } = await import('@/lib/encryption');
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.token !== undefined) {
    update.accessTokenEncrypted = patch.token ? encrypt(patch.token) : null;
  }
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.phoneNumber !== undefined) update.phoneNumber = patch.phoneNumber;
  if (patch.displayName !== undefined) update.displayName = patch.displayName;

  await db.update(connections).set(update).where(eq(connections.id, id));
  invalidateAdapterCache(id);
}

/**
 * Provisiona uma nova instância WhatsApp na uazapi e persiste no banco.
 *
 * Fluxo:
 *   1. Chama `/instance/init` com AdminToken — body `{ name }`
 *   2. Servidor gera `instance.id` (ex: r43304bfe15460a) e `instance.token` (UUID)
 *   3. Salva connection com externalId=instance.id e token criptografado=instance.token
 *   4. Cria whatsapp_instance row
 *   5. Best-effort: configura webhook URL com o instance token
 */
export async function provisionWhatsAppInstance(input: {
  displayName: string;
  /** Quem clicou em conectar — vira dono do número. Ver `lib/escopo-dono.ts`. */
  ownerId?: string | null;
}): Promise<{ id: string; instanceId: string; status: 'pending' | 'qr_pending' | 'connected' }> {
  const initResult = await initInstance(input.displayName);
  const instanceObj = initResult.instance;
  const instanceId = instanceObj?.id;
  const instanceToken = instanceObj?.token ?? initResult.token;

  if (!instanceId || !instanceToken) {
    throw new Error('uazapi não retornou instance.id/token — resposta inesperada');
  }

  // Idempotência defensiva: se outra connection já existe com esse externalId, reusa.
  const [existing] = await db
    .select({ id: connections.id, status: connections.status, unitId: connections.unitId })
    .from(connections)
    .where(eq(connections.externalId, instanceId))
    .limit(1);

  if (existing) {
    logger.info({ instanceId, connectionId: existing.id }, '[channels] connection já existe, reusando');
    return {
      id: existing.id,
      instanceId,
      status: existing.status as 'pending' | 'qr_pending' | 'connected',
    };
  }

  const created = await createWhatsAppConnection({
    externalId: instanceId,
    displayName: input.displayName,
    token: instanceToken,
    status: 'qr_pending',
    ownerId: input.ownerId ?? null,
  });

  await db.insert(whatsappInstances).values({
    connectionId: created.id,
    instanceId,
  });

  // Webhook por instância: usamos URL única com o connectionId no path
  // (`/api/webhooks/whatsapp/<id>`) pra evitar dedup/colisão no servidor
  // uazapi quando uma unit tem múltiplos números. Sem essa unicidade, o
  // segundo número da unit deixava de receber eventos.
  const baseUrl = process.env.NEXTAUTH_URL || process.env.BETTER_AUTH_URL;
  if (baseUrl) {
    const webhookUrl = buildInstanceWebhookUrl(baseUrl, created.id);
    const ok = await setWebhook(webhookUrl, instanceToken);
    if (!ok) {
      logger.warn({ instanceId, webhookUrl }, '[channels] setWebhook retornou false — config manual pode ser necessária');
    } else {
      logger.info({ instanceId, webhookUrl }, '[channels] webhook configurado com sucesso');
    }

    // Migra conexões EXISTENTES pra rota dinâmica também — sem isso, a antiga
    // ainda aponta pra `/api/webhooks/whatsapp` e a uazapi pode deduplicar com
    // a nova. Best-effort: falha aqui não bloqueia o provisionamento.
    try {
      await resyncSiblingWebhooks({
        exceptConnectionId: created.id,
        baseUrl,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, connectionId: created.id },
        '[channels] resyncSiblingWebhooks falhou (segue)'
      );
    }
  } else {
    logger.warn({ instanceId }, '[channels] NEXTAUTH_URL/BETTER_AUTH_URL ausente — webhook não configurado');
  }

  return { id: created.id, instanceId, status: 'qr_pending' };
}

/**
 * Carrega connection + instance e retorna token decryptado + instanceId.
 * Helper interno para evitar duplicação.
 */
async function loadWhatsAppConnection(connectionId: string): Promise<{
  token: string | undefined;
  instanceId: string;
  dbStatus: string;
}> {
  const [conn] = await db
    .select({
      id: connections.id,
      type: connections.type,
      status: connections.status,
      accessTokenEncrypted: connections.accessTokenEncrypted,
      externalId: connections.externalId,
    })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!conn) throw new Error(`Connection ${connectionId} não encontrada`);
  if (conn.type !== 'whatsapp') throw new Error(`Connection ${connectionId} não é WhatsApp`);

  const [inst] = await db
    .select({ instanceId: whatsappInstances.instanceId })
    .from(whatsappInstances)
    .where(eq(whatsappInstances.connectionId, connectionId))
    .limit(1);

  let token: string | undefined;
  if (conn.accessTokenEncrypted) {
    try {
      token = decrypt(conn.accessTokenEncrypted);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, connectionId }, '[channels] decrypt token falhou');
    }
  }
  if (!token) token = process.env.UAZAPI_TOKEN || undefined;

  return {
    token,
    instanceId: inst?.instanceId ?? conn.externalId,
    dbStatus: conn.status,
  };
}

/**
 * Busca QR code da instância. Se já estiver conectada, sincroniza o status no
 * DB e retorna sem QR.
 *
 * O desvio por provedor fica AQUI e não na rota: a tela de Conexões pede "o QR
 * desta connection" e não deve precisar saber de quem ela é. Foi assim que o
 * canal oficial entrou sem tocar na UI, e é assim que a Evolution entra agora.
 */
export async function getInstanceQrCode(connectionId: string): Promise<{
  qrcode: string | null;
  connected: boolean;
  status: 'qr_pending' | 'connected' | 'disconnected' | 'pending' | 'error';
}> {
  if (await isEvolutionConnection(connectionId)) {
    const { getEvolutionQrCode } = await import('./whatsapp/evolution/provisioning');
    return getEvolutionQrCode(connectionId);
  }

  const { token } = await loadWhatsAppConnection(connectionId);
  if (!token) throw new Error('Connection sem token de instância');

  const result = await connectInstance(token);
  const connected = result.status?.connected === true || result.connected === true;

  if (connected) {
    const phone = result.instance?.owner ?? null;
    await updateWhatsAppConnection(connectionId, {
      status: 'connected',
      phoneNumber: phone ?? undefined,
    });
    return { qrcode: null, connected: true, status: 'connected' };
  }

  return {
    qrcode: result.qrcode ?? result.instance?.qrcode ?? null,
    connected: false,
    status: 'qr_pending',
  };
}

/**
 * Sincroniza status remoto da uazapi com o DB. Se conectou, atualiza phone.
 */
export async function syncInstanceStatus(connectionId: string): Promise<{
  connected: boolean;
  status: 'qr_pending' | 'connected' | 'disconnected' | 'pending' | 'error';
  phone: string | null;
}> {
  if (await isEvolutionConnection(connectionId)) {
    const { syncEvolutionStatus } = await import('./whatsapp/evolution/provisioning');
    const r = await syncEvolutionStatus(connectionId);
    return { connected: r.status === 'connected', status: r.status, phone: r.phone };
  }

  const { token } = await loadWhatsAppConnection(connectionId);
  if (!token) throw new Error('Connection sem token de instância');

  const remote = await getStatus(token);
  const connected = isStatusConnected(remote);
  const phone = extractPhoneFromStatus(remote);

  if (connected) {
    await updateWhatsAppConnection(connectionId, {
      status: 'connected',
      phoneNumber: phone ?? undefined,
    });

    // Garante o webhook AQUI, e não só no provisionamento.
    //
    // O `provisionWhatsAppInstance` já tenta configurá-lo, mas ele roda ANTES
    // de alguém escanear o QR: se a chamada falhar naquele instante, o código
    // só grava um aviso no log e devolve sucesso — a conexão aparece verde na
    // tela e a uazapi nunca sabe para onde avisar. Foi exatamente isso no Riff
    // Store: instância `connected`, token gravado, e ZERO eventos recebidos.
    //
    // Este é o momento em que a conexão fica de fato utilizável, então é aqui
    // que o webhook precisa existir. `setWebhook` é idempotente (sobrescreve a
    // mesma configuração), então repetir a cada polling não custa nada além de
    // uma chamada — e paga por si na primeira vez que a do provisionamento
    // falhar.
    const baseUrl = process.env.NEXTAUTH_URL || process.env.BETTER_AUTH_URL;
    if (baseUrl) {
      try {
        const webhookUrl = buildInstanceWebhookUrl(baseUrl, connectionId);
        await setWebhook(webhookUrl, token);
      } catch (err) {
        // Não derruba o status: a conexão ESTÁ conectada, e dizer o contrário
        // por causa do webhook confundiria quem acabou de escanear o QR.
        logger.warn(
          { err: err instanceof Error ? err.message : err, connectionId },
          '[channels] conexão pronta, mas não consegui garantir o webhook'
        );
      }
    }

    return { connected: true, status: 'connected', phone };
  }

  return { connected: false, status: 'qr_pending', phone };
}

/**
 * Desconecta E remove a instância no servidor uazapi (DELETE /instance) e
 * limpa a connection no DB.
 *
 * `whatsapp_instances` cai por cascade. `leads.connection_id` não tem cascade
 * (queremos preservar histórico de leads), então NULLificamos a FK primeiro.
 */
export async function disconnectInstance(connectionId: string): Promise<void> {
  try {
    const { token } = await loadWhatsAppConnection(connectionId);
    if (token) await logout(token);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, connectionId }, '[channels] logout falhou (best-effort)');
  }
  await db
    .update(leads)
    .set({ connectionId: null })
    .where(eq(leads.connectionId, connectionId));
  await db.delete(connections).where(eq(connections.id, connectionId));
  invalidateAdapterCache(connectionId);
}

/**
 * Best-effort: busca pushName + foto do contato na uazapi e devolve um patch
 * pra atualizar o lead. Usado pra enriquecer leads criados sem nome (ex:
 * agendamento manual antes da primeira mensagem do cliente).
 *
 * Retorna null se a uazapi não respondeu ou não trouxe nome utilizável.
 */
export async function fetchContactNameForLead(
  connectionId: string,
  phone: string
): Promise<{ name: string | null; avatarUrl: string | null } | null> {
  const { token } = await loadWhatsAppConnection(connectionId);
  if (!token) return null;

  const info = await getChatDetails(token, phone);
  if (!info) return null;

  // Preferência: lead_fullName/lead_name (rótulos custom do uazapi) → name (pushName)
  const raw =
    (typeof info.lead_fullName === 'string' && info.lead_fullName.trim()) ||
    (typeof info.lead_name === 'string' && info.lead_name.trim()) ||
    (typeof info.name === 'string' && info.name.trim()) ||
    null;

  const avatar =
    (typeof info.image === 'string' && info.image) ||
    (typeof info.imagePreview === 'string' && info.imagePreview) ||
    null;

  if (!raw && !avatar) return null;
  return { name: raw || null, avatarUrl: avatar || null };
}

export type { ChannelAdapter };
