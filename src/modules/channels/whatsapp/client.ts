/**
 * Cliente HTTP da uazapiGO v2 (servidores dedicados; a base vem de UAZAPI_URL).
 * Docs: https://docs.uazapi.com (renderiza spec dinâmica)
 *
 * IMPORTANTE: dois headers distintos pra dois tipos de operação:
 *   - `AdminToken: <ADMIN_TOKEN>` — endpoints admin (criar/listar instâncias)
 *     Endpoints: POST /instance/init, GET /instance/all
 *     Lê de UAZAPI_ADMIN_TOKEN (com fallback pra UAZAPI_TOKEN p/ retrocompatibilidade)
 *
 *   - `token: <INSTANCE_TOKEN>` — endpoints da instância (envio, status, QR)
 *     Endpoints: POST /instance/connect, GET /instance/status, DELETE /instance,
 *                POST /webhook/set, POST /send/*
 *     Cada instância tem o seu próprio token (UUID), retornado por /instance/init.
 *
 * Não use UAZAPI_TOKEN como instance token genérico — em multi-instância cada
 * connection tem o seu, salvo encriptado em `connections.access_token_encrypted`.
 */
import { logger } from '@/lib/logger';
import { normalizePhone } from './jid';

const BASE = (process.env.UAZAPI_BASE_URL ?? 'https://api.uazapi.com').replace(/\/$/, '');
const ADMIN_TOKEN = process.env.UAZAPI_ADMIN_TOKEN ?? process.env.UAZAPI_TOKEN ?? '';

/**
 * Erro estruturado de chamada uazapi. Permite que callers/workers diferenciem
 * falhas transitórias (5xx, timeout) de permanentes (4xx, validação).
 */
export class UazapiError extends Error {
  constructor(
    public path: string,
    public status: number,
    public body: string,
    message?: string
  ) {
    super(message ?? `Uazapi ${path}: HTTP ${status} — ${body.slice(0, 200)}`);
    this.name = 'UazapiError';
  }

  isTransient(): boolean {
    if (this.status === 0 || this.status >= 500 || this.status === 429) return true;
    // A uazapi às vezes responde 404 "host not mapped" quando a instância
    // desmapeia momentaneamente no servidor dela (hiccup de roteamento) — a
    // mensagem NÃO chegou a sair, então é transitório, não um 404 de recurso
    // inexistente. Retentar (com o backoff da fila) reenvia sozinho e evita
    // o reenvio manual do atendente.
    if (this.status === 404 && /host not mapped/i.test(this.body)) return true;
    return false;
  }
}

/** Headers pra endpoints da instância (envio, status, QR, webhook). */
function authHeaders(instanceToken?: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    token: instanceToken || '',
  };
}

/** Headers pra endpoints admin (criação/listagem de instâncias). */
function adminHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    AdminToken: ADMIN_TOKEN,
  };
}

type ReqAuth =
  | { kind: 'instance'; token?: string }
  | { kind: 'admin' };

/**
 * Chamada HTTP base. Lança `UazapiError` em status != 2xx. Retorna texto cru
 * se a resposta não for JSON parseável (algumas rotas retornam string simples).
 */
async function req<T>(path: string, init: RequestInit | undefined, auth: ReqAuth): Promise<T> {
  const url = `${BASE}${path}`;
  const baseHeaders = auth.kind === 'admin' ? adminHeaders() : authHeaders(auth.token);
  const headers = { ...baseHeaders, ...(init?.headers ?? {}) };

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    throw new UazapiError(path, 0, err instanceof Error ? err.message : String(err));
  }

  const text = await res.text();
  if (!res.ok) {
    logger.warn({ path, status: res.status, body: text.slice(0, 300) }, 'uazapi request failed');
    throw new UazapiError(path, res.status, text);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────

export type UazapiStatusValue = 'connected' | 'disconnected' | 'connecting' | 'qr';

/** Objeto "instance" retornado em vários endpoints (init, status, connect, all). */
export interface UazapiInstanceObject {
  id: string;
  token: string;
  status?: string;
  name?: string;
  profileName?: string;
  profilePicUrl?: string;
  owner?: string;
  qrcode?: string;
  paircode?: string;
  systemName?: string;
  isBusiness?: boolean;
  plataform?: string;
  current_presence?: string;
  created?: string;
  updated?: string;
}

export interface UazapiInitResult {
  info?: string;
  response?: string;
  name?: string;
  /** Token específico da instância recém-criada (UUID). */
  token?: string;
  /** Objeto da instância criada — `instance.id` é o ID gerado pelo servidor. */
  instance?: UazapiInstanceObject;
  status?: { connected?: boolean; jid?: string | null; loggedIn?: boolean };
}

/** Resposta de POST /instance/connect (gera/retorna QR). */
export interface UazapiConnectResult {
  qrcode?: string;
  connected?: boolean;
  jid?: string | null;
  loggedIn?: boolean;
  response?: string;
  instance?: UazapiInstanceObject;
  status?: { connected?: boolean; jid?: string | null; loggedIn?: boolean };
}

/**
 * Resposta de /instance/status. Tem 2 shapes diferentes na natureza:
 *
 * Shape A (api.uazapi.com público):
 *   { status: 'connected'|'disconnected'|..., phone?, name?, connected? }
 *
 * Shape B (servidores dedicados como exemplo.uazapi.com):
 *   { instance: {...}, status: { connected: boolean, jid?, loggedIn?, resetting? } }
 *
 * Use `isStatusConnected(result)` para checar de forma agnóstica.
 */
export interface UazapiStatusResult {
  status?: UazapiStatusValue | string | { connected?: boolean; jid?: string; loggedIn?: boolean; resetting?: boolean };
  phone?: string;
  name?: string;
  connected?: boolean;
  instance?: Record<string, unknown>;
}

/**
 * Detecta se a instância está conectada, agnóstico ao shape da resposta.
 */
export function isStatusConnected(result: UazapiStatusResult | null | undefined): boolean {
  if (!result) return false;
  if (result.connected === true) return true;
  if (typeof result.status === 'string') {
    return result.status.toLowerCase() === 'connected';
  }
  if (result.status && typeof result.status === 'object') {
    return result.status.connected === true && result.status.loggedIn !== false;
  }
  return false;
}

/**
 * Extrai phone do shape da resposta (varia entre servidores).
 */
export function extractPhoneFromStatus(result: UazapiStatusResult | null | undefined): string | null {
  if (!result) return null;
  if (result.phone) return result.phone;
  // Shape B: status.jid = "5521999433160:4@s.whatsapp.net"
  if (result.status && typeof result.status === 'object' && result.status.jid) {
    const m = result.status.jid.match(/^(\d+)/);
    if (m) return m[1];
  }
  return null;
}

export interface UazapiSendResult {
  status?: string;
  /**
   * ID externo canônico da mensagem. A uazapi retorna esse campo como
   * `messageid` (SEM underscore) na resposta de /send/* e /message/react;
   * `sendReq` normaliza pra `message_id` — o nome que o contrato
   * `ChannelSendResult` usa e que o worker outbound persiste como `external_id`
   * (sem isso, status de entrega/leitura nunca casam → delivered fica 0%).
   */
  message_id?: string;
  error?: string;
}

/** Shape cru de /send/* e /message/react: a uazapi usa `messageid`. */
interface UazapiRawSendResponse {
  status?: string;
  messageid?: string;
  /** Alguns forks/versões podem devolver com underscore — aceitamos ambos. */
  message_id?: string;
  error?: string;
}

/**
 * Wrapper de `req` pros endpoints de envio: normaliza `messageid` (formato da
 * uazapi) → `message_id` (contrato `ChannelSendResult`). Toda função send* deve
 * usar este helper em vez de `req` direto, senão o external_id se perde.
 */
async function sendReq(
  path: string,
  init: RequestInit,
  auth: ReqAuth
): Promise<UazapiSendResult> {
  const raw = await req<UazapiRawSendResponse>(path, init, auth);
  // `req` devolve string crua se a resposta não for JSON — guard contra isso.
  if (typeof raw !== 'object' || raw === null) return {};
  return {
    status: raw.status,
    message_id: raw.messageid ?? raw.message_id,
    error: raw.error,
  };
}

// ── Instance management ───────────────────────────────────────────────────

/**
 * Cria uma instância nova. Requer AdminToken (UAZAPI_ADMIN_TOKEN env).
 *
 * Body: `{ name }` — apelido legível. O `instance.id` é gerado pelo servidor
 * (ex: `r43304bfe15460a`).
 *
 * Resposta: `{ instance: { id, token, ... }, response, name, status, token }`.
 * O `instance.token` (= `token` do nível root) é o **instance token** que
 * você usará em todas as chamadas subsequentes (envio, QR, status, delete).
 */
export async function initInstance(name: string): Promise<UazapiInitResult> {
  return req<UazapiInitResult>(
    '/instance/init',
    {
      method: 'POST',
      body: JSON.stringify({ name }),
    },
    { kind: 'admin' }
  );
}

/**
 * Lista todas as instâncias do servidor. Requer AdminToken.
 */
export async function listInstances(): Promise<UazapiInstanceObject[]> {
  return req<UazapiInstanceObject[]>(
    '/instance/all',
    { method: 'GET' },
    { kind: 'admin' }
  );
}

/**
 * Conecta a instância e gera QR Code. Requer instance token.
 * Substitui o antigo /instance/qrcode (que não existe nesse servidor).
 *
 * Resposta inclui `qrcode` (data URI) quando o pareamento começa, ou
 * `instance.status: 'connected'` se já está pareada.
 */
export async function connectInstance(instanceToken: string): Promise<UazapiConnectResult> {
  return req<UazapiConnectResult>(
    '/instance/connect',
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Status da instância. Identificada pelo token no header — não passa
 * instance_id na URL (o servidor ignora).
 */
export async function getStatus(instanceToken: string): Promise<UazapiStatusResult> {
  try {
    return await req<UazapiStatusResult>(
      '/instance/status',
      { method: 'GET' },
      { kind: 'instance', token: instanceToken }
    );
  } catch {
    return { status: 'disconnected', connected: false };
  }
}

/**
 * Desconecta E remove a instância do servidor. Requer instance token.
 * (Não existe `/instance/logout` separado nesse servidor — DELETE faz tudo.)
 */
export async function logout(instanceToken: string): Promise<void> {
  try {
    await req(
      '/instance',
      { method: 'DELETE' },
      { kind: 'instance', token: instanceToken }
    );
  } catch {
    // best-effort
  }
}

/**
 * Eventos que o CRM precisa receber.
 *   - `messages`: mensagens entrando (lead → CRM) e eco fromMe (dono pelo celular).
 *   - `messages_update`: updates de status (delivered/read/failed) + edições.
 *     Já tem handler em process-inbound.ts. Sem isso, `messages.delivered`
 *     fica false eternamente — e perdemos sinal pra detectar shadow-ban
 *     (mensagem aceita pela uazapi mas nunca entregue pelo WhatsApp).
 *
 * Instâncias EXISTENTES não recebem a mudança automaticamente — precisam ter
 * o webhook re-setado (rodar setWebhook de novo, ou via /webhook na uazapi UI).
 */
const DEFAULT_WEBHOOK_EVENTS = ['messages', 'messages_update'];

/**
 * Configura webhook da instância. Endpoint real no uazapiGO é `POST /webhook`
 * com body `{ url, enabled, events, addUrlEvents, addUrlTypesMessages, excludeMessages }`.
 *
 * Defaults intencionais:
 *   - `addUrlEvents=false`: NÃO append /event_name na URL — nosso handler é
 *     um endpoint único `/api/webhooks/whatsapp`. Se `true`, uazapi chamaria
 *     `/api/webhooks/whatsapp/messages` que dá 404 no Next.
 *   - `addUrlTypesMessages=false`: mesma lógica, evita subpath por tipo de msg.
 *   - `excludeMessages=['groups']`: nosso parser já filtra grupos no app
 *     (isGroupJid no jid.ts), mas excluir aqui economiza requests.
 */
export async function setWebhook(webhookUrl: string, instanceToken?: string): Promise<boolean> {
  try {
    await req(
      '/webhook',
      {
        method: 'POST',
        body: JSON.stringify({
          url: webhookUrl,
          enabled: true,
          events: DEFAULT_WEBHOOK_EVENTS,
          addUrlEvents: false,
          addUrlTypesMessages: false,
          excludeMessages: ['groups'],
        }),
      },
      { kind: 'instance', token: instanceToken }
    );
    return true;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, webhookUrl },
      '[uazapi] setWebhook falhou'
    );
    return false;
  }
}

// ── Messaging ─────────────────────────────────────────────────────────────

/**
 * Envia mensagem de texto via instância. `instanceToken` identifica a
 * instância — uazapi v2 NÃO leva instance_id no body.
 *
 * `delayMs`: se > 0, a uazapi mostra status "digitando..." pro destinatário
 * por esse intervalo ANTES de entregar a mensagem (presence=composing).
 * Torna o atendimento (humano ou IA) muito mais natural visualmente no
 * lado do cliente.
 */
export async function sendText(
  instanceToken: string | undefined,
  phone: string,
  message: string,
  delayMs?: number,
  /** External messageId da msg sendo CITADA (reply/quote no WhatsApp). */
  quotedExternalId?: string | null
): Promise<UazapiSendResult> {
  return sendReq(
    '/send/text',
    {
      method: 'POST',
      body: JSON.stringify({
        number: normalizePhone(phone),
        text: message,
        ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
        ...(quotedExternalId ? { replyid: quotedExternalId } : {}),
      }),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Envia imagem (URL HTTPS ou data URI base64). Caption opcional.
 * `delayMs`: mesmo significado de `sendText` — uazapi mostra status
 * "enviando foto..." antes da entrega.
 */
export async function sendImage(
  instanceToken: string | undefined,
  phone: string,
  image: string,
  caption?: string,
  delayMs?: number,
  quotedExternalId?: string | null
): Promise<UazapiSendResult> {
  return sendReq(
    '/send/media',
    {
      method: 'POST',
      body: JSON.stringify({
        number: normalizePhone(phone),
        type: 'image',
        file: image,
        ...(caption ? { text: caption } : {}),
        ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
        ...(quotedExternalId ? { replyid: quotedExternalId } : {}),
      }),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Envia vídeo (URL HTTPS ou data URI). Caption opcional.
 */
export async function sendVideo(
  instanceToken: string | undefined,
  phone: string,
  video: string,
  caption?: string,
  delayMs?: number,
  quotedExternalId?: string | null
): Promise<UazapiSendResult> {
  return sendReq(
    '/send/media',
    {
      method: 'POST',
      body: JSON.stringify({
        number: normalizePhone(phone),
        type: 'video',
        file: video,
        ...(caption ? { text: caption } : {}),
        ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
        ...(quotedExternalId ? { replyid: quotedExternalId } : {}),
      }),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Envia áudio. Por padrão `ptt=true` → mensagem de voz (push-to-talk),
 * que renderiza como balão de voz no WhatsApp. Para isso o input PRECISA
 * estar em `audio/ogg; codecs=opus` — use `audio-convert.ensureOggDataUri`
 * ANTES de chamar essa função se vier do MediaRecorder browser (webm).
 *
 * Se `ptt=false`, vai como anexo de áudio.
 *
 * `delayMs`: presence="gravando áudio..." durante o intervalo.
 */
export async function sendAudio(
  instanceToken: string | undefined,
  phone: string,
  audio: string,
  ptt = true,
  delayMs?: number
): Promise<UazapiSendResult> {
  return sendReq(
    '/send/media',
    {
      method: 'POST',
      body: JSON.stringify({
        number: normalizePhone(phone),
        type: ptt ? 'ptt' : 'audio',
        file: audio,
        ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
      }),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Envia documento. `filename` é exibido no balão de mensagem.
 */
export async function sendDocument(
  instanceToken: string | undefined,
  phone: string,
  document: string,
  filename?: string,
  delayMs?: number
): Promise<UazapiSendResult> {
  return sendReq(
    '/send/media',
    {
      method: 'POST',
      body: JSON.stringify({
        number: normalizePhone(phone),
        type: 'document',
        file: document,
        ...(filename ? { docName: filename } : {}),
        ...(delayMs && delayMs > 0 ? { delay: Math.round(delayMs) } : {}),
      }),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Detecta o tipo de mídia pelo data URI / extensão e roteia pro endpoint
 * correto. Útil quando o caller tem uma URL/dataURI sem saber o tipo.
 */
export async function sendMedia(
  instanceToken: string | undefined,
  phone: string,
  dataUriOrUrl: string,
  fileName?: string,
  caption?: string,
  delayMs?: number
): Promise<UazapiSendResult> {
  const dataMatch = dataUriOrUrl.match(/^data:([^;]+);base64,/);
  const mime = dataMatch?.[1] ?? '';

  if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp)$/i.test(dataUriOrUrl)) {
    return sendImage(instanceToken, phone, dataUriOrUrl, caption, delayMs);
  }
  if (mime.startsWith('video/') || /\.(mp4|mov|avi|mkv)$/i.test(dataUriOrUrl)) {
    return sendVideo(instanceToken, phone, dataUriOrUrl, caption, delayMs);
  }
  if (mime.startsWith('audio/') || /\.(mp3|ogg|opus|m4a|wav)$/i.test(dataUriOrUrl)) {
    return sendAudio(instanceToken, phone, dataUriOrUrl, true, delayMs);
  }
  return sendDocument(instanceToken, phone, dataUriOrUrl, fileName, delayMs);
}

/**
 * Marca mensagens como lidas (✓✓ azul).
 */
export async function markAsRead(
  instanceToken: string | undefined,
  phone: string,
  messageIds?: string[]
): Promise<void> {
  try {
    await req(
      '/message/markRead',
      {
        method: 'POST',
        body: JSON.stringify({
          number: normalizePhone(phone),
          ...(messageIds?.length ? { message_ids: messageIds } : {}),
        }),
      },
      { kind: 'instance', token: instanceToken }
    );
  } catch {
    // best-effort — não falha o fluxo se markRead der erro
  }
}

/**
 * Reage com emoji a uma mensagem. Passe `emoji=""` pra REMOVER a reação.
 * Endpoint uazapi v2: POST /message/react body { number, id, text }.
 * `text` é o emoji (1-2 chars) ou vazio pra unreact.
 */
export async function sendReaction(
  instanceToken: string | undefined,
  phone: string,
  messageId: string,
  emoji: string
): Promise<UazapiSendResult> {
  return sendReq(
    '/message/react',
    {
      method: 'POST',
      body: JSON.stringify({
        number: normalizePhone(phone),
        id: messageId,
        text: emoji,
      }),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Apaga uma mensagem (no WhatsApp dos dois lados quando for_everyone aplicável).
 * Endpoint real: POST /message/delete body { Id }.
 */
export async function deleteMessage(
  instanceToken: string | undefined,
  messageId: string
): Promise<void> {
  await req(
    '/message/delete',
    { method: 'POST', body: JSON.stringify({ Id: messageId }) },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Edita texto de uma mensagem já enviada. uazapi requer Id (capitalizado),
 * number do destinatário e o novo text.
 */
export async function editMessage(
  instanceToken: string | undefined,
  messageId: string,
  phone: string,
  newText: string
): Promise<void> {
  await req(
    '/message/edit',
    {
      method: 'POST',
      body: JSON.stringify({
        Id: messageId,
        number: normalizePhone(phone),
        text: newText,
      }),
    },
    { kind: 'instance', token: instanceToken }
  );
}

/**
 * Detalhes do contato (pushName + foto de perfil) pelo número.
 * Endpoint: POST /chat/details body { number }.
 *
 * Retorna `null` se a request falhar — caller decide o que fazer (best-effort
 * pra leads criados sem nome, sem rolar erro pro usuário).
 */
export interface UazapiChatDetails {
  id?: string;
  name?: string;
  image?: string;
  imagePreview?: string;
  lead_fullName?: string;
  lead_name?: string;
  [extra: string]: unknown;
}

export async function getChatDetails(
  instanceToken: string | undefined,
  phone: string
): Promise<UazapiChatDetails | null> {
  try {
    const data = await req<unknown>(
      '/chat/details',
      { method: 'POST', body: JSON.stringify({ number: normalizePhone(phone) }) },
      { kind: 'instance', token: instanceToken }
    );
    if (data && typeof data === 'object') return data as UazapiChatDetails;
    return null;
  } catch (err) {
    logger.warn(
      { phone, err: err instanceof Error ? err.message : err },
      '[uazapi] getChatDetails falhou'
    );
    return null;
  }
}

/**
 * Download de mídia que veio com URL inválida/criptografada via /message/download.
 * uazapi consegue decriptar mídia da CDN do WhatsApp quando passamos o messageId.
 *
 * **Param correto é `id`** — não `message_id` (que retorna 404 "Message not found").
 * A resposta vem como `{ fileURL, mimetype }` (não `url`). Mapeamos pra `url`
 * pra manter contrato estável com o caller (resolveMediaBlob).
 */
export async function downloadMessageMedia(
  instanceToken: string | undefined,
  messageId: string
): Promise<{ url?: string; base64?: string; mimetype?: string } | null> {
  try {
    const raw = await req<{ fileURL?: string; url?: string; base64?: string; mimetype?: string; cached?: boolean }>(
      '/message/download',
      {
        method: 'POST',
        body: JSON.stringify({ id: messageId }),
      },
      { kind: 'instance', token: instanceToken }
    );
    if (!raw) return null;
    return {
      url: raw.fileURL ?? raw.url,
      base64: raw.base64,
      mimetype: raw.mimetype,
    };
  } catch {
    return null;
  }
}

// ── Helpers de domínio ────────────────────────────────────────────────────

/**
 * Deriva um instance_id estável a partir de um identificador da connection
 * (ex: nome curto da empresa). Útil para criar instâncias novas com nome
 * previsível.
 *
 * O prefixo vem de `UAZAPI_INSTANCE_PREFIX` porque instâncias de clientes
 * diferentes convivem no mesmo servidor uazapi — um prefixo fixo do produto
 * colidiria entre deploys.
 */
export function instanceIdFromSlug(slug: string): string {
  const prefix = process.env.UAZAPI_INSTANCE_PREFIX ?? 'crm';
  return `${prefix}-${slug}`
    .replace(/[^a-z0-9-]/g, '-')
    .toLowerCase()
    .slice(0, 40);
}
