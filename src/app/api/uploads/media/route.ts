/**
 * POST /api/uploads/media — upload de mídia do composer (atendente).
 *
 * Recebe multipart/form-data com campo `file`, sobe pra storage (R2 ou local)
 * e retorna `{ url, key, mimeType, fileName, size }`.
 *
 * O caller (composer da página de lead) usa essa URL como `mediaUrl` no
 * POST /api/leads/[id]/messages.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { uploadMedia } from '@/lib/storage';
import { isActiveContentMime } from '@/lib/media-safety';
import { transcodeToOggOpus } from '@/modules/channels/whatsapp/audio-convert';
import { logger } from '@/lib/logger';

const MAX_BYTES = 25 * 1024 * 1024; // 25MB — WhatsApp aceita mais, mas limitamos pra segurança

function safeFilename(name: string): string {
  return name.replace(/[^\w.\-]/g, '_').slice(0, 100);
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/webm': 'webm',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
  };
  return map[mime] ?? 'bin';
}

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: 'Esperado multipart/form-data' }, { status: 400 });

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Campo "file" obrigatório' }, { status: 400 });
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Arquivo vazio' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `Arquivo grande demais (max ${MAX_BYTES / 1024 / 1024}MB)` },
      { status: 413 }
    );
  }

  const inputMime = file.type || 'application/octet-stream';
  // HTML/SVG/JS voltariam pela rota pública de mídia como documento na origem
  // do CRM — com a sessão de quem abrisse. Não é formato que se manda por
  // WhatsApp; recusar na entrada é o barato. A saída ainda protege o que
  // entrar por outro caminho (ver `lib/media-safety.ts`).
  if (isActiveContentMime(inputMime)) {
    return NextResponse.json({ error: 'Tipo de arquivo não permitido' }, { status: 415 });
  }
  let buffer: Buffer = Buffer.from(await file.arrayBuffer());
  let finalMime = inputMime;
  let converted = false;

  // Voice note: normalizamos QUALQUER áudio pra ogg/opus 32k/48kHz/mono antes
  // do upload. WhatsApp só renderiza balão de voz (PTT) — e o iOS só decodifica —
  // com esse formato. Formatos crus (webm do Chrome, mp4/aac do Safari iOS,
  // ogg/vorbis, mp3) tocam no Android tolerante mas dão "áudio não disponível"
  // no iOS. Por isso convertemos todos, não só webm.
  if (inputMime.startsWith('audio/')) {
    try {
      const t0 = Date.now();
      const ogg = await transcodeToOggOpus(buffer);
      buffer = ogg;
      finalMime = 'audio/ogg';
      converted = true;
      logger.info({ ms: Date.now() - t0, inputMime, inputBytes: file.size, outputBytes: ogg.length }, '[upload] audio→ogg/opus OK');
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, inputMime },
        '[upload] audio→ogg/opus falhou, mantendo formato original (vai como anexo, não voice note)'
      );
    }
  }

  const ext = extFromMime(finalMime);
  const safeName = safeFilename(file.name || `upload.${ext}`);
  // Se converteu, força extensão ogg no key pra storage local servir mimetype certo
  const keyName = converted ? safeName.replace(/\.\w+$/, '.ogg') : safeName;
  const key = `composer/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${keyName}`;

  try {
    const result = await uploadMedia(key, buffer, finalMime);
    return NextResponse.json({
      url: result.url,
      key: result.key,
      mimeType: finalMime,
      fileName: converted ? keyName : file.name,
      size: buffer.length,
      backend: result.backend,
      converted,
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, key }, '[POST /api/uploads/media] falhou');
    return NextResponse.json(
      { error: 'Falha no upload' },
      { status: 500 }
    );
  }
}
