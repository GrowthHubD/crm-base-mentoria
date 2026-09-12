/**
 * Storage de mídia — abstração com 2 backends:
 *   - R2/S3 (produção, quando R2_* estiverem configurados)
 *   - Local filesystem (./tmp/media) com URL servida via /api/media/[key]
 *
 * Decisão automática: se R2_BUCKET + R2_ENDPOINT + creds estiverem set, usa R2.
 * Senão, usa local fallback.
 */
// `fs` e `path` NÃO entram no topo: este módulo é importado pelo caminho de
// inbound, que roda também no Cloudflare Worker — onde não existe filesystem e
// o import derrubaria a rota inteira antes de qualquer lógica. O backend local
// carrega os dois sob demanda, e no Worker essa função nunca é chamada porque
// lá o R2 está sempre configurado.
import { logger } from './logger';
import { isReservedMediaKey } from './media-safety';

async function nodeFs() {
  const [{ promises: fs }, path] = await Promise.all([import('fs'), import('path')]);
  return { fs, join: path.join, dirname: path.dirname };
}

const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
// PUBLIC_BASE precisa apontar pra URL acessível DE FORA (uazapi vai buscar a mídia daqui).
// Aceita NEXTAUTH_URL ou BETTER_AUTH_URL — qualquer um basta.
const PUBLIC_BASE =
  process.env.NEXTAUTH_URL ?? process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

/** Resolvido só quando o backend local é usado — `process.cwd()` não existe
 *  no Worker. */
function localRoot(join: (...p: string[]) => string): string {
  return process.env.LOCAL_MEDIA_ROOT ?? join(process.cwd(), 'tmp', 'media');
}

const useR2 = !!(R2_ENDPOINT && R2_BUCKET && R2_ACCESS_KEY && R2_SECRET_KEY);

/**
 * Binding nativo do R2, quando rodando dentro do Cloudflare Worker.
 *
 * Preferido sobre o SDK S3: não há credencial pra guardar como secret, nem
 * assinatura pra calcular, e o acesso não sai do datacenter. Fora do Worker
 * devolve null e o código cai no S3 (se configurado) ou no disco.
 */
const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');

interface R2Bucket {
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
}

function getR2Binding(): R2Bucket | null {
  const ctx = (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT] as
    | { env?: { MEDIA?: R2Bucket } }
    | undefined;
  return ctx?.env?.MEDIA ?? null;
}

export interface UploadResult {
  /** URL pública pra usar como mediaUrl em messages */
  url: string;
  /** Storage key interno */
  key: string;
  /** Backend usado */
  backend: 'r2' | 'local';
}

/**
 * Sobe Buffer pro storage e retorna URL pública.
 */
export async function uploadMedia(
  key: string,
  body: Buffer,
  mimeType: string
): Promise<UploadResult> {
  const bucket = getR2Binding();
  if (bucket) {
    await bucket.put(key, new Uint8Array(body), { httpMetadata: { contentType: mimeType } });
    // O objeto não é público: a URL entregue é a da própria app, que lê do
    // bucket em `/api/media/[key]`. É essa URL que a uazapi busca pra enviar.
    const url = `${PUBLIC_BASE.replace(/\/$/, '')}/api/media/${encodeURIComponent(key)}`;
    logger.debug({ key, size: body.length, mimeType }, '[storage] R2 (binding) upload OK');
    return { url, key, backend: 'r2' };
  }
  if (useR2) {
    return uploadToR2(key, body, mimeType);
  }
  return uploadToLocal(key, body, mimeType);
}

/** Lê do binding do R2. Null fora do Worker ou quando a chave não existe. */
export async function readR2Media(
  key: string
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  // Backups moram no bucket, mas não são mídia: nunca saem por leitura de
  // mídia, mesmo que a rota que chama esqueça de checar.
  if (isReservedMediaKey(key)) return null;
  const bucket = getR2Binding();
  if (!bucket) return null;
  const obj = await bucket.get(key);
  if (!obj) return null;
  return {
    buffer: Buffer.from(await obj.arrayBuffer()),
    mimeType: obj.httpMetadata?.contentType ?? 'application/octet-stream',
  };
}

async function uploadToR2(key: string, body: Buffer, mimeType: string): Promise<UploadResult> {
  // Usa @aws-sdk/client-s3 (já instalado) compatível com R2
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const s3 = new S3Client({
    endpoint: R2_ENDPOINT,
    region: 'auto',
    credentials: {
      accessKeyId: R2_ACCESS_KEY!,
      secretAccessKey: R2_SECRET_KEY!,
    },
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET!,
      Key: key,
      Body: body,
      ContentType: mimeType,
    })
  );
  const url = R2_PUBLIC_URL ? `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}` : `${R2_ENDPOINT}/${R2_BUCKET}/${key}`;
  logger.debug({ key, size: body.length, mimeType }, '[storage] R2 upload OK');
  return { url, key, backend: 'r2' };
}

async function uploadToLocal(key: string, body: Buffer, mimeType: string): Promise<UploadResult> {
  const { fs, join, dirname } = await nodeFs();
  const fullPath = join(localRoot(join), key);
  await fs.mkdir(dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, body);
  const url = `${PUBLIC_BASE}/api/media/${encodeURIComponent(key)}`;
  logger.debug({ key, size: body.length, mimeType, path: fullPath }, '[storage] local upload OK');
  return { url, key, backend: 'local' };
}

/**
 * Baixa mídia local (servida via /api/media/[key]). Retorna null se não existir.
 */
export async function readLocalMedia(key: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (isReservedMediaKey(key)) return null;
  try {
    const { fs, join } = await nodeFs();
    const fullPath = join(localRoot(join), key);
    const buffer = await fs.readFile(fullPath);
    const ext = (key.match(/\.([a-z0-9]+)$/i) ?? [])[1]?.toLowerCase();
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      mp4: 'video/mp4',
      webm: 'video/webm',
      ogg: 'audio/ogg',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      pdf: 'application/pdf',
    };
    const mimeType = (ext && mimeMap[ext]) || 'application/octet-stream';
    return { buffer, mimeType };
  } catch {
    return null;
  }
}

export function getStorageBackend(): 'r2' | 'local' {
  return useR2 ? 'r2' : 'local';
}
