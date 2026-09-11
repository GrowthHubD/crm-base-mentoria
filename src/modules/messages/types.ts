import type { MessageReaction } from '@/lib/db/schema/messages';
export type { MessageReaction };

export type MessageDirection = 'inbound' | 'outbound';
export type MessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'button_reply'
  | 'list_reply'
  | 'system';
export type MessageSender = 'lead' | 'human' | 'ai' | 'owner';
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  externalId?: string | null;
  leadId: string;
  direction: MessageDirection;
  type: MessageType;
  sender: MessageSender;
  sentById?: string | null;

  // Conteúdo
  body?: string | null;
  mediaUrl?: string | null;
  mediaCaption?: string | null;
  mimeType?: string | null;
  fileName?: string | null;

  // Quote (resposta a mensagem específica)
  quotedMessageId?: string | null;
  quotedContent?: string | null;

  // Sender name (útil em grupos)
  senderName?: string | null;

  // Cargo do user que enviou (computado via join no GET — não persistido).
  // Usado pra montar "Atendente Carlos" / "Gerente Gabriel" na exibição.
  senderRole?: 'admin' | 'attendant' | null;

  // Status
  status: MessageStatus;
  delivered: boolean;
  read: boolean;
  failedReason?: string | null;

  // User actions
  isStarred: boolean;

  // Reactions
  reactions?: MessageReaction[] | null;

  // Embedding RAG
  embedding?: number[] | null;

  metadata?: Record<string, unknown> | null;
  timestamp: Date;
  createdAt: Date;
}

export interface SendMessageInput {
  leadId: string;
  type: MessageType;
  body?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  mimeType?: string;
  fileName?: string;
  quotedMessageId?: string;
  sentById?: string;
}

/**
 * Payload completo do webhook uazapi v2 (estrutura observada em produção).
 * Inclui campos legacy do v1 também pra retrocompatibilidade.
 */
export interface UazapiV2WebhookPayload {
  BaseUrl?: string;
  EventType?: string; // 'messages' | 'messages_update' | 'connection' | 'qr'
  instanceName?: string;
  owner?: string;
  token?: string;
  chat?: {
    id?: string;
    name?: string;
    owner?: string;
    phone?: string;
    imagePreview?: string;
    wa_chatid?: string;
    wa_chatlid?: string;
    wa_contactName?: string;
    wa_isGroup?: boolean;
    wa_name?: string;
  };
  chatSource?: string;
  message?: {
    id?: string;
    messageid?: string;
    chatid?: string;
    fromMe?: boolean;
    isGroup?: boolean;
    messageType?: string;
    type?: string;
    mediaType?: string;
    messageTimestamp?: number; // ms
    sender?: string;
    senderName?: string;
    source?: string;
    pushName?: string;
    text?: string;
    caption?: string;
    content?: { text?: string; caption?: string };
    // Mídia — Uazapi v2 varia o nome
    mediaUrl?: string;
    fileURL?: string;
    fileurl?: string;
    url?: string;
    downloadUrl?: string;
    file?: string;
    mimetype?: string;
    mediaMime?: string;
    fileName?: string;
    filename?: string;
    // Base64 (caso webhook configurado pra mandar inline)
    base64?: string;
    mediaBase64?: string;
    fileBase64?: string;
    // Quote
    quoted?: { id?: string; content?: string };
    // Reaction (variantes que a uazapi pode mandar — heurística, ajustar com payload real)
    reactionMessage?: { text?: string; key?: { id?: string } };
    reaction?: { text?: string; messageid?: string; id?: string };
    reactionFor?: string;
    // Catálogo / interativos do WhatsApp Business — payload exato varia.
    // Capturamos best-effort: header/body/footer + product names quando vierem.
    interactiveMessage?: {
      header?: { title?: string; subtitle?: string; text?: string };
      body?: { text?: string };
      footer?: { text?: string };
      title?: string;
      text?: string;
    };
    orderMessage?: {
      orderTitle?: string;
      message?: string;
      total?: number | string;
      totalAmount1000?: number;
      currency?: string;
      itemCount?: number;
      items?: Array<{ name?: string; quantity?: number; price?: number | string }>;
    };
    productMessage?: {
      product?: { title?: string; description?: string; priceAmount1000?: number; currencyCode?: string };
      title?: string;
      description?: string;
    };
    listMessage?: { title?: string; description?: string; buttonText?: string };
    templateMessage?: { title?: string; text?: string };
  };
}

/**
 * Versão simplificada (legacy) — mantida pra compat com webhook v1
 */
export interface InboundWebhookPayload {
  instance: string;
  event: string;
  data: {
    id: string;
    from: string;
    body?: string;
    type: string;
    timestamp: number;
    pushName?: string;
    mediaUrl?: string;
  };
}
