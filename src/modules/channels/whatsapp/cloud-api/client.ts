/**
 * Cliente da WhatsApp Cloud API (Meta) — o canal OFICIAL.
 *
 * Diferenças que importam em relação à uazapi (o não-oficial), porque elas
 * mudam o que o CRM pode prometer ao atendente:
 *
 * - **Janela de 24h.** Fora dela só sai template aprovado; texto livre volta
 *   com o código 131047. O erro é traduzido aqui pra uma frase legível, senão
 *   o atendente vê "falhou" e não entende por quê.
 * - **Não existe "digitando..."** nem apagar nem editar mensagem enviada. O
 *   `delayMs` que o resto do sistema calcula é ignorado (o adapter apenas não
 *   o usa) — não há como simular digitação no canal oficial.
 * - **Mídia recebida não vem por URL pública**: o webhook traz um `media_id`,
 *   que precisa de duas chamadas autenticadas (pegar a URL temporária, depois
 *   baixar com o token). É o que `getMediaUrl` + `downloadMedia` fazem.
 * - **Mídia enviada por link** exige URL pública alcançável pela Meta.
 *
 * NUNCA chame este arquivo direto fora do módulo — sempre via `adapter.ts`.
 */
import { logger } from '@/lib/logger';

/** ⚠️ A Meta descontinua versões antigas com o tempo; ajustável por env. */
const GRAPH_VERSION = process.env.META_GRAPH_VERSION ?? 'v23.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 30_000;

export interface CloudApiCredentials {
  /** ID do número no WhatsApp Business (NÃO é o telefone). */
  phoneNumberId: string;
  /** Token permanente do System User com escopo whatsapp_business_messaging. */
  accessToken: string;
}

export interface CloudSendResult {
  /** wamid da mensagem criada — o mesmo id que volta nos webhooks de status. */
  message_id?: string;
  error?: string;
}

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number
  ) {
    super(message);
    this.name = 'CloudApiError';
  }

  /** Vale a pena repetir? Erro de janela ou número inválido, não. */
  isTransient(): boolean {
    if (this.status >= 500) return true;
    if (this.status === 429) return true;
    // 131026 = número não é WhatsApp; 131047 = fora da janela; 131051 = tipo
    // não suportado. Todos definitivos.
    return false;
  }
}

/**
 * Traduz o erro da Meta pra algo que o atendente entenda na tela.
 * Os códigos são estáveis e documentados; a mensagem crua não ajuda ninguém.
 */
function humanizeError(code: number | undefined, fallback: string): string {
  switch (code) {
    case 131047:
      return 'Fora da janela de 24h: só é possível enviar um template aprovado até o cliente responder de novo.';
    case 131026:
      return 'Este número não tem WhatsApp (ou não pode receber mensagens).';
    case 131051:
      return 'Tipo de mensagem não suportado pelo canal oficial.';
    case 130472:
      return 'Número fora do experimento/limite da conta.';
    case 100:
      return `Parâmetro inválido na chamada à Meta: ${fallback}`;
    case 190:
      return 'Token da Meta expirado ou revogado — gere um novo token permanente.';
    default:
      return fallback;
  }
}

async function graphFetch(
  creds: CloudApiCredentials,
  path: string,
  init?: RequestInit
): Promise<unknown> {
  const res = await fetch(`${GRAPH_BASE}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* resposta não-JSON: fica em `text` mesmo */
  }

  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; error_subcode?: number } } | null)?.error;
    const raw = err?.message ?? text ?? `HTTP ${res.status}`;
    throw new CloudApiError(humanizeError(err?.code, raw), res.status, err?.code, err?.error_subcode);
  }

  return json;
}

/** Extrai o wamid da resposta de envio. */
function toSendResult(json: unknown): CloudSendResult {
  const messages = (json as { messages?: Array<{ id?: string }> } | null)?.messages;
  return { message_id: messages?.[0]?.id };
}

interface SendBody {
  type: string;
  [key: string]: unknown;
}

async function sendMessage(
  creds: CloudApiCredentials,
  to: string,
  body: SendBody,
  quotedExternalId?: string | null
): Promise<CloudSendResult> {
  const payload: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    ...body,
  };
  // Reply/quote: a Meta chama de `context`.
  if (quotedExternalId) payload.context = { message_id: quotedExternalId };

  const json = await graphFetch(creds, `${creds.phoneNumberId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return toSendResult(json);
}

/**
 * Parâmetro de um template — sempre posicional na Cloud API. A Meta numera as
 * variáveis por ORDEM ({{1}}, {{2}}...), não por nome, então a posição no
 * array é o contrato. Trocar dois valores de lugar não dá erro: entrega texto
 * errado ao cliente.
 */
export type TemplateParam = string;

export interface TemplateComponentsInput {
  /** Substituições do corpo, na ordem de {{1}}, {{2}}, ... */
  body?: TemplateParam[];
  /** Substituições do cabeçalho de texto, quando o template tiver uma. */
  header?: TemplateParam[];
}

function buildTemplateComponents(input: TemplateComponentsInput): unknown[] {
  const components: unknown[] = [];
  if (input.header?.length) {
    components.push({
      type: 'header',
      parameters: input.header.map(text => ({ type: 'text', text })),
    });
  }
  if (input.body?.length) {
    components.push({
      type: 'body',
      parameters: input.body.map(text => ({ type: 'text', text })),
    });
  }
  return components;
}

/**
 * Envia um template aprovado pela Meta.
 *
 * É o ÚNICO envio possível fora da janela de 24h — texto livre volta 131047.
 * Por isso todo follow-up de reativação passa por aqui: quando o cliente ficou
 * mais de um dia em silêncio, ou sai template, ou não sai nada.
 *
 * O que o template NÃO permite: escrever a frase na hora. A estrutura é fixa e
 * aprovada previamente; a personalização se limita a preencher as variáveis.
 * Quem monta o follow-up precisa saber disso ao escolher entre os templates
 * disponíveis, em vez de tentar redigir.
 *
 * `languageCode` é o código EXATO cadastrado no template (ex: `pt_BR`). A Meta
 * rejeita se não bater — inclusive `pt` no lugar de `pt_BR`.
 */
export function sendTemplate(
  creds: CloudApiCredentials,
  to: string,
  templateName: string,
  languageCode: string,
  params: TemplateComponentsInput = {}
): Promise<CloudSendResult> {
  const components = buildTemplateComponents(params);
  return sendMessage(creds, to, {
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components.length ? { components } : {}),
    },
  });
}

export function sendText(
  creds: CloudApiCredentials,
  to: string,
  body: string,
  quotedExternalId?: string | null
): Promise<CloudSendResult> {
  return sendMessage(creds, to, { type: 'text', text: { body, preview_url: false } }, quotedExternalId);
}

export function sendImage(
  creds: CloudApiCredentials,
  to: string,
  link: string,
  caption?: string,
  quotedExternalId?: string | null
): Promise<CloudSendResult> {
  return sendMessage(
    creds,
    to,
    { type: 'image', image: caption ? { link, caption } : { link } },
    quotedExternalId
  );
}

export function sendAudio(
  creds: CloudApiCredentials,
  to: string,
  link: string,
  quotedExternalId?: string | null
): Promise<CloudSendResult> {
  return sendMessage(creds, to, { type: 'audio', audio: { link } }, quotedExternalId);
}

export function sendVideo(
  creds: CloudApiCredentials,
  to: string,
  link: string,
  caption?: string,
  quotedExternalId?: string | null
): Promise<CloudSendResult> {
  return sendMessage(
    creds,
    to,
    { type: 'video', video: caption ? { link, caption } : { link } },
    quotedExternalId
  );
}

export function sendDocument(
  creds: CloudApiCredentials,
  to: string,
  link: string,
  filename: string,
  caption?: string,
  quotedExternalId?: string | null
): Promise<CloudSendResult> {
  return sendMessage(
    creds,
    to,
    { type: 'document', document: caption ? { link, filename, caption } : { link, filename } },
    quotedExternalId
  );
}

/** `emoji = ''` remove a reação anterior — é o contrato da própria Meta. */
export function sendReaction(
  creds: CloudApiCredentials,
  to: string,
  messageId: string,
  emoji: string
): Promise<CloudSendResult> {
  return sendMessage(creds, to, { type: 'reaction', reaction: { message_id: messageId, emoji } });
}

/**
 * Marca UMA mensagem como lida. O canal oficial não tem "marcar conversa toda
 * como lida" — só por mensagem, e só faz sentido na última recebida.
 */
export async function markAsRead(creds: CloudApiCredentials, messageId: string): Promise<void> {
  await graphFetch(creds, `${creds.phoneNumberId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  });
}

export interface CloudMedia {
  url: string;
  mimeType: string | null;
  fileSize: number | null;
}

/** Passo 1 do download: o webhook só traz o id; a URL é temporária (~5 min). */
export async function getMediaUrl(creds: CloudApiCredentials, mediaId: string): Promise<CloudMedia | null> {
  try {
    const json = (await graphFetch(creds, mediaId)) as {
      url?: string;
      mime_type?: string;
      file_size?: number;
    } | null;
    if (!json?.url) return null;
    return { url: json.url, mimeType: json.mime_type ?? null, fileSize: json.file_size ?? null };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, mediaId },
      '[cloud-api] falha ao resolver URL da mídia'
    );
    return null;
  }
}

/**
 * Passo 2: baixar. A URL da Meta exige o mesmo Bearer — sem ele volta 401,
 * o que costuma ser confundido com mídia expirada.
 */
export async function downloadMedia(
  creds: CloudApiCredentials,
  url: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, '[cloud-api] download de mídia falhou');
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { buffer, mimeType };
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[cloud-api] download de mídia falhou');
    return null;
  }
}

/** Sanidade da credencial: confirma que o número existe e está acessível. */
export async function fetchPhoneNumber(
  creds: CloudApiCredentials
): Promise<{ displayPhoneNumber: string | null; verifiedName: string | null } | null> {
  try {
    const json = (await graphFetch(
      creds,
      `${creds.phoneNumberId}?fields=display_phone_number,verified_name`
    )) as { display_phone_number?: string; verified_name?: string } | null;
    if (!json) return null;
    return {
      displayPhoneNumber: json.display_phone_number ?? null,
      verifiedName: json.verified_name ?? null,
    };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[cloud-api] não consegui ler os dados do número'
    );
    return null;
  }
}
