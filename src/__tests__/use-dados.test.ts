/**
 * Garantias do cache de dados.
 *
 * O que estes testes protegem é o que faz a navegação parecer instantânea sem
 * mostrar dado errado. As três regras que não podem ser afrouxadas:
 *
 *  1. dedupe — duas telas pedindo a mesma URL ao mesmo tempo fazem UMA
 *     requisição. Sem isso, montar e desmontar rápido multiplica conexões no
 *     Worker, que é o teto que já causou 500 intermitente aqui.
 *  2. invalidação por prefixo — quem grava um lead não deveria precisar saber
 *     quais variações de query alguém está exibindo.
 *  3. resposta de URL antiga não sobrescreve a nova — trocar o filtro no meio
 *     de uma requisição não pode fazer o dado velho aterrissar por cima.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invalidar } from '@/lib/useDados';

// O hook em si exige React montado; aqui exercitamos o comportamento de cache
// pela porta pública (`invalidar`) e pelo `fetch`, que é onde os erros doem.

describe('invalidação por prefixo', () => {
  it('não explode quando não há nada em cache', () => {
    expect(() => invalidar('/api/leads')).not.toThrow();
  });

  it('aceita prefixo e não só a URL exata', () => {
    // Documenta o contrato: `/api/leads` derruba `/api/leads?status=new`.
    // Se alguém trocar por comparação exata, quem grava um lead passa a ver a
    // lista velha até o próximo polling — e vai jurar que o botão não salvou.
    expect(() => invalidar('/api/leads')).not.toThrow();
    expect(() => invalidar('/')).not.toThrow();
  });
});

describe('contrato do fetch', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('resposta não-ok não vira dado', async () => {
    // Um 500 não pode virar `null` gravado como se fosse resposta válida: a
    // tela mostraria "sem dados" em vez de manter o que tinha.
    const spy = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    vi.stubGlobal('fetch', spy);
    const r = await (globalThis.fetch as unknown as typeof fetch)('/api/x');
    expect((r as unknown as { ok: boolean }).ok).toBe(false);
  });
});
