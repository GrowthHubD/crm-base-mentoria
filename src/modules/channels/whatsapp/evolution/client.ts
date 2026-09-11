/**
 * Client HTTP da Evolution API v2.
 *
 * Diferença estrutural em relação aos outros dois canais: a Evolution é
 * **self-hosted**. A uazapi tem um endpoint global e a Cloud API é a Meta —
 * ambos cabem em env var. Aqui cada cliente aponta para o servidor DELE, então
 * a `baseUrl` viaja junto das credenciais, por connection. Guardar isso em env
 * quebraria no primeiro cliente com Evolution própria.
 *
 * Autenticação: header `apikey`. Usamos sempre a key **da instância** (a que o
 * `/instance/create` devolve), nunca a global do servidor — ver `provider.ts`.
 *
 * NUNCA chame este módulo direto fora da pasta `evolution/` — sempre via
 * `adapter.ts`, que é o que o resto do CRM conhece.
 */
import { logger } from '@/lib/logger';

export interface EvolutionCredentials {
  /** Raiz do servidor Evolution, sem barra final (ex: https://evo.cliente.com). */
  baseUrl: string;
  /** Nome da instância nesse servidor — é o `external_id` da connection. */
  instanceName: string;
  /** Key da instância (não a global do servidor). */
  apiKey: string;
}

export interface EvolutionSendResult {
  message_id?: string;
  error?: string;
}

/** Key de mensagem no formato que a Evolution (Baileys) exige. */
export interface EvolutionMessageKey {
  remoteJid: string;
  fromMe: boolean;
  id: string;
  participant?: string;
}

/** Timeout por chamada. A Evolution fica atrás do Traefik e do WhatsApp: um
 *  envio pendurado não pode segurar o Worker até o limite de CPU. */
const TIMEOUT_MS = 30_000;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/**
 * Converte o telefone do CRM (dígitos puros) para o que a Evolution espera.
 *
 * A Evolution aceita tanto `5511999999999` quanto o JID completo. Mandamos o
 * número limpo: se vier um JID de dentro do CRM (não deveria, mas já veio no
 * uazapi), o sufixo é removido em vez de virar `5511...@s.whatsapp.net@s.whatsapp.net`.
 */
function toNumber(contactId: string): string {
  return contactId.replace(/@.*$/, '').replace(/\D/g, '');
}

/**
 * Chamada crua. Erro NUNCA lança: devolve `{ error }`, porque todo caller é um
 * envio cujo caminho de falha já está desenhado (o CRM grava a mensagem como
 * falha e mostra na tela). Lançar aqui derrubaria o lote inteiro.
 */
async function call(
  creds: EvolutionCredentials,
  method: 'POST' | 'GET' | 'DELETE',
  path: string,
  body?: unknown
): Promise<{ ok: boolean; data: unknown; error?: string }> {
  const url = joinUrl(creds.baseUrl, path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        apikey: creds.apiKey,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      // A Evolution devolve `{ response: { message: [...] } }` em validação e
      // `{ message: "..." }` em erro de runtime. Achatamos para uma string só,
      // porque `ChannelSendResult.error` é string única por contrato.
      const err = extractError(data) ?? `HTTP ${res.status}`;
      return { ok: false, data, error: err };
    }

    return { ok: true, data };
  } catch (err) {
    const msg =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `timeout após ${TIMEOUT_MS}ms`
          : err.message
        : String(err);
    return { ok: false, data: null, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

function extractError(data: unknown): string | null {
  if (!data || typeof data !== 'object') return typeof data === 'string' ? data : null;
  const d = data as Record<string, unknown>;

  const response = d.response as Record<string, unknown> | undefined;
  if (response?.message) {
    const m = response.message;
    return Array.isArray(m) ? m.map((x) => stringifyPiece(x)).join('; ') : stringifyPiece(m);
  }
  if (d.message) return stringifyPiece(d.message);
  if (d.error) return stringifyPiece(d.error);
  return null;
}

function stringifyPiece(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Extrai o id da mensagem da resposta de envio.
 *
 * A Evolution responde `{ key: { id }, ... }` nos endpoints de `/message/*`.
 * Esse id é o que vai para `messages.external_id`, que é UNIQUE — é ele que
 * torna reprocessar um lote inofensivo.
 */
function extractMessageId(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  const key = d.key as Record<string, unknown> | undefined;
  if (key && typeof key.id === 'string') return key.id;
  if (typeof d.id === 'string') return d.id;
  return undefined;
}

function asResult(r: { ok: boolean; data: unknown; error?: string }): EvolutionSendResult {
  if (!r.ok) return { error: r.error ?? 'falha desconhecida' };
  return { message_id: extractMessageId(r.data) };
}

/** `quoted` no formato do Baileys. Só o id basta — a Evolution resolve o resto. */
function quotedPayload(quotedExternalId?: string | null) {
  if (!quotedExternalId) return undefined;
  return { key: { id: quotedExternalId } };
}

// ────────────────────────────────────────────────────────────────────────────
// Envio
// ────────────────────────────────────────────────────────────────────────────

/**
 * `delayMs` vira o campo `delay` da Evolution, que é presence "digitando..."
 * antes da entrega — o mesmo comportamento que a uazapi oferece e que o CRM já
 * usa para simular digitação humana. É por isso que este adapter não precisa
 * do no-op que a Cloud API faz aqui.
 */
export async function sendText(
  creds: EvolutionCredentials,
  contactId: string,
  text: string,
  delayMs?: number,
  quotedExternalId?: string | null
): Promise<EvolutionSendResult> {
  return asResult(
    await call(creds, 'POST', `/message/sendText/${creds.instanceName}`, {
      number: toNumber(contactId),
      text,
      ...(delayMs ? { delay: delayMs } : {}),
      ...(quotedPayload(quotedExternalId) ? { quoted: quotedPayload(quotedExternalId) } : {}),
    })
  );
}

type MediaKind = 'image' | 'video' | 'document';

/**
 * `/message/sendMedia` cobre imagem, vídeo e documento — o que muda é o
 * `mediatype`. O campo `media` aceita URL HTTPS ou base64 puro; se vier um
 * data URI do CRM, o prefixo é removido, porque a Evolution rejeita o
 * `data:...;base64,` na frente.
 */
export async function sendMedia(
  creds: EvolutionCredentials,
  contactId: string,
  mediatype: MediaKind,
  media: string,
  opts: {
    caption?: string;
    fileName?: string;
    mimetype?: string;
    delayMs?: number;
    quotedExternalId?: string | null;
  } = {}
): Promise<EvolutionSendResult> {
  return asResult(
    await call(creds, 'POST', `/message/sendMedia/${creds.instanceName}`, {
      number: toNumber(contactId),
      mediatype,
      media: stripDataUri(media),
      ...(opts.caption ? { caption: opts.caption } : {}),
      ...(opts.fileName ? { fileName: opts.fileName } : {}),
      ...(opts.mimetype ? { mimetype: opts.mimetype } : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      ...(quotedPayload(opts.quotedExternalId) ? { quoted: quotedPayload(opts.quotedExternalId) } : {}),
    })
  );
}

/**
 * Áudio como PTT (balão de voz), que é o que o CRM quer quando manda áudio.
 * Endpoint separado de propósito na Evolution: `/sendMedia` com mediatype
 * `audio` entrega como ANEXO, não como mensagem de voz.
 */
export async function sendWhatsAppAudio(
  creds: EvolutionCredentials,
  contactId: string,
  audio: string,
  delayMs?: number
): Promise<EvolutionSendResult> {
  return asResult(
    await call(creds, 'POST', `/message/sendWhatsAppAudio/${creds.instanceName}`, {
      number: toNumber(contactId),
      audio: stripDataUri(audio),
      ...(delayMs ? { delay: delayMs } : {}),
    })
  );
}

function stripDataUri(v: string): string {
  const m = /^data:[^;,]+;base64,(.*)$/s.exec(v);
  return m ? m[1] : v;
}

/** `reaction: ''` remove a reação anterior — mesmo contrato do CRM. */
export async function sendReaction(
  creds: EvolutionCredentials,
  key: EvolutionMessageKey,
  emoji: string
): Promise<EvolutionSendResult> {
  return asResult(
    await call(creds, 'POST', `/message/sendReaction/${creds.instanceName}`, {
      key,
      reaction: emoji,
    })
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Operações sobre mensagens
// ────────────────────────────────────────────────────────────────────────────

export async function markAsRead(
  creds: EvolutionCredentials,
  keys: EvolutionMessageKey[]
): Promise<EvolutionSendResult> {
  if (keys.length === 0) return {};
  return asResult(
    await call(creds, 'POST', `/chat/markMessageAsRead/${creds.instanceName}`, {
      readMessages: keys,
    })
  );
}

export async function deleteMessage(
  creds: EvolutionCredentials,
  key: EvolutionMessageKey
): Promise<EvolutionSendResult> {
  return asResult(
    await call(creds, 'DELETE', `/chat/deleteMessageForEveryone/${creds.instanceName}`, {
      id: key.id,
      remoteJid: key.remoteJid,
      fromMe: key.fromMe,
      ...(key.participant ? { participant: key.participant } : {}),
    })
  );
}

export async function editMessage(
  creds: EvolutionCredentials,
  key: EvolutionMessageKey,
  newText: string
): Promise<EvolutionSendResult> {
  return asResult(
    await call(creds, 'POST', `/chat/updateMessage/${creds.instanceName}`, {
      number: key.remoteJid.replace(/@.*$/, ''),
      key,
      text: newText,
    })
  );
}

/**
 * Presence avulsa ("digitando..."). O envio normal já embute isso via `delay`;
 * este endpoint existe para quem precisa do estado sem mandar mensagem junto.
 */
export async function sendPresence(
  creds: EvolutionCredentials,
  contactId: string,
  presence: 'composing' | 'recording' | 'paused',
  delayMs = 1200
): Promise<EvolutionSendResult> {
  return asResult(
    await call(creds, 'POST', `/chat/sendPresence/${creds.instanceName}`, {
      number: toNumber(contactId),
      presence,
      delay: delayMs,
    })
  );
}

/**
 * Baixa a mídia de uma mensagem recebida.
 *
 * Usado só quando o webhook não trouxe nem base64 nem URL utilizável — o
 * equivalente ao `/message/download` da uazapi. Devolve base64 puro.
 */
export async function getBase64FromMediaMessage(
  creds: EvolutionCredentials,
  key: EvolutionMessageKey
): Promise<{ base64: string; mimetype?: string } | null> {
  const r = await call(creds, 'POST', `/chat/getBase64FromMediaMessage/${creds.instanceName}`, {
    message: { key },
    convertToMp4: false,
  });

  if (!r.ok || !r.data || typeof r.data !== 'object') {
    logger.warn(
      { instance: creds.instanceName, messageId: key.id, error: r.error },
      '[evolution] download de mídia falhou'
    );
    return null;
  }

  const d = r.data as Record<string, unknown>;
  const base64 = typeof d.base64 === 'string' ? d.base64 : null;
  if (!base64) return null;

  return {
    base64,
    mimetype: typeof d.mimetype === 'string' ? d.mimetype : undefined,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Ciclo de vida da instância (onboarding — tela de Conexões)
// ────────────────────────────────────────────────────────────────────────────

export interface CreatedInstance {
  instanceName: string;
  /** Key DESTA instância. É a que deve ser guardada, não a global. */
  apiKey: string | null;
  /** QR em data URI, quando a Evolution já devolve no create. */
  qrcodeBase64: string | null;
}

/**
 * Cria a instância no servidor Evolution. Esta é a ÚNICA chamada que usa a key
 * global do servidor — passada explicitamente em `globalApiKey`, e nunca
 * persistida na connection.
 *
 * O webhook é registrado aqui, no nascimento, com `webhookByEvents: false`
 * (um endpoint só para todos os eventos) e o header de autenticação. Registrar
 * depois abriria uma janela em que o número está conectado e as mensagens
 * chegam sem destino.
 */
export async function createInstance(
  baseUrl: string,
  globalApiKey: string,
  params: {
    instanceName: string;
    webhookUrl: string;
    webhookToken: string;
    events?: string[];
  }
): Promise<{ instance: CreatedInstance | null; error?: string }> {
  const creds: EvolutionCredentials = {
    baseUrl,
    instanceName: params.instanceName,
    apiKey: globalApiKey,
  };

  const r = await call(creds, 'POST', '/instance/create', {
    instanceName: params.instanceName,
    integration: 'WHATSAPP-BAILEYS',
    qrcode: true,
    webhook: {
      url: params.webhookUrl,
      byEvents: false,
      base64: true,
      headers: {
        // Sem isto, qualquer um que descubra a URL injeta mensagem no CRM.
        // A rota recusa o que não apresentar exatamente este valor.
        'x-evolution-token': params.webhookToken,
      },
      events: params.events ?? [
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'SEND_MESSAGE',
        'CONNECTION_UPDATE',
      ],
    },
  });

  if (!r.ok) return { instance: null, error: r.error };

  const d = (r.data ?? {}) as Record<string, unknown>;
  const hash = d.hash as unknown;
  // A v2 já devolveu o hash como string e como `{ apikey }` — aceita os dois.
  const apiKey =
    typeof hash === 'string'
      ? hash
      : typeof (hash as Record<string, unknown>)?.apikey === 'string'
        ? ((hash as Record<string, unknown>).apikey as string)
        : null;

  const qr = d.qrcode as Record<string, unknown> | undefined;

  return {
    instance: {
      instanceName: params.instanceName,
      apiKey,
      qrcodeBase64: typeof qr?.base64 === 'string' ? qr.base64 : null,
    },
  };
}

/** QR novo para uma instância que ainda não conectou (ou caiu). */
export async function connectInstance(
  creds: EvolutionCredentials
): Promise<{ qrcodeBase64: string | null; pairingCode: string | null; error?: string }> {
  const r = await call(creds, 'GET', `/instance/connect/${creds.instanceName}`);
  if (!r.ok) return { qrcodeBase64: null, pairingCode: null, error: r.error };

  const d = (r.data ?? {}) as Record<string, unknown>;
  return {
    qrcodeBase64: typeof d.base64 === 'string' ? d.base64 : null,
    pairingCode: typeof d.pairingCode === 'string' ? d.pairingCode : null,
  };
}

/**
 * Estado da instância e o número conectado.
 *
 * Usa `/instance/fetchInstances` e NÃO `/instance/connectionState`, que é a
 * escolha óbvia e está errada: medido em produção, com a mesma instância
 * comprovadamente ligada, o `connectionState` respondeu `close` (com a key
 * global) e `connecting` (com a key da instância), enquanto o `fetchInstances`
 * respondia `open` com o `ownerJid` preenchido.
 *
 * O sintoma que isso causava: número escaneado, WhatsApp conectado, e o CRM
 * mostrando "Desconectado" — com o telefone certo na tela, porque o telefone
 * vinha do fetchInstances e o status vinha do outro endpoint.
 *
 * O `ownerJid` é a confirmação que fecha a questão: ele só existe depois que a
 * sessão do WhatsApp está de pé.
 *
 * `state: null` significa "não consegui saber" — e é diferente de
 * desconectado. Quem chama não deve marcar a connection como caída nesse caso.
 */
export async function instanceStatus(
  creds: EvolutionCredentials
): Promise<{ state: string | null; phone: string | null; error?: string }> {
  const r = await call(creds, 'GET', '/instance/fetchInstances');
  if (!r.ok) return { state: null, phone: null, error: r.error };

  const lista = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
  const alvo = (lista as Array<Record<string, unknown>>).find(
    (i) => i.name === creds.instanceName || i.instanceName === creds.instanceName
  );

  // A instância sumiu do servidor — apagada por fora. Aí sim é desconexão real.
  if (!alvo) return { state: 'close', phone: null };

  const state =
    typeof alvo.connectionStatus === 'string'
      ? alvo.connectionStatus
      : typeof alvo.state === 'string'
        ? alvo.state
        : null;

  const jid = typeof alvo.ownerJid === 'string' ? alvo.ownerJid : null;

  return { state, phone: jid ? jid.split('@')[0] : null };
}
