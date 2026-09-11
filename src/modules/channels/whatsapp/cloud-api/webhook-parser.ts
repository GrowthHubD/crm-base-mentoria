/**
 * Parser do webhook da WhatsApp Cloud API (Meta).
 *
 * Produz o MESMO `ParsedInbound` que o parser da uazapi produz — é isso que
 * permite os dois canais entrarem no mesmo `ingestParsedInbound` e o resto do
 * CRM (lead, pipeline, chat, automações) não saber de qual provedor veio.
 *
 * Diferenças estruturais do payload oficial que o parser normaliza:
 *   - o telefone vem em `wa_id` (dígitos, sem JID) — montamos o JID só pra
 *     manter o formato que o resto do sistema já exibe;
 *   - mídia não traz URL: traz `id`, que exige duas chamadas autenticadas.
 *     O id vai em `providerMediaId` e quem resolve é o ingest;
 *   - `timestamp` vem em SEGUNDOS (string), não milissegundos;
 *   - não existe eco de mensagem própria (`fromMe`) nem mensagem de grupo:
 *     a Cloud API simplesmente não entrega nenhum dos dois;
 *   - status de entrega vem num array irmão (`statuses`), não num evento
 *     separado como na uazapi.
 */
import type { ParsedInbound, ParsedMediaType } from '../webhook-parser';

export interface MetaStatusUpdate {
  /** wamid da mensagem que saiu daqui. */
  externalId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  /** Só em falha: o motivo já legível. */
  error?: string;
  timestamp: number;
}

export interface ParsedMetaWebhook {
  /** phone_number_id que recebeu — identifica a connection. */
  phoneNumberId: string | null;
  messages: ParsedInbound[];
  statuses: MetaStatusUpdate[];
}

interface MetaMediaObject {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
}

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  image?: MetaMediaObject;
  video?: MetaMediaObject;
  audio?: MetaMediaObject;
  document?: MetaMediaObject;
  sticker?: MetaMediaObject;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string; payload?: string };
  interactive?: {
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
  };
  reaction?: { message_id?: string; emoji?: string };
  context?: { id?: string; from?: string };
  /** Anexado pela Meta quando a conversa nasce de um clique em anuncio. */
  referral?: {
    source_url?: string;
    source_id?: string;
    source_type?: string;
    headline?: string;
    body?: string;
    ctwa_clid?: string;
  };
  errors?: Array<{ code?: number; title?: string; message?: string }>;
}

interface MetaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: Array<{ profile?: { name?: string }; wa_id?: string }>;
  messages?: MetaMessage[];
  statuses?: Array<{
    id?: string;
    status?: string;
    timestamp?: string;
    recipient_id?: string;
    errors?: Array<{ code?: number; title?: string; message?: string }>;
  }>;
}

export interface MetaWebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: MetaChangeValue }> }>;
}

const MEDIA_KEYS = ['image', 'video', 'audio', 'document', 'sticker'] as const;

function toMediaType(type: string | undefined): ParsedMediaType {
  switch (type) {
    case 'text':
      return 'text';
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'document':
      return 'document';
    case 'sticker':
      return 'sticker';
    case 'location':
      return 'location';
    default:
      // button, interactive, reaction, order, system, unsupported...
      return 'unknown';
  }
}

/**
 * Texto que representa a mensagem no chat e nas prévias do kanban.
 * Botões e listas viram o texto que a pessoa efetivamente tocou — para o
 * atendente é isso que importa, não o payload interno.
 */
function extractContent(msg: MetaMessage): string | null {
  if (msg.text?.body) return msg.text.body;
  if (msg.interactive?.button_reply?.title) return msg.interactive.button_reply.title;
  if (msg.interactive?.list_reply?.title) return msg.interactive.list_reply.title;
  if (msg.button?.text) return msg.button.text;
  if (msg.reaction?.emoji) return msg.reaction.emoji;
  if (msg.location) {
    const { name, address, latitude, longitude } = msg.location;
    return name || address || `📍 ${latitude}, ${longitude}`;
  }
  for (const key of MEDIA_KEYS) {
    const media = msg[key];
    if (media?.caption) return media.caption;
  }
  if (msg.errors?.length) {
    const e = msg.errors[0];
    return `[mensagem não suportada: ${e.title ?? e.message ?? e.code}]`;
  }
  return null;
}

function mediaObject(msg: MetaMessage): MetaMediaObject | null {
  for (const key of MEDIA_KEYS) {
    const media = msg[key];
    if (media) return media;
  }
  return null;
}

function parseMessage(
  msg: MetaMessage,
  value: MetaChangeValue,
  contactName: string | null
): ParsedInbound | null {
  if (!msg.from) return null;

  const media = mediaObject(msg);
  const phone = msg.from.replace(/\D/g, '');

  return {
    externalId: msg.id ?? null,
    contactPhone: phone,
    contactJid: `${phone}@s.whatsapp.net`,
    // A Cloud API não entrega mensagem de grupo nem eco do que nós mandamos.
    isGroup: false,
    fromMe: false,
    pushName: contactName,
    profilePic: null,
    mediaType: toMediaType(msg.type),
    content: extractContent(msg),
    fileName: media?.filename ?? null,
    mimeType: media?.mime_type ?? null,
    // Mídia oficial não tem URL no webhook: só `id`, resolvido depois.
    mediaUrl: null,
    mediaBase64: null,
    quoted: msg.context?.id ? { id: msg.context.id, content: '' } : null,
    timestamp: msg.timestamp ? Number(msg.timestamp) * 1000 : Date.now(),
    // Atribuicao do anuncio. So vem na PRIMEIRA mensagem da conversa, e so
    // uma vez — nao da pra pedir de novo depois. Antes era descartada aqui:
    // o lead entrava no CRM sem ninguem saber de qual anuncio ele veio, que
    // e justamente o que o cliente compra.
    adReferral: msg.referral
      ? {
          sourceId: msg.referral.source_id ?? null,
          sourceType: msg.referral.source_type ?? null,
          sourceUrl: msg.referral.source_url ?? null,
          headline: msg.referral.headline ?? null,
          body: msg.referral.body ?? null,
          ctwaClid: msg.referral.ctwa_clid ?? null,
        }
      : null,
    instanceName: value.metadata?.phone_number_id ?? null,
    senderName: contactName,
    providerMediaId: media?.id ?? null,
  };
}

function parseStatus(
  row: NonNullable<MetaChangeValue['statuses']>[number]
): MetaStatusUpdate | null {
  if (!row.id || !row.status) return null;
  const status = row.status.toLowerCase();
  if (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed') {
    return null;
  }
  const err = row.errors?.[0];
  return {
    externalId: row.id,
    status,
    error: err ? err.message ?? err.title ?? `código ${err.code}` : undefined,
    timestamp: row.timestamp ? Number(row.timestamp) * 1000 : Date.now(),
  };
}

/**
 * Um POST da Meta pode carregar várias entries, cada uma com vários changes,
 * cada um com várias mensagens e status. Achatamos tudo — o caller trata cada
 * item de forma idempotente, então lote não é problema.
 */
export function parseMetaWebhook(payload: MetaWebhookPayload): ParsedMetaWebhook {
  const messages: ParsedInbound[] = [];
  const statuses: MetaStatusUpdate[] = [];
  let phoneNumberId: string | null = null;

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      phoneNumberId = value.metadata?.phone_number_id ?? phoneNumberId;

      // O nome do contato vem uma vez por change, fora do array de mensagens.
      const contactName = value.contacts?.[0]?.profile?.name?.trim() || null;

      for (const msg of value.messages ?? []) {
        const parsed = parseMessage(msg, value, contactName);
        if (parsed) messages.push(parsed);
      }

      for (const row of value.statuses ?? []) {
        const parsed = parseStatus(row);
        if (parsed) statuses.push(parsed);
      }
    }
  }

  return { phoneNumberId, messages, statuses };
}
