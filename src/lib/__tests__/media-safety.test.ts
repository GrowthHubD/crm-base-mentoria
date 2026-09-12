/**
 * O que a rota pública de mídia recusa e como ela devolve cada tipo.
 *
 * Duas falhas reais por trás destes casos: o backup do banco alcançável pela
 * rota de mídia (chave previsível no mesmo bucket) e HTML enviado pelo upload
 * voltando como documento ativo na origem do CRM.
 */
import { describe, it, expect } from 'vitest';
import { isReservedMediaKey, isActiveContentMime, mediaResponseHeaders } from '@/lib/media-safety';

describe('isReservedMediaKey', () => {
  it('bloqueia a família de chaves do backup, com ou sem barra inicial', () => {
    expect(isReservedMediaKey('backups')).toBe(true);
    expect(isReservedMediaKey('backups/cliente_acme/2026-09-11-07-00-00.ndjson')).toBe(true);
    expect(isReservedMediaKey('/backups/x.ndjson')).toBe(true);
  });

  it('não confunde mídia legítima cujo nome contém a palavra', () => {
    expect(isReservedMediaKey('composer/1-backups.png')).toBe(false);
    expect(isReservedMediaKey('whatsapp/image/foto.jpg')).toBe(false);
    expect(isReservedMediaKey('backupsXYZ/a.png')).toBe(false);
  });
});

describe('isActiveContentMime', () => {
  it('reconhece conteúdo que o navegador executaria como documento', () => {
    expect(isActiveContentMime('text/html')).toBe(true);
    expect(isActiveContentMime('text/html; charset=utf-8')).toBe(true);
    expect(isActiveContentMime('image/svg+xml')).toBe(true);
    expect(isActiveContentMime('application/javascript')).toBe(true);
  });

  it('deixa passar o que se manda por WhatsApp', () => {
    expect(isActiveContentMime('image/png')).toBe(false);
    expect(isActiveContentMime('application/pdf')).toBe(false);
    expect(isActiveContentMime('audio/ogg')).toBe(false);
    expect(isActiveContentMime('application/octet-stream')).toBe(false);
    expect(isActiveContentMime(undefined)).toBe(false);
  });
});

describe('mediaResponseHeaders', () => {
  it('imagem/áudio/vídeo/PDF vão inline, sempre com nosniff', () => {
    for (const mime of ['image/png', 'audio/ogg', 'video/mp4', 'application/pdf']) {
      const h = mediaResponseHeaders(mime);
      expect(h['Content-Type']).toBe(mime);
      expect(h['Content-Disposition']).toBe('inline');
      expect(h['X-Content-Type-Options']).toBe('nosniff');
      expect(h['Content-Security-Policy']).toBeUndefined();
    }
  });

  it('conteúdo ativo nunca sai com o próprio tipo: vira octet-stream + download + sandbox', () => {
    const h = mediaResponseHeaders('text/html; charset=utf-8');
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h['Content-Disposition']).toBe('attachment');
    expect(h['Content-Security-Policy']).toBe('sandbox');
  });

  it('documento comum mantém o tipo mas vai como download', () => {
    const h = mediaResponseHeaders('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(h['Content-Type']).toContain('wordprocessingml');
    expect(h['Content-Disposition']).toBe('attachment');
  });

  it('sem tipo conhecido cai em octet-stream + download', () => {
    const h = mediaResponseHeaders(undefined, { 'Cache-Control': 'x' });
    expect(h['Content-Type']).toBe('application/octet-stream');
    expect(h['Content-Disposition']).toBe('attachment');
    expect(h['Cache-Control']).toBe('x');
  });
});
