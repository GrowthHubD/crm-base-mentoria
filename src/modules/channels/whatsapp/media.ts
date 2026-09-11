/**
 * Helpers para baixar/processar mídia de mensagens WhatsApp.
 *
 * O webhook v2 da uazapi pode entregar mídia em 3 formatos:
 *   1. Base64 inline (campo `base64` | `mediaBase64` | `fileBase64`)
 *   2. URL HTTPS pública (campo `mediaUrl` | `fileURL` | etc) — pode estar
 *      criptografada (.enc) e exigir decrypt via /message/download
 *   3. Sem nada (precisa chamar `/message/download` da uazapi com o messageId)
 *
 * Esse módulo concentra a lógica de decisão e fetch real do binário.
 */
import { downloadMessageMedia } from './client';
import { isUsableMediaUrl, normalizeMime, type ParsedInbound } from './webhook-parser';
import { logger } from '@/lib/logger';

export interface MediaBlob {
  buffer: Buffer;
  mimeType: string;
  size: number;
  /** Origem do binário — útil pra debug/logging */
  source: 'base64' | 'url' | 'uazapi-download' | 'cloud-api';
}

/**
 * Resolve o binário da mídia no melhor formato disponível, na ordem:
 *   1. base64 inline (se houver) → decode imediato
 *   2. URL HTTPS válida (não .enc, não placeholder) → fetch
 *   3. uazapi /message/download (passa messageId) → URL nova ou base64
 *
 * Retorna `null` se nenhuma estratégia funcionou.
 */
export async function resolveMediaBlob(
  parsed: ParsedInbound,
  instanceToken: string | undefined
): Promise<MediaBlob | null> {
  // 1. Base64 inline
  if (parsed.mediaBase64) {
    try {
      const buffer = Buffer.from(parsed.mediaBase64, 'base64');
      return {
        buffer,
        mimeType: parsed.mimeType ?? 'application/octet-stream',
        size: buffer.length,
        source: 'base64',
      };
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, '[media] base64 inválido');
    }
  }

  // 2. URL HTTPS direta
  if (isUsableMediaUrl(parsed.mediaUrl)) {
    try {
      const buffer = await fetchUrlAsBuffer(parsed.mediaUrl!);
      return {
        buffer,
        mimeType: normalizeMime(parsed.mimeType) ?? 'application/octet-stream',
        size: buffer.length,
        source: 'url',
      };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, url: parsed.mediaUrl },
        '[media] fetch URL falhou'
      );
    }
  }

  // 3. /message/download da uazapi (decripta CDN do WhatsApp)
  if (parsed.externalId) {
    try {
      const result = await downloadMessageMedia(instanceToken, parsed.externalId);
      if (result?.base64) {
        const buffer = Buffer.from(result.base64, 'base64');
        return {
          buffer,
          mimeType: normalizeMime(result.mimetype ?? parsed.mimeType) ?? 'application/octet-stream',
          size: buffer.length,
          source: 'uazapi-download',
        };
      }
      if (result?.url && isUsableMediaUrl(result.url)) {
        const buffer = await fetchUrlAsBuffer(result.url);
        return {
          buffer,
          mimeType: normalizeMime(result.mimetype ?? parsed.mimeType) ?? 'application/octet-stream',
          size: buffer.length,
          source: 'uazapi-download',
        };
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, externalId: parsed.externalId },
        '[media] /message/download falhou'
      );
    }
  }

  return null;
}

async function fetchUrlAsBuffer(url: string, timeoutMs = 30000): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Gera nome de arquivo único pra storage, preservando extensão derivada do mime.
 * Formato: `{prefix}/{yyyy-mm}/{uuid}.{ext}`
 */
export function buildStorageKey(prefix: string, mimeType: string | null, originalName?: string | null): string {
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const id = crypto.randomUUID();
  const ext = extFromMimeOrName(mimeType, originalName);
  return `${prefix}/${yyyymm}/${id}${ext ? '.' + ext : ''}`;
}

function extFromMimeOrName(mime: string | null, name?: string | null): string | null {
  if (name) {
    const m = name.match(/\.([a-z0-9]+)$/i);
    if (m) return m[1].toLowerCase();
  }
  if (!mime) return null;
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
  };
  if (map[mime]) return map[mime];
  // Fallback: parte depois da barra
  const slash = mime.indexOf('/');
  if (slash >= 0) return mime.slice(slash + 1).split(';')[0];
  return null;
}
