/**
 * Serve a mídia do CRM — do R2 no Cloudflare, do disco em dev.
 *
 * Esta rota é PÚBLICA de propósito (ver `middleware.ts`): é a URL que a uazapi
 * busca pra anexar a mídia numa mensagem de saída. O objeto no R2 fica privado
 * e só sai por aqui.
 *
 * Sec: bloqueia path traversal e limita a leitura ao LOCAL_MEDIA_ROOT.
 */
import { NextRequest, NextResponse } from 'next/server';
import { readLocalMedia, readR2Media, getStorageBackend } from '@/lib/storage';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string }> }
) {
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);

  // Sec: bloqueia path traversal
  if (key.includes('..') || key.startsWith('/') || key.includes('\0')) {
    return NextResponse.json({ error: 'invalid key' }, { status: 400 });
  }

  // R2 primeiro: dentro do Worker é o único backend que existe.
  const media = (await readR2Media(key)) ??
    (getStorageBackend() === 'local' ? await readLocalMedia(key) : null);
  if (!media) return NextResponse.json({ error: 'not found' }, { status: 404 });

  return new NextResponse(media.buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': media.mimeType,
      'Cache-Control': 'public, max-age=86400',
      'Content-Length': String(media.buffer.length),
    },
  });
}
