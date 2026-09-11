import { createHash } from 'node:crypto';

/**
 * Identidade forte do JSON exato devolvido pelo histórico. Qualquer mudança
 * visual na janela, inclusive edição, status, reação ou exclusão, altera o ETag.
 */
export function messageWindowEtag(payload: string): string {
  const digest = createHash('sha256').update(payload).digest('base64url');
  return `"${digest}"`;
}

/** Aceita a lista definida pelo padrão HTTP e o curinga usado por alguns clientes. */
export function requestHasMessageEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === '*' || candidate === etag);
}
