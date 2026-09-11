/**
 * O flag que decide se o card anda sozinho.
 *
 * Vale um teste apesar de trivial: ele é lido em `setLeadStatus`, no caminho de
 * TODA mudança de status das sete instalações. Ligar por engano num cliente de
 * atendimento congelaria a fila dele — os cards parariam de voltar para "Novos"
 * quando o cliente responde, e ninguém veria quem está esperando. Por isso o
 * padrão precisa ser "desligado" mesmo com a variável ausente, vazia ou com
 * lixo dentro.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cardsSoPorArraste } from '../modo';

const ORIGINAL = process.env.FEATURE_KANBAN_MANUAL;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FEATURE_KANBAN_MANUAL;
  else process.env.FEATURE_KANBAN_MANUAL = ORIGINAL;
});

describe('cardsSoPorArraste', () => {
  it.each(['1', 'true', 'TRUE', 'on', ' true '])('liga com %s', (v) => {
    process.env.FEATURE_KANBAN_MANUAL = v;
    expect(cardsSoPorArraste()).toBe(true);
  });

  it.each(['0', 'false', 'off', '', 'sim', 'yes', 'talvez'])('fica desligado com %s', (v) => {
    // "sim"/"yes" desligados de propósito: o flag aceita um vocabulário
    // pequeno e conhecido. Aceitar variações seria adivinhar a intenção de
    // quem digitou, e o erro cai do lado caro.
    process.env.FEATURE_KANBAN_MANUAL = v;
    expect(cardsSoPorArraste()).toBe(false);
  });

  it('fica desligado quando a variável não existe', () => {
    delete process.env.FEATURE_KANBAN_MANUAL;
    expect(cardsSoPorArraste()).toBe(false);
  });
});
