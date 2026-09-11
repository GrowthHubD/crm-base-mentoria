/**
 * O backup precisa cair numa pasta POR CLIENTE.
 *
 * Todos os deploys compartilham o mesmo bucket R2. Enquanto a chave era só
 * `backups/<timestamp>.ndjson`, os sete clientes escreviam na mesma pasta com
 * nome derivado só da hora — e como todos os crons disparam no mesmo minuto,
 * dois backups no mesmo segundo faziam o segundo `put` sobrescrever o
 * primeiro. Sem erro, sem log de falha: o cliente sobrescrito simplesmente
 * ficava sem backup, e só se descobriria na hora de restaurar.
 *
 * Este teste existe para que ninguém volte o prefixo para uma constante.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { defaultPrefix } from '../service';

const original = process.env.DB_SCHEMA;

afterEach(() => {
  if (original === undefined) delete process.env.DB_SCHEMA;
  else process.env.DB_SCHEMA = original;
});

describe('defaultPrefix', () => {
  it('isola o backup na pasta do cliente', () => {
    process.env.DB_SCHEMA = 'cliente_acme';
    expect(defaultPrefix()).toBe('backups/cliente_acme');
  });

  it('clientes diferentes NUNCA compartilham pasta', () => {
    process.env.DB_SCHEMA = 'cliente_acme';
    const acme = defaultPrefix();
    process.env.DB_SCHEMA = 'cliente_acme';
    const acme4 = defaultPrefix();

    expect(acme).not.toBe(acme4);
  });

  it('sem DB_SCHEMA cai na raiz — não quebra instalação antiga', () => {
    delete process.env.DB_SCHEMA;
    expect(defaultPrefix()).toBe('backups');
  });

  it('ignora espaço em volta do valor', () => {
    // Um espaço sobrando no wrangler.jsonc criaria uma pasta "backups/ x",
    // que parece isolada mas não é a mesma que "backups/x" na restauração.
    process.env.DB_SCHEMA = '  cliente_iaxo  ';
    expect(defaultPrefix()).toBe('backups/cliente_iaxo');
  });

  it('string vazia é tratada como ausente', () => {
    process.env.DB_SCHEMA = '';
    expect(defaultPrefix()).toBe('backups');
  });
});
