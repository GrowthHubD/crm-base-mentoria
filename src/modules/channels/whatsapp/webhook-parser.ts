/**
 * Parser do webhook v2 da uazapi.
 *
 * O payload v2 real DIVERGE da doc oficial em vários pontos:
 *   - Aceita variações de nome para mídia (mediaUrl | fileURL | fileurl | url | downloadUrl | file)
 *   - mediaType pode estar em `mediaType` OU `messageType` OU `type`
 *   - "ptt" (push-to-talk) é normalizado para "audio"
 *   - text pode estar em `message.text`, `message.content.text` ou `message.caption`
 *   - JID do contato vem em `chat.wa_chatid` ou `message.chatid` (formato `5511...@s.whatsapp.net`)
 *
 * Ref: crm_parceria_lagos/src/app/api/webhooks/uazapi/v2/route.ts (625L)
 */
import { extractPhone, isGroupJid } from './jid';
import type { UazapiV2WebhookPayload } from '@/modules/messages/types';

export type ParsedMediaType = 'text' | 'image' | 'video' | 'audio' | 'document' | 'sticker' | 'location' | 'unknown';

export interface ParsedInbound {
  /** ID externo da mensagem para idempotência */
  externalId: string | null;
  /** Telefone do contato em dígitos puros (sem JID) */
  contactPhone: string;
  /** JID original (útil pra detectar grupo) */
  contactJid: string | null;
  /** É grupo? (mensagens de grupo devem ser ignoradas no fluxo de leads) */
  isGroup: boolean;
  /** É mensagem nossa (fromMe)? — também ignoramos no inbound */
  fromMe: boolean;
  /** Nome do contato exibido no WhatsApp */
  pushName: string | null;
  /** Foto de perfil (preview) */
  profilePic: string | null;
  /** Tipo da mensagem normalizado */
  mediaType: ParsedMediaType;
  /** Texto da mensagem ou caption da mídia */
  content: string | null;
  /** Nome do arquivo (documento) */
  fileName: string | null;
  /** Mime type da mídia */
  mimeType: string | null;
  /** URL de mídia HTTPS — pode estar criptografada/inválida; validar com isUsableMediaUrl */
  mediaUrl: string | null;
  /** Mídia em base64 (caso webhook configurado pra mandar inline) */
  mediaBase64: string | null;
  /** Quote de mensagem anterior */
  quoted: { id: string; content: string } | null;
  /** Timestamp em ms */
  timestamp: number;
  /** instanceName que recebeu — usar pra lookup de connection no service layer */
  instanceName: string | null;
  /** Sender display name (útil em grupos, geralmente == pushName) */
  senderName: string | null;
  /**
   * Id da midia no provedor, quando o webhook nao traz a midia em si.
   * A Cloud API da Meta manda so este id — quem resolve e o `resolveMedia`
   * passado ao ingest. A uazapi nao usa.
   */
  providerMediaId?: string | null;
  /**
   * Origem do lead quando a conversa NASCEU de um clique em anúncio
   * (Click-to-WhatsApp). A Meta anexa isto na primeira mensagem, e só nela.
   *
   * É a atribuição do lead — de qual anúncio ele veio, com que headline. Para
   * quem vende tráfego essa é a informação mais valiosa da mensagem, e ela
   * chega uma vez: se não for capturada aqui, não há como recuperar depois
   * perguntando à Meta.
   *
   * `null` em conversa iniciada organicamente. A uazapi não tem equivalente.
   */
  adReferral?: AdReferral | null;
}

/** Atribuição de anúncio (Click-to-WhatsApp) — campos que a Meta envia. */
export interface AdReferral {
  /** Id do anúncio. É por ele que se cruza com o gerenciador de anúncios. */
  sourceId: string | null;
  /** `ad` | `post` — de onde veio o clique. */
  sourceType: string | null;
  /** URL do anúncio/post. */
  sourceUrl: string | null;
  /** Headline e corpo do criativo, como a pessoa viu antes de clicar. */
  headline: string | null;
  body: string | null;
  /** Id do criativo no Meta Ads (`ctwa_clid`), útil para conversão offline. */
  ctwaClid: string | null;
}

/**
 * Detecta se a URL de mídia é utilizável (não é placeholder, não é .enc CDN).
 * Quando inválida, o caller deve chamar `downloadMessageMedia(externalId)` da uazapi.
 */
export function isUsableMediaUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\.enc(\?|$)/i.test(url)) return false; // CDN criptografada
  if (/mmg\.whatsapp\.net/i.test(url)) return false; // raw WA CDN
  if (/^https?:\/\/web\.whatsapp\.net\/?$/i.test(url)) return false; // placeholder
  return true;
}

/**
 * Normaliza mediaType bruto pra valor canônico do sistema.
 * "ptt" (audio voice) → "audio". Tudo desconhecido → "unknown".
 */
export function normalizeMediaType(raw: string | undefined | null): ParsedMediaType {
  if (!raw) return 'text';
  const m = raw.toLowerCase();
  if (m === 'text' || m === 'conversation' || m === 'extendedtextmessage') return 'text';
  if (m === 'image' || m === 'imagemessage') return 'image';
  if (m === 'video' || m === 'videomessage') return 'video';
  if (m === 'audio' || m === 'ptt' || m === 'audiomessage' || m === 'voice') return 'audio';
  if (m === 'document' || m === 'documentmessage') return 'document';
  if (m === 'sticker' || m === 'stickermessage') return 'sticker';
  if (m === 'location' || m === 'locationmessage') return 'location';
  // Mensagens interativas / catálogo do WhatsApp Business — fallback pra
  // 'text' pra entrar no fluxo normal de exibição. O conteúdo é montado em
  // formatBusinessCatalog (texto markdown com header + body + produtos).
  if (
    m.includes('interactive') ||
    m.includes('order') ||
    m.includes('product') ||
    m.includes('list') ||
    m.includes('template') ||
    m.includes('catalog')
  ) {
    return 'text';
  }
  return 'unknown';
}

/**
 * Extrai texto legível de payloads "interactivos" do WhatsApp Business
 * (catálogo, ordem, lista, template). Sem amostra estável da uazapi, é
 * heurística — pesca todos os campos de texto conhecidos e monta um
 * markdown que o atendente lê no CRM.
 *
 * Retorna `null` se nada útil foi encontrado.
 */
export function formatBusinessCatalog(message: UazapiV2WebhookPayload['message']): string | null {
  if (!message) return null;
  const out: string[] = [];

  const tag = (() => {
    const t = (message.messageType ?? message.mediaType ?? message.type ?? '').toLowerCase();
    if (t.includes('order')) return '🛒 Pedido do catálogo';
    if (t.includes('product')) return '🛍️ Produto compartilhado';
    if (t.includes('list')) return '📋 Lista enviada';
    if (t.includes('template')) return '📨 Mensagem template';
    if (t.includes('catalog')) return '📦 Catálogo enviado';
    if (t.includes('interactive')) return '✨ Mensagem interativa';
    return '📦 Mensagem do WhatsApp Business';
  })();
  out.push(`*${tag}*`);

  const im = message.interactiveMessage;
  if (im) {
    if (im.header?.title || im.header?.text) out.push(`_${im.header.title ?? im.header.text}_`);
    if (im.title) out.push(`_${im.title}_`);
    if (im.body?.text) out.push(im.body.text);
    if (im.text) out.push(im.text);
    if (im.footer?.text) out.push(`(${im.footer.text})`);
  }

  const om = message.orderMessage;
  if (om) {
    if (om.orderTitle) out.push(`_${om.orderTitle}_`);
    if (om.message) out.push(om.message);
    if (om.items && om.items.length > 0) {
      out.push('');
      for (const it of om.items) {
        const qty = it.quantity ? `${it.quantity}x ` : '';
        const name = it.name ?? 'Item';
        out.push(`• ${qty}${name}`);
      }
    }
    if (om.itemCount) out.push(`Total: ${om.itemCount} ite${om.itemCount === 1 ? 'm' : 'ns'}`);
  }

  const pm = message.productMessage;
  if (pm) {
    const name = pm.product?.title ?? pm.title;
    const desc = pm.product?.description ?? pm.description;
    if (name) out.push(`_${name}_`);
    if (desc) out.push(desc);
  }

  const lm = message.listMessage;
  if (lm) {
    if (lm.title) out.push(`_${lm.title}_`);
    if (lm.description) out.push(lm.description);
  }

  const tm = message.templateMessage;
  if (tm) {
    if (tm.title) out.push(`_${tm.title}_`);
    if (tm.text) out.push(tm.text);
  }

  // Fallback genérico: pesca text/caption/content
  if (out.length === 1) {
    const fallback = message.text ?? message.caption ?? message.content?.text ?? message.content?.caption;
    if (fallback) out.push(fallback);
  }

  // Se só tem o tag e nada mais útil, retorna null — caller decide se persiste.
  return out.length > 1 ? out.join('\n') : null;
}

/**
 * Filtra placeholders de tipo (uazapi às vezes manda "audio", "image", "ptt"
 * literal como `text` em mensagens de mídia em vez de null/caption real).
 * Esses valores não são texto que o cliente digitou — são metadados crus.
 */
function stripMediaPlaceholder(s: string | null): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^(audio|image|video|sticker|ptt|voice|document)$/i.test(trimmed)) return null;
  return s;
}

/**
 * Normaliza o message id da uazapi para a forma "pelada" (só o msgid do
 * WhatsApp), removendo o prefixo `<número>:` que os WEBHOOKS acrescentam.
 *
 * A uazapi identifica a MESMA mensagem por dois formatos:
 *   - retorno do `/send/*`                    → `3EB0BFA341096B59341F0C`               (pelado)
 *   - webhook (eco fromMe / delivered / read) → `555181355958:3EB0BFA341096B59341F0C`  (prefixado)
 *
 * Sem normalizar, o `external_id` gravado no envio nunca casa com o do webhook,
 * o que (a) trava o status de entrega em `sent` e (b) fura o dedup do eco
 * fromMe — duplicando a mensagem no CRM (uma como CRM/IA, outra como "Celular").
 * Normalizamos TUDO pro formato pelado, nos dois lados. Msgids do WhatsApp não
 * contêm `:`, então cortar após o último `:` é seguro; ids já pelados passam
 * intactos.
 */
export function normalizeWaMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = String(id).trim();
  if (!trimmed) return null;
  const colon = trimmed.lastIndexOf(':');
  if (colon >= 0 && colon < trimmed.length - 1) return trimmed.slice(colon + 1);
  return trimmed;
}

/**
 * Normaliza mime type para valor compatível com WhatsApp/Storage.
 * - audio/opus → audio/ogg (uazapi às vezes manda opus puro)
 * - audio/mp4 (m4a) é mantido
 */
export function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m === 'audio/opus') return 'audio/ogg';
  return m;
}

/**
 * Converte payload v2 da uazapi para `ParsedInbound`. Robusto contra variações:
 * tenta múltiplos campos antes de desistir.
 */
export function parseV2Webhook(payload: UazapiV2WebhookPayload): ParsedInbound | null {
  if (!payload?.message) return null;

  const message = payload.message;
  const chat = payload.chat ?? {};

  const externalId = normalizeWaMessageId(message.id ?? message.messageid);
  const contactJid = chat.wa_chatid ?? message.chatid ?? null;
  const contactPhone = contactJid ? extractPhone(contactJid) : '';

  if (!contactPhone) return null;

  const isGroup =
    chat.wa_isGroup === true ||
    message.isGroup === true ||
    (contactJid ? isGroupJid(contactJid) : false);

  const fromMe = message.fromMe === true;

  const rawType = message.mediaType ?? message.messageType ?? message.type ?? 'text';
  const mediaType = normalizeMediaType(rawType);

  // Catálogo / interativos do WhatsApp Business: o normalizeMediaType acima
  // mapeia esses tipos pra 'text', então caímos no fluxo normal de body.
  // Mas a info útil está espalhada em interactiveMessage/orderMessage/etc.
  // formatBusinessCatalog monta um texto legível com tudo o que achar.
  const businessText = (() => {
    const t = String(rawType).toLowerCase();
    if (
      t.includes('interactive') ||
      t.includes('order') ||
      t.includes('product') ||
      t.includes('list') ||
      t.includes('template') ||
      t.includes('catalog')
    ) {
      return formatBusinessCatalog(message);
    }
    return null;
  })();

  // Texto/caption — uazapi às vezes manda `text="audio"` (ou "image", "ptt"…)
  // como metadado literal em mensagens de mídia. Pra mediaType !== 'text'
  // priorizamos caption real; se cair em text, filtramos esses placeholders
  // pra não poluir o body do CRM com "audio" cru.
  const rawTextOrCaption = (() => {
    if (businessText) return businessText;
    if (mediaType === 'text') {
      return message.text ?? message.content?.text ?? null;
    }
    return (
      message.caption ??
      message.content?.caption ??
      message.text ??
      message.content?.text ??
      null
    );
  })();
  const content = stripMediaPlaceholder(rawTextOrCaption);

  // Mídia URL — uazapi v2 varia o nome do campo
  const mediaUrl =
    message.mediaUrl ??
    message.fileURL ??
    message.fileurl ??
    message.url ??
    message.downloadUrl ??
    message.file ??
    null;

  const mediaBase64 = message.base64 ?? message.mediaBase64 ?? message.fileBase64 ?? null;
  const mimeType = normalizeMime(message.mimetype ?? message.mediaMime);
  const fileName = message.fileName ?? message.filename ?? null;

  const quoted = message.quoted?.id
    ? { id: message.quoted.id, content: message.quoted.content ?? '' }
    : null;

  const timestamp = message.messageTimestamp ?? Date.now();

  return {
    externalId,
    contactPhone,
    contactJid,
    isGroup,
    fromMe,
    // pushName: ordem das chaves segue o que o uazapi v2 já mandou na prática
    // (wa_contactName geralmente vem; wa_name é fallback comum; chat.name é
    // legado; senderName e pushName cobrem variantes do v2).
    pushName:
      chat.wa_contactName ??
      chat.wa_name ??
      chat.name ??
      message.pushName ??
      message.senderName ??
      null,
    profilePic: chat.imagePreview ?? null,
    mediaType,
    content,
    fileName,
    mimeType,
    mediaUrl,
    mediaBase64,
    quoted,
    timestamp,
    instanceName: payload.instanceName ?? null,
    senderName: message.senderName ?? null,
  };
}

/**
 * Detecta o tipo de evento do webhook v2.
 * - "messages" → mensagem nova (chamar parseV2Webhook)
 * - "messages_update" → atualização de status (delivered/read)
 * - "connection" → status da instância mudou
 * - "qr" → QR code novo
 */
export type V2EventType = 'messages' | 'messages_update' | 'connection' | 'qr' | 'unknown';

export function detectEventType(payload: UazapiV2WebhookPayload): V2EventType {
  const e = payload.EventType?.toLowerCase();
  if (e === 'messages' || e === 'messages_update' || e === 'connection' || e === 'qr') return e;
  // Fallback: se tem `message`, assume "messages"
  if (payload.message) return 'messages';
  return 'unknown';
}
