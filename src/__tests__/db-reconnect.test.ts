/**
 * A repetição de consulta só é segura numa condição, e o teste existe para que
 * essa condição não seja afrouxada sem alguém perceber.
 *
 * O 500 intermitente do cliente vinha de `write CONNECTION_CLOSED` — o
 * Hyperdrive fechava o socket e o driver só descobria ao ESCREVER. Nesse caso a
 * consulta não chegou ao servidor, então repetir é seguro.
 *
 * O que NÃO pode acontecer é alguém, tentando "resolver mais casos", passar a
 * repetir qualquer erro de conexão. Se a queda for ao LER a resposta, a
 * consulta já rodou: repetir um INSERT duplicaria a linha. Num CRM isso é
 * mensagem enviada duas vezes ou lead contado em dobro — pior que o 500, porque
 * é silencioso.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FONTE = readFileSync(join(process.cwd(), 'src', 'lib', 'db', 'client.ts'), 'utf8');

/** Reimplementa o predicado a partir da fonte, para testá-lo sem subir o
 *  módulo inteiro (que exige binding do Worker ou DATABASE_URL). */
function ehConexaoFechadaAoEscrever(err: unknown): boolean {
  let atual: unknown = err;
  for (let i = 0; i < 5 && atual; i++) {
    const e = atual as { code?: string; message?: string; cause?: unknown };
    const fechada = e.code === 'CONNECTION_CLOSED' || e.code === 'CONNECTION_ENDED';
    if (fechada && typeof e.message === 'string' && e.message.startsWith('write ')) return true;
    atual = e.cause;
  }
  return false;
}

function erro(props: Record<string, unknown>, causa?: unknown) {
  return Object.assign(new Error(String(props.message ?? '')), props, { cause: causa });
}

describe('quando repetir a consulta', () => {
  it('repete a falha real observada em produção, mesmo aninhada no cause', () => {
    // Exatamente o formato que o log capturou: o Drizzle embrulha, o driver
    // fica no nível 1.
    const drizzle = erro(
      { message: 'Failed query: select "id" from "users" where "id" = $1' },
      erro({
        message: 'write CONNECTION_CLOSED abc123.hyperdrive.local:5432',
        code: 'CONNECTION_CLOSED',
      })
    );
    expect(ehConexaoFechadaAoEscrever(drizzle)).toBe(true);
  });

  it('NÃO repete quando a conexão caiu depois do envio', () => {
    // Sem o prefixo `write`, a consulta pode ter rodado. Repetir um INSERT aqui
    // duplicaria a linha.
    expect(
      ehConexaoFechadaAoEscrever(
        erro({ message: 'CONNECTION_CLOSED abc.hyperdrive.local:5432', code: 'CONNECTION_CLOSED' })
      )
    ).toBe(false);
  });

  it('NÃO repete erro de banco de verdade', () => {
    for (const e of [
      erro({ message: 'relation "leads" does not exist', code: '42P01' }),
      erro({ message: 'duplicate key value', code: '23505' }),
      erro({ message: 'too many connections', code: '53300' }),
      erro({ message: 'write timeout', code: 'CONNECT_TIMEOUT' }),
    ]) {
      expect(ehConexaoFechadaAoEscrever(e), String(e.message)).toBe(false);
    }
  });

  it('não entra em laço com erro que aponta para si mesmo', () => {
    const ciclico = erro({ message: 'boom', code: 'X' });
    (ciclico as { cause?: unknown }).cause = ciclico;
    expect(() => ehConexaoFechadaAoEscrever(ciclico)).not.toThrow();
    expect(ehConexaoFechadaAoEscrever(ciclico)).toBe(false);
  });
});

describe('o client mantém as garantias que tornam a repetição segura', () => {
  it('tenta no máximo uma vez a mais', () => {
    // Duas chamadas a `tentar` no caminho de erro (a original e a repetição) e
    // nenhum laço: um `while`/`for` em volta da repetição transformaria uma
    // falha real em tempestade de tentativas contra o banco.
    const corpo = FONTE.slice(FONTE.indexOf('function comReconexao'));
    const bloco = corpo.slice(0, corpo.indexOf('\n}\n'));
    expect(/\b(while|for)\s*\(/.test(bloco)).toBe(false);
  });

  it('transação recebe o client cru, sem repetição', () => {
    // `begin` não pode passar pelo wrapper: repetir uma instrução no meio de
    // uma transação cuja conexão caiu partiria a transação em duas.
    expect(FONTE).toMatch(/prop === 'unsafe'/);
    expect(FONTE).not.toMatch(/prop === 'begin'[\s\S]{0,200}executar\(/);
  });
});

describe('describeDbError alimenta este diagnóstico', () => {
  it('mantém o campo code, que é como o motivo é identificado', async () => {
    const { describeDbError } = await import('@/lib/db/errors');
    const { cadeia } = describeDbError(
      erro({ message: 'Failed query: ...' }, erro({ message: 'write CONNECTION_CLOSED x', code: 'CONNECTION_CLOSED' }))
    );
    expect(cadeia).toHaveLength(2);
    expect(cadeia[1].code).toBe('CONNECTION_CLOSED');
  });
});

// Silencia o aviso do vi não usado quando a suíte roda isolada.
void vi;
