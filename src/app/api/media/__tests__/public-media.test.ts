/**
 * A rota pública de mídia não serve backup e não devolve HTML ativo; o upload
 * recusa conteúdo ativo na entrada.
 *
 * Os handlers reais são exercitados com o storage mockado — sem bucket, sem
 * disco. O que importa é a composição: chave reservada nunca chega ao storage,
 * e o que o storage devolve sai com os cabeçalhos certos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const readR2Media = vi.fn();
const readLocalMedia = vi.fn();
const uploadMedia = vi.fn();

vi.mock('@/lib/storage', () => ({
  readR2Media: (...a: unknown[]) => readR2Media(...a),
  readLocalMedia: (...a: unknown[]) => readLocalMedia(...a),
  uploadMedia: (...a: unknown[]) => uploadMedia(...a),
  getStorageBackend: () => 'local',
}));

vi.mock('@/lib/auth-helpers', () => ({
  requireSession: async () => ({ user: { id: 'u1', role: 'attendant' } }),
}));

vi.mock('@/modules/channels/whatsapp/audio-convert', () => ({
  transcodeToOggOpus: async (b: Buffer) => b,
}));

import { GET as getMedia } from '../[key]/route';
import { POST as postUpload } from '../../uploads/media/route';

function params(key: string) {
  return { params: Promise.resolve({ key: encodeURIComponent(key) }) };
}

beforeEach(() => {
  readR2Media.mockReset();
  readLocalMedia.mockReset();
  uploadMedia.mockReset();
});

describe('GET /api/media/[key]', () => {
  it('responde 404 para chave de backup SEM consultar o storage', async () => {
    readR2Media.mockResolvedValue({ buffer: Buffer.from('{"__table":"leads"}'), mimeType: 'application/x-ndjson' });
    const res = await getMedia(new NextRequest('http://x/api/media/k'), params('backups/cliente_acme/2026-09-11-07-00-00.ndjson'));
    expect(res.status).toBe(404);
    expect(readR2Media).not.toHaveBeenCalled();
    expect(readLocalMedia).not.toHaveBeenCalled();
  });

  it('serve imagem inline com nosniff', async () => {
    readR2Media.mockResolvedValue(null);
    readLocalMedia.mockResolvedValue({ buffer: Buffer.from('png'), mimeType: 'image/png' });
    const res = await getMedia(new NextRequest('http://x/api/media/k'), params('whatsapp/image/a.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('HTML guardado no storage nunca sai como HTML', async () => {
    readR2Media.mockResolvedValue({ buffer: Buffer.from('<script>1</script>'), mimeType: 'text/html' });
    const res = await getMedia(new NextRequest('http://x/api/media/k'), params('composer/1-x.html'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
  });
});

describe('POST /api/uploads/media', () => {
  function multipart(name: string, type: string, body = 'x') {
    const form = new FormData();
    form.set('file', new File([body], name, { type }));
    return new NextRequest('http://x/api/uploads/media', { method: 'POST', body: form });
  }

  it('recusa HTML com 415 antes de tocar o storage', async () => {
    const res = await postUpload(multipart('a.html', 'text/html', '<script>1</script>'));
    expect(res.status).toBe(415);
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('recusa SVG (executa script na origem)', async () => {
    const res = await postUpload(multipart('a.svg', 'image/svg+xml', '<svg/>'));
    expect(res.status).toBe(415);
  });

  it('aceita PDF', async () => {
    uploadMedia.mockResolvedValue({ url: 'http://x/api/media/composer%2F1-a.pdf', key: 'composer/1-a.pdf', backend: 'local' });
    const res = await postUpload(multipart('a.pdf', 'application/pdf', '%PDF-1.4'));
    expect(res.status).toBe(200);
    expect(uploadMedia).toHaveBeenCalledOnce();
  });
});
