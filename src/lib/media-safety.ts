/**
 * Regras de segurança do storage de mídia — o que pode entrar pelo upload e
 * como cada objeto sai pela rota pública `/api/media/[key]`.
 *
 * Duas falhas reais motivaram este arquivo:
 *
 * 1. O backup diário (`modules/backup`) gravava leads e conversas inteiras em
 *    `backups/<schema>/<data>.ndjson` no MESMO bucket da mídia, e a rota pública
 *    lia qualquer chave do bucket. Chave previsível + rota sem sessão = dump do
 *    banco para quem soubesse o nome do arquivo. Prefixos reservados nunca
 *    saem pela rota de mídia, independente de onde o backup esteja.
 *
 * 2. O upload confiava no MIME declarado pelo navegador e a rota devolvia o
 *    objeto com esse mesmo `Content-Type`. Um `text/html` com script, aberto
 *    como documento na origem do CRM, roda com a sessão de quem abriu. Conteúdo
 *    ativo é recusado na entrada e, na saída, tudo que não é imagem/áudio/vídeo/
 *    PDF vai como download com `nosniff`.
 */

const RESERVED_PREFIXES = ['backups'] as const;

/** Chaves que a rota pública de mídia nunca serve, mesmo que existam no bucket. */
export function isReservedMediaKey(key: string): boolean {
  const k = key.replace(/^\/+/, '');
  return RESERVED_PREFIXES.some((p) => k === p || k.startsWith(`${p}/`));
}

/** Tipos que o navegador executa como documento na origem — nunca entram nem saem ativos. */
const ACTIVE_CONTENT = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-shockwave-flash',
]);

function baseMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
}

export function isActiveContentMime(mime: string | null | undefined): boolean {
  return ACTIVE_CONTENT.has(baseMime(mime));
}

/** O que o navegador pode renderizar inline sem executar nada. */
const INLINE_SAFE = /^(image\/(jpeg|png|gif|webp|bmp|avif)|video\/[\w.+-]+|audio\/[\w.+-]+|application\/pdf)$/;

/**
 * Cabeçalhos de resposta para um objeto do storage.
 *
 * - Conteúdo ativo sai como `application/octet-stream` + download: mesmo que
 *   algo tenha entrado por outro caminho (mídia recebida pelo WhatsApp, por
 *   exemplo), nunca é renderizado na origem do CRM.
 * - `nosniff` impede o navegador de "adivinhar" HTML num octet-stream.
 * - `Content-Security-Policy: sandbox` no que vai como download é cinto e
 *   suspensório: se um navegador antigo ignorar o attachment, ainda roda sem
 *   origem e sem script.
 */
export function mediaResponseHeaders(
  mime: string | null | undefined,
  extra: Record<string, string> = {}
): Record<string, string> {
  const base = baseMime(mime);
  const active = ACTIVE_CONTENT.has(base);
  const inline = !active && INLINE_SAFE.test(base);
  const headers: Record<string, string> = {
    'Content-Type': active ? 'application/octet-stream' : base,
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    ...extra,
  };
  if (!inline) headers['Content-Security-Policy'] = 'sandbox';
  return headers;
}
