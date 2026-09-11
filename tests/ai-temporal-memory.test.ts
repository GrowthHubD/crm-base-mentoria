import { describe, it, expect } from 'vitest';
import {
  relativeTimeLabel,
  computeReturnGapMs,
  forgetStaleHistory,
} from '@/modules/ai-agent/prompts';
import type { Message } from '@/modules/messages/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Mensagem mínima só com o que os helpers temporais leem. */
function msg(offsetMsFromBase: number, sender: Message['sender'] = 'lead'): Message {
  const base = new Date('2026-08-01T12:00:00Z').getTime();
  return {
    id: `m-${offsetMsFromBase}`,
    sender,
    timestamp: new Date(base + offsetMsFromBase),
  } as Message;
}

describe('relativeTimeLabel', () => {
  it('marca o instante mais recente como "agora"', () => {
    expect(relativeTimeLabel(0)).toBe('agora');
    expect(relativeTimeLabel(30_000)).toBe('agora');
  });

  it('cobre a escala inteira em PT-BR', () => {
    expect(relativeTimeLabel(5 * MIN)).toBe('há 5 min');
    expect(relativeTimeLabel(3 * HOUR)).toBe('há 3h');
    expect(relativeTimeLabel(DAY)).toBe('ontem');
    expect(relativeTimeLabel(3 * DAY)).toBe('há 3 dias');
    expect(relativeTimeLabel(7 * DAY)).toBe('há 1 semana');
    expect(relativeTimeLabel(40 * DAY)).toBe('há 1 mês');
    expect(relativeTimeLabel(400 * DAY)).toBe('há 1 ano');
  });
});

describe('computeReturnGapMs', () => {
  it('devolve 0 quando não há histórico anterior', () => {
    expect(computeReturnGapMs([])).toBe(0);
    expect(computeReturnGapMs([msg(0)])).toBe(0);
  });

  it('ignora a rajada atual e mede o silêncio real', () => {
    // Conversa antiga, depois 3 mensagens seguidas agora. O gap é medido da
    // mensagem MAIS RECENTE da rajada até a última mensagem anterior a ela.
    const history = [
      msg(0),
      msg(10 * DAY),
      msg(10 * DAY + MIN),
      msg(10 * DAY + 2 * MIN),
    ];
    expect(computeReturnGapMs(history)).toBe(10 * DAY + 2 * MIN);
  });

  it('não confunde conversa contínua com retorno', () => {
    const history = [msg(0), msg(2 * MIN), msg(4 * MIN)];
    expect(computeReturnGapMs(history)).toBe(0);
  });
});

describe('forgetStaleHistory', () => {
  it('mantém o histórico quando o cliente volta dentro da janela', () => {
    const history = [msg(0), msg(2 * DAY)];
    expect(forgetStaleHistory(history)).toHaveLength(2);
  });

  it('descarta o histórico antigo após 7 dias de silêncio', () => {
    const history = [msg(0, 'lead'), msg(0 + MIN, 'ai'), msg(30 * DAY, 'lead')];
    const kept = forgetStaleHistory(history);
    expect(kept).toHaveLength(1);
    expect(kept[0].timestamp.getTime()).toBe(history[2].timestamp.getTime());
  });

  it('preserva a rajada atual inteira ao esquecer', () => {
    const history = [msg(0), msg(30 * DAY), msg(30 * DAY + 2 * MIN)];
    expect(forgetStaleHistory(history)).toHaveLength(2);
  });

  it('aceita histórico vazio sem estourar', () => {
    expect(forgetStaleHistory([])).toEqual([]);
  });
});
