/**
 * Client da API do Gmail, por REST direto.
 *
 * Sem a biblioteca `googleapis` de propósito: ela é feita para Node, pesa
 * dezenas de MB e usa APIs que não existem no Worker. A API REST do Gmail é
 * `fetch` com um Bearer — e é assim que o projeto da preventiva já fala com o
 * Google hoje.
 */
import { logger } from '@/lib/logger';

const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Escopos pedidos na autorização.
 *
 * `gmail.send` e `gmail.readonly` em vez do `mail.google.com` completo: o
 * amplo permite APAGAR a caixa da pessoa, e pedir poder que não se usa é o que
 * faz a tela de consentimento do Google assustar e a revisão dele demorar.
 * `userinfo.email` é o que nos diz QUAL endereço foi conectado.
 */
export const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

export class GmailAuthError extends Error {}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

function oauthConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GmailAuthError(
      'E-mail não configurado neste deploy: faltam GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET.'
    );
  }
  return { clientId, clientSecret };
}

export function isGmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

/** URL da tela de consentimento do Google. */
export function buildAuthUrl(params: { redirectUri: string; state: string }): string {
  const { clientId } = oauthConfig();
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', params.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GMAIL_SCOPES);
  // `offline` é o que faz o Google devolver refresh_token — sem ele a conexão
  // morre em uma hora e a pessoa teria de reconectar o dia inteiro.
  u.searchParams.set('access_type', 'offline');
  // `consent` força a tela mesmo para quem já autorizou antes. Sem isto, na
  // SEGUNDA autorização o Google devolve só o access_token, e a reconexão
  // gravaria uma conta sem refresh — que falha na hora de renovar.
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', params.state);
  u.searchParams.set('include_granted_scopes', 'true');
  return u.toString();
}

/** Troca o `code` da volta do Google pelos tokens. */
export async function exchangeCode(params: {
  code: string;
  redirectUri: string;
}): Promise<{ refreshToken: string; accessToken: string; scope: string | null }> {
  const { clientId, clientSecret } = oauthConfig();

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    throw new GmailAuthError(
      `Google recusou a autorização: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`
    );
  }
  if (!json.refresh_token) {
    // Acontece quando a conta já autorizou antes e o `prompt=consent` não foi
    // enviado. Sem refresh a conta seria inútil em uma hora — melhor recusar
    // agora, com instrução, do que gravar e quebrar depois.
    throw new GmailAuthError(
      'O Google não devolveu refresh_token. Remova o acesso do app em ' +
        'myaccount.google.com/permissions e conecte novamente.'
    );
  }

  return {
    refreshToken: json.refresh_token,
    accessToken: json.access_token,
    scope: json.scope ?? null,
  };
}

/**
 * Access token novo a partir do refresh.
 *
 * Não há cache aqui de propósito: o Worker é efêmero e um cache entre
 * requisições vazaria token entre isolates. O token vive 1h e cada envio pede
 * o seu — uma chamada a mais que custa menos que um vazamento.
 */
export async function getAccessToken(refreshToken: string): Promise<string> {
  const { clientId, clientSecret } = oauthConfig();

  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token) {
    // `invalid_grant` = a pessoa revogou, trocou a senha ou o app foi removido.
    // É o caso que marca a conta como inativa lá em cima.
    throw new GmailAuthError(
      json.error === 'invalid_grant'
        ? 'Acesso revogado pelo Google — a conta precisa ser reconectada.'
        : `Falha ao renovar o acesso: ${json.error_description ?? json.error ?? `HTTP ${res.status}`}`
    );
  }
  return json.access_token;
}

/** Qual endereço foi conectado. */
export async function getProfileEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(`${GMAIL_API}/profile`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => ({}))) as { emailAddress?: string };
  return j.emailAddress ?? null;
}

// ────────────────────────────────────────────────────────────────────────────
// Envio
// ────────────────────────────────────────────────────────────────────────────

/** base64url — o Gmail recusa o base64 comum (`+`, `/` e `=`). */
function b64url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Codifica cabeçalho não-ASCII (RFC 2047).
 *
 * Sem isto, um assunto com acento chega como "ProposÃ§Ã£o" na caixa do cliente
 * — e é assunto com acento que o Brasil inteiro escreve.
 */
function encodeHeader(v: string): string {
  if (/^[\x20-\x7E]*$/.test(v)) return v;
  const bytes = new TextEncoder().encode(v);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `=?UTF-8?B?${btoa(bin)}?=`;
}

export interface SendInput {
  to: string;
  subject: string;
  /** Corpo em texto. HTML entra em `html`. */
  text: string;
  html?: string;
  /** Responder dentro de uma conversa existente. */
  threadId?: string | null;
  /** `Message-ID` do e-mail respondido — é o que mantém a thread no cliente. */
  inReplyTo?: string | null;
}

function buildMime(from: string, fromName: string | null, input: SendInput): string {
  const boundary = `b${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const remetente = fromName ? `${encodeHeader(fromName)} <${from}>` : from;

  const headers = [
    `From: ${remetente}`,
    `To: ${input.to}`,
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`);
  }

  if (!input.html) {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    return `${headers.join('\r\n')}\r\n\r\n${input.text}`;
  }

  // Alternativa texto+HTML: cliente que não renderiza HTML ainda lê algo, e
  // filtro de spam pontua melhor mensagem que traz as duas partes.
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    input.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    input.html,
    `--${boundary}--`,
  ].join('\r\n');
}

export async function sendEmail(
  refreshToken: string,
  from: string,
  fromName: string | null,
  input: SendInput
): Promise<{ messageId: string; threadId: string | null }> {
  const accessToken = await getAccessToken(refreshToken);
  const raw = b64url(buildMime(from, fromName, input));

  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input.threadId ? { raw, threadId: input.threadId } : { raw }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    id?: string;
    threadId?: string;
    error?: { message?: string };
  };

  if (!res.ok) {
    throw new Error(`Gmail recusou o envio: ${json.error?.message ?? `HTTP ${res.status}`}`);
  }

  logger.info({ from, to: input.to, messageId: json.id }, '[email] enviado');
  return { messageId: json.id ?? '', threadId: json.threadId ?? null };
}

// ────────────────────────────────────────────────────────────────────────────
// Leitura
// ────────────────────────────────────────────────────────────────────────────

export interface InboxMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  /**
   * Corpo em texto, decodificado do `payload` (format=full). Vazio quando a
   * mensagem não tem parte de texto legível (só anexo, por exemplo) — aí o
   * chamador usa o `snippet`. A v1 buscava `format=metadata` e gravava só o
   * snippet (~150 caracteres): todo e-mail longo chegava cortado no CRM.
   */
  body: string;
  date: number;
  messageIdHeader: string | null;
  /**
   * A mensagem foi disparada por máquina, não escrita por uma pessoa.
   *
   * Sai dos cabeçalhos que o próprio remetente é obrigado a mandar quando o
   * envio é em massa ou automático — bem mais confiável do que adivinhar pelo
   * nome do endereço, porque quem manda newsletter marca isso corretamente
   * (é o que evita ser tratado como spam) e ninguém escrevendo à mão marca.
   */
  bulk: boolean;
}

/** Cabeçalhos que denunciam envio automático ou em massa. */
function ehBulk(payload: unknown): boolean {
  if (header(payload, 'List-Unsubscribe')) return true;
  if (header(payload, 'List-Id')) return true;
  // `auto-replied`/`auto-generated` (RFC 3834): férias, confirmação, robô.
  const auto = header(payload, 'Auto-Submitted').toLowerCase();
  if (auto && auto !== 'no') return true;
  const prec = header(payload, 'Precedence').toLowerCase();
  return prec === 'bulk' || prec === 'list' || prec === 'junk';
}

/** Limite do corpo gravado: e-mail corporativo com histórico citado passa de 100k. */
const CORPO_MAX = 20_000;

interface ParteGmail {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: ParteGmail[];
}

/** base64url (Gmail) → UTF-8. Tolerante a padding ausente e a lixo. */
function decodeB64Url(data: string): string {
  try {
    const b64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/** HTML → texto simples: quebras em <br>/<p>/<div>, tags fora, entidades comuns. */
function htmlParaTexto(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Percorre a árvore MIME e devolve a primeira parte do tipo pedido. */
function achaParte(parte: ParteGmail | undefined, mime: string): string | null {
  if (!parte) return null;
  if (parte.mimeType?.toLowerCase() === mime && parte.body?.data) return decodeB64Url(parte.body.data);
  for (const p of parte.parts ?? []) {
    const r = achaParte(p, mime);
    if (r) return r;
  }
  return null;
}

/**
 * Corpo legível de um `payload` do Gmail (format=full).
 *
 * Prefere `text/plain`; sem ele, converte o `text/html`. Mensagem simples
 * (sem `parts`) tem o corpo no próprio `payload.body`. Limita a CORPO_MAX
 * para não gravar 100k de histórico citado num único balão.
 */
export function extrairCorpo(payload: unknown): string {
  const raiz = payload as ParteGmail | undefined;
  if (!raiz) return '';
  let texto = achaParte(raiz, 'text/plain');
  if (!texto) {
    const html = achaParte(raiz, 'text/html');
    if (html) texto = htmlParaTexto(html);
  }
  if (!texto) return '';
  texto = texto.replace(/\r\n/g, '\n').trim();
  return texto.length > CORPO_MAX ? texto.slice(0, CORPO_MAX) + '\n\n[… mensagem truncada]' : texto;
}

function header(payload: unknown, nome: string): string {
  const hs = (payload as { headers?: Array<{ name?: string; value?: string }> })?.headers ?? [];
  return hs.find((h) => h.name?.toLowerCase() === nome.toLowerCase())?.value ?? '';
}

/**
 * Mensagens recebidas, mais recentes primeiro.
 *
 * `q` aceita a sintaxe de busca do Gmail. O padrão exclui promoções e social:
 * um CRM quer a conversa com o cliente, não a newsletter que chegou junto.
 */
export async function listInbox(
  refreshToken: string,
  opts: { max?: number; query?: string } = {}
): Promise<InboxMessage[]> {
  const accessToken = await getAccessToken(refreshToken);
  const q = opts.query ?? 'in:inbox -category:promotions -category:social';

  const listUrl = new URL(`${GMAIL_API}/messages`);
  listUrl.searchParams.set('maxResults', String(opts.max ?? 20));
  listUrl.searchParams.set('q', q);

  const listRes = await fetch(listUrl.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    throw new Error(`Gmail recusou a listagem: HTTP ${listRes.status}`);
  }

  const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
  const ids = (list.messages ?? []).map((m) => m.id);
  if (ids.length === 0) return [];

  // Uma chamada por mensagem é o que a API oferece; o `maxResults` acima é o
  // que impede isso de virar uma rajada de centenas de requisições.
  const mensagens = await Promise.all(
    ids.map(async (id) => {
      const r = await fetch(`${GMAIL_API}/messages/${id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return null;
      const m = (await r.json()) as {
        id: string;
        threadId: string;
        snippet?: string;
        internalDate?: string;
        payload?: unknown;
      };
      return {
        id: m.id,
        threadId: m.threadId,
        from: header(m.payload, 'From'),
        to: header(m.payload, 'To'),
        subject: header(m.payload, 'Subject'),
        snippet: m.snippet ?? '',
        body: extrairCorpo(m.payload),
        date: Number(m.internalDate ?? Date.now()),
        messageIdHeader: header(m.payload, 'Message-ID') || null,
        bulk: ehBulk(m.payload),
      } satisfies InboxMessage;
    })
  );

  return mensagens.filter((m): m is InboxMessage => m !== null).sort((a, b) => b.date - a.date);
}
