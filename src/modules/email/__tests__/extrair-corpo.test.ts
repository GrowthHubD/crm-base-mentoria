import { describe, it, expect } from 'vitest';
import { extrairCorpo } from '../gmail-client';

const b64u = (s: string) =>
  Buffer.from(s, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('extrairCorpo (Gmail format=full)', () => {
  it('mensagem simples: corpo no proprio payload', () => {
    const p = { mimeType: 'text/plain', body: { data: b64u('Olá, tudo bem?\r\nSegue proposta.') } };
    expect(extrairCorpo(p)).toBe('Olá, tudo bem?\nSegue proposta.');
  });

  it('multipart/alternative: prefere text/plain ao html', () => {
    const p = { mimeType: 'multipart/alternative', parts: [
      { mimeType: 'text/plain', body: { data: b64u('texto puro') } },
      { mimeType: 'text/html', body: { data: b64u('<p>html</p>') } },
    ] };
    expect(extrairCorpo(p)).toBe('texto puro');
  });

  it('so html: converte para texto com quebras e sem tags', () => {
    const p = { mimeType: 'text/html', body: { data: b64u('<div>Linha 1</div><div>Linha &amp; 2</div><style>x{}</style>') } };
    expect(extrairCorpo(p)).toBe('Linha 1\nLinha & 2');
  });

  it('aninhado (mixed > alternative): acha o text/plain la dentro', () => {
    const p = { mimeType: 'multipart/mixed', parts: [
      { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64u('fundo') } }] },
      { mimeType: 'application/pdf', body: { size: 999 } },
    ] };
    expect(extrairCorpo(p)).toBe('fundo');
  });

  it('e-mail longo NAO e cortado no tamanho de snippet', () => {
    expect(extrairCorpo({ mimeType: 'text/plain', body: { data: b64u('a'.repeat(5000)) } })).toHaveLength(5000);
  });

  it('acima de 20k: trunca com aviso', () => {
    const r = extrairCorpo({ mimeType: 'text/plain', body: { data: b64u('b'.repeat(30000)) } });
    expect(r.startsWith('b'.repeat(20000))).toBe(true);
    expect(r).toContain('[… mensagem truncada]');
  });

  it('sem parte de texto (so anexo) => vazio, chamador usa snippet', () => {
    expect(extrairCorpo({ mimeType: 'application/pdf', body: { size: 1 } })).toBe('');
    expect(extrairCorpo(undefined)).toBe('');
  });
});
