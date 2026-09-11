/**
 * Parser do webhook da Evolution API v2.
 *
 * A Evolution entrega o payload cru do Baileys quase intacto, então o formato
 * é o do WhatsApp Web e não uma abstração do provedor. Consequências práticas:
 *
 *   - O tipo da mensagem é a CHAVE dentro de `data.message`
 *     (`conversation`, `imageMessage`, `audioMessage`...), não um campo.
 *   - `messageTimestamp` vem em SEGUNDOS. Multiplicar por 1000 ou toda
 *     mensagem aterrissa em 1970.
 *   - A URL de mídia é `.enc` (criptografada no CDN do WhatsApp). O
 *     `isUsableMediaUrl` do parser genérico a recusa de propósito — quem
 *     resolve é o `makeEvolutionMediaResolver`, que pede o binário de volta ao
 *     servidor, que ainda tem a sessão para descriptografar.
 *   - Com `webhook.base64 = true` (que o `createInstance` configura) a mídia
 *     costuma chegar inline, e aí nem essa segunda chamada é necessária.
 *
 * Um evento da Evolution carrega UMA mensagem, diferente da Meta, que manda
 * lote. Ainda assim devolvemos array: o ingest é o mesmo dos outros canais e
 * fica mais simples com um formato único.
 */
import type { ParsedInbound, ParsedMediaType } from '../webhook-parser';
import { extractPhone, isGroupJid } from '../jid';

/** Eventos que sabemos tratar. O resto é gravado e ignorado. */
export const EVOLUTION_EVENTS = {
  MESSAGE_UPSERT: 'messages.upsert',
  MESSAGE_UPDATE: 'messages.update',
  SEND_MESSAGE: 'send.message',
  CONNECTION_UPDATE: 'connection.update',
} as const;

export interface EvolutionStatusUpdate {
  /** Id da mensagem que saiu daqui. */
  externalId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  error?: string;
  timestamp: number;
}

export interface EvolutionParsedBatch {
  /** Nome da instância que recebeu — rede de segurança de roteamento. */
  instanceName: string | null;
  event: string | null;
  messages: ParsedInbound[];
  statuses: EvolutionStatusUpdate[];
  /** Presente só em `connection.update`; alimenta o status da connection. */
  connectionState: string | null;
}

export interface EvolutionWebhookPayload {
  event?: string;
  instance?: string;
  data?: unknown;
  sender?: string;
  server_url?: string;
  date_time?: string;
}

// ────────────────────────────────────────────────────────────────────────────

export function parseEvolutionWebhook(payload: EvolutionWebhookPayload): EvolutionParsedBatch {
  const event = normalizeEvent(payload.event);
  const instanceName = typeof payload.instance === 'string' ? payload.instance : null;

  const empty: EvolutionParsedBatch = {
    instanceName,
    event,
    messages: [],
    statuses: [],
    connectionState: null,
  };

  if (!payload.data || typeof payload.data !== 'object') return empty;

  switch (event) {
    case EVOLUTION_EVENTS.MESSAGE_UPSERT:
    case EVOLUTION_EVENTS.SEND_MESSAGE: {
      // `send.message` é o eco do que NÓS enviamos. Ele entra no mesmo caminho
      // porque o `process-inbound` já descarta `fromMe` — e ter o eco parseado
      // ajuda a depurar envio sem duplicar regra de negócio aqui.
      const items = Array.isArray(payload.data) ? payload.data : [payload.data];
      const messages = items
        .map((item) => parseMessage(item as Record<string, unknown>, instanceName))
        .filter((m): m is ParsedInbound => m !== null);
      return { ...empty, messages };
    }

    case EVOLUTION_EVENTS.MESSAGE_UPDATE: {
      const items = Array.isArray(payload.data) ? payload.data : [payload.data];
      const statuses = items
        .map((item) => parseStatus(item as Record<string, unknown>))
        .filter((s): s is EvolutionStatusUpdate => s !== null);
      return { ...empty, statuses };
    }

    case EVOLUTION_EVENTS.CONNECTION_UPDATE: {
      const d = payload.data as Record<string, unknown>;
      const state = typeof d.state === 'string' ? d.state : null;
      return { ...empty, connectionState: state };
    }

    default:
      return empty;
  }
}

/** A Evolution manda `messages.upsert` ou `MESSAGES_UPSERT` conforme a config. */
function normalizeEvent(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return raw.toLowerCase().replace(/_/g, '.');
}

// ────────────────────────────────────────────────────────────────────────────
// Mensagem
// ────────────────────────────────────────────────────────────────────────────

function parseMessage(
  data: Record<string, unknown>,
  instanceName: string | null
): ParsedInbound | null {
  const key = data.key as Record<string, unknown> | undefined;
  if (!key) return null;

  const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : null;
  if (!remoteJid) return null;

  const externalId = typeof key.id === 'string' ? key.id : null;
  const fromMe = key.fromMe === true;

  const message = (data.message ?? {}) as Record<string, unknown>;
  const { mediaType, content, fileName, mimeType, mediaUrl } = extractBody(message, data);

  return {
    externalId,
    contactPhone: extractPhone(remoteJid),
    contactJid: remoteJid,
    isGroup: isGroupJid(remoteJid),
    fromMe,
    pushName: typeof data.pushName === 'string' ? data.pushName : null,
    profilePic: typeof data.profilePicUrl === 'string' ? data.profilePicUrl : null,
    mediaType,
    content,
    fileName,
    mimeType,
    mediaUrl,
    mediaBase64: extractBase64(message, data),
    quoted: extractQuoted(message),
    timestamp: extractTimestamp(data),
    instanceName,
    senderName: typeof data.pushName === 'string' ? data.pushName : null,
    // A Evolution não expõe media id próprio — o download é pela key da
    // mensagem, feito no resolver do provider.
    providerMediaId: null,
    // Click-to-WhatsApp só existe no canal oficial da Meta.
    adReferral: null,
  };
}

/**
 * O tipo da mensagem é a chave presente em `data.message`. A ordem importa:
 * `extendedTextMessage` precisa ser testado antes de `conversation` porque
 * uma resposta citada traz os dois, e só o primeiro tem o contexto do quote.
 */
function extractBody(
  message: Record<string, unknown>,
  data: Record<string, unknown>
): {
  mediaType: ParsedMediaType;
  content: string | null;
  fileName: string | null;
  mimeType: string | null;
  mediaUrl: string | null;
} {
  const ext = message.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === 'string') {
    return { mediaType: 'text', content: ext.text, fileName: null, mimeType: null, mediaUrl: null };
  }

  if (typeof message.conversation === 'string') {
    return {
      mediaType: 'text',
      content: message.conversation,
      fileName: null,
      mimeType: null,
      mediaUrl: null,
    };
  }

  const media = [
    ['imageMessage', 'image'],
    ['videoMessage', 'video'],
    ['audioMessage', 'audio'],
    ['documentMessage', 'document'],
    ['stickerMessage', 'sticker'],
  ] as const;

  for (const [field, type] of media) {
    const m = message[field] as Record<string, unknown> | undefined;
    if (!m) continue;
    return {
      mediaType: type,
      content: typeof m.caption === 'string' ? m.caption : null,
      fileName:
        typeof m.fileName === 'string'
          ? m.fileName
          : typeof m.title === 'string'
            ? m.title
            : null,
      mimeType: typeof m.mimetype === 'string' ? m.mimetype : null,
      mediaUrl: typeof m.url === 'string' ? m.url : null,
    };
  }

  // `documentWithCaptionMessage` embrulha um documentMessage — desembrulha e
  // reprocessa, senão um PDF com legenda chega como 'unknown'.
  const wrapped = message.documentWithCaptionMessage as Record<string, unknown> | undefined;
  if (wrapped?.message) {
    return extractBody(wrapped.message as Record<string, unknown>, data);
  }

  const loc = message.locationMessage as Record<string, unknown> | undefined;
  if (loc) {
    const lat = loc.degreesLatitude;
    const lng = loc.degreesLongitude;
    return {
      mediaType: 'location',
      content: typeof lat === 'number' && typeof lng === 'number' ? `${lat},${lng}` : null,
      fileName: null,
      mimeType: null,
      mediaUrl: null,
    };
  }

  return { mediaType: 'unknown', content: null, fileName: null, mimeType: null, mediaUrl: null };
}

/**
 * Base64 da mídia, quando o webhook está configurado para mandar inline.
 * A v2 já colocou esse campo em dois lugares conforme a versão — aceitamos os
 * dois, porque a alternativa é o download deixar de funcionar num upgrade.
 */
function extractBase64(
  message: Record<string, unknown>,
  data: Record<string, unknown>
): string | null {
  if (typeof message.base64 === 'string' && message.base64) return message.base64;
  if (typeof data.base64 === 'string' && data.base64) return data.base64;
  return null;
}

/**
 * Quote: `contextInfo.stanzaId` é o id da mensagem citada. O texto vem em
 * `quotedMessage`, que tem a mesma forma de uma mensagem — reaproveitamos o
 * `extractBody` em vez de reimplementar a árvore de tipos.
 */
function extractQuoted(message: Record<string, unknown>): { id: string; content: string } | null {
  const ctx =
    (message.extendedTextMessage as Record<string, unknown> | undefined)?.contextInfo ??
    (message.imageMessage as Record<string, unknown> | undefined)?.contextInfo ??
    (message.videoMessage as Record<string, unknown> | undefined)?.contextInfo ??
    (message.audioMessage as Record<string, unknown> | undefined)?.contextInfo ??
    (message.documentMessage as Record<string, unknown> | undefined)?.contextInfo;

  if (!ctx || typeof ctx !== 'object') return null;
  const c = ctx as Record<string, unknown>;
  const id = typeof c.stanzaId === 'string' ? c.stanzaId : null;
  if (!id) return null;

  const quotedMessage = c.quotedMessage as Record<string, unknown> | undefined;
  const body = quotedMessage ? extractBody(quotedMessage, {}) : null;

  return { id, content: body?.content ?? '' };
}

/** `messageTimestamp` vem em segundos; o CRM trabalha em ms. */
function extractTimestamp(data: Record<string, unknown>): number {
  const raw = data.messageTimestamp;
  const secs =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string'
        ? Number.parseInt(raw, 10)
        : Number.NaN;

  if (!Number.isFinite(secs) || secs <= 0) return Date.now();
  // Defesa contra a Evolution já mandar em ms num upgrade futuro: um timestamp
  // em segundos nunca passa de ~1e10 nas próximas décadas.
  return secs > 1e11 ? secs : secs * 1000;
}

// ────────────────────────────────────────────────────────────────────────────
// Status
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mapeia os ACKs do Baileys para o vocabulário do CRM.
 *
 * `PLAYED` (áudio ouvido) colapsa em `read`: para o atendente, ouvir é ter
 * lido, e o CRM não tem estado separado para isso.
 */
function mapStatus(raw: string): EvolutionStatusUpdate['status'] | null {
  switch (raw.toUpperCase()) {
    case 'PENDING':
      return null; // ainda não saiu — nada a atualizar
    case 'SERVER_ACK':
    case 'SENT':
      return 'sent';
    case 'DELIVERY_ACK':
    case 'DELIVERED':
      return 'delivered';
    case 'READ':
    case 'PLAYED':
      return 'read';
    case 'ERROR':
    case 'FAILED':
      return 'failed';
    default:
      return null;
  }
}

function parseStatus(data: Record<string, unknown>): EvolutionStatusUpdate | null {
  const key = data.key as Record<string, unknown> | undefined;
  const externalId =
    typeof data.keyId === 'string'
      ? data.keyId
      : typeof key?.id === 'string'
        ? key.id
        : null;

  if (!externalId) return null;

  const rawStatus = typeof data.status === 'string' ? data.status : null;
  if (!rawStatus) return null;

  const status = mapStatus(rawStatus);
  if (!status) return null;

  return {
    externalId,
    status,
    ...(status === 'failed' ? { error: `Evolution reportou ${rawStatus}` } : {}),
    timestamp: extractTimestamp(data),
  };
}

/**
 * Chave de deduplicação do evento.
 *
 * Formato `<provider>:<tipo>:<id do provedor>`, como manda o schema de
 * webhook_events. Sem id do provedor (connection.update, por exemplo) o
 * caller cai no hash do corpo.
 */
export function buildEvolutionEventKey(
  connectionId: string,
  parsed: EvolutionParsedBatch
): string | null {
  const first = parsed.messages[0]?.externalId ?? parsed.statuses[0]?.externalId ?? null;
  if (!first) return null;
  const kind = parsed.messages.length > 0 ? 'msg' : 'status';
  return `evolution:${connectionId}:${kind}:${first}`;
}
