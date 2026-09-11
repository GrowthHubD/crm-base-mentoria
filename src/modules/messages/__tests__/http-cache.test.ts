import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { messageWindowEtag, requestHasMessageEtag } from '../http-cache';

describe('revalidacao HTTP do historico', () => {
  it('mantem o ETag estavel para o mesmo payload', () => {
    const payload = JSON.stringify({ messages: [{ id: 'm1', status: 'sent' }], hasMore: false });
    expect(messageWindowEtag(payload)).toBe(messageWindowEtag(payload));
  });

  it.each([
    ['conteudo', { id: 'm1', body: 'novo', status: 'sent', reactions: [] }],
    ['status', { id: 'm1', body: 'oi', status: 'read', reactions: [] }],
    ['reacao', { id: 'm1', body: 'oi', status: 'sent', reactions: [{ emoji: '👍' }] }],
    ['exclusao', null],
  ])('muda o ETag depois de %s', (_case, changed) => {
    const original = JSON.stringify({
      messages: [{ id: 'm1', body: 'oi', status: 'sent', reactions: [] }],
      hasMore: false,
    });
    const next = JSON.stringify({ messages: changed ? [changed] : [], hasMore: false });
    expect(messageWindowEtag(next)).not.toBe(messageWindowEtag(original));
  });

  it('reconhece ETag isolado ou presente numa lista', () => {
    const etag = messageWindowEtag('{"messages":[]}');
    expect(requestHasMessageEtag(etag, etag)).toBe(true);
    expect(requestHasMessageEtag(`"outro", ${etag}`, etag)).toBe(true);
    expect(requestHasMessageEtag('"outro"', etag)).toBe(false);
    expect(requestHasMessageEtag(null, etag)).toBe(false);
  });

  it('a rota responde sem corpo e o chat trata 304 antes de ler JSON', () => {
    const root = process.cwd();
    const route = readFileSync(join(root, 'src/app/api/leads/[id]/messages/route.ts'), 'utf8');
    const chat = readFileSync(join(root, 'src/components/crm/ChatPanel.tsx'), 'utf8');

    expect(route).toContain('new NextResponse(null, { status: 304');
    expect(route).toContain("'Cache-Control': 'private, no-cache'");
    expect(chat).toContain("'If-None-Match': messageEtagRef.current.value");
    expect(chat.indexOf('if (res.status === 304)')).toBeLessThan(chat.indexOf('await res.json()'));
  });
});
