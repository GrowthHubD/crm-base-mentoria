/**
 * Ordem das colunas do board.
 *
 * O que se protege aqui é o que o usuário NÃO está vendo quando arrasta: a
 * faixa mostra um recorte, e a posição vale para o quadro inteiro. Um
 * reordenamento que mexe na posição relativa das ocultas, ou que apaga a
 * configuração de escalação ao salvar, é um estrago silencioso — aparece dias
 * depois, como "o card parou de escalar".
 */
import { describe, it, expect } from 'vitest';
import {
  colunasDaFaixa,
  moverColuna,
  moverVizinho,
  definirVisibilidade,
  paraPut,
} from '../stage-order';
import type { StageColumn } from '../types';

function col(over: Partial<StageColumn> & Pick<StageColumn, 'id' | 'position'>): StageColumn {
  return {
    status: 'attending',
    isCustom: true,
    label: over.id,
    color: '#8B5CF6',
    visible: true,
    escalateAfterMinutes: null,
    escalateToStageId: null,
    ...over,
  };
}

/**
 * Um quadro realista: as três filas de fábrica, duas personalizadas, uma
 * oculta no meio e as duas de leitura no fim (que não aparecem na faixa).
 */
const QUADRO: StageColumn[] = [
  col({ id: 'novos', status: 'new', isCustom: false, position: 0 }),
  col({ id: 'prio', status: 'priority', isCustom: false, position: 1, visible: false }),
  col({ id: 'urg', status: 'urgency', isCustom: false, position: 2 }),
  col({ id: 'proposta', position: 3 }),
  col({ id: 'reuniao', position: 4 }),
  col({ id: 'resp', status: 'attending', isCustom: false, position: 5 }),
  col({ id: 'conv', status: 'converted', isCustom: false, position: 6 }),
];

const ids = (l: StageColumn[]) => l.map((s) => s.id);

describe('colunasDaFaixa', () => {
  it('leva as filas de fábrica e as personalizadas, sem as de leitura', () => {
    expect(ids(colunasDaFaixa(QUADRO))).toEqual(['novos', 'urg', 'proposta', 'reuniao']);
  });

  it('não desenha coluna oculta', () => {
    expect(ids(colunasDaFaixa(QUADRO))).not.toContain('prio');
  });
});

describe('moverColuna', () => {
  it('arrasta para a direita: assume o lugar do alvo e ele recua', () => {
    const r = moverColuna(QUADRO, 'proposta', 'reuniao');
    expect(ids(r)).toEqual(['novos', 'prio', 'urg', 'reuniao', 'proposta', 'resp', 'conv']);
  });

  it('arrasta para a esquerda: assume o lugar do alvo e ele avança', () => {
    const r = moverColuna(QUADRO, 'reuniao', 'novos');
    expect(ids(r)).toEqual(['reuniao', 'novos', 'prio', 'urg', 'proposta', 'resp', 'conv']);
  });

  it('soltar sobre si mesma não muda nada', () => {
    expect(moverColuna(QUADRO, 'proposta', 'proposta')).toBe(QUADRO);
  });

  it('id desconhecido não muda nada', () => {
    expect(moverColuna(QUADRO, 'nao-existe', 'novos')).toBe(QUADRO);
    expect(moverColuna(QUADRO, 'novos', 'nao-existe')).toBe(QUADRO);
  });

  it('renumera de 0 a n-1, sem buraco e sem repetida', () => {
    const r = moverColuna(QUADRO, 'reuniao', 'novos');
    expect(r.map((s) => s.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('lê a ordem pela posição, não pela ordem do array', () => {
    // O servidor devolve ordenado, mas a tela remonta a lista depois de criar e
    // de esconder coluna. Confiar na ordem do array faria o arraste embaralhar.
    const embaralhado = [...QUADRO].reverse();
    expect(ids(moverColuna(embaralhado, 'proposta', 'reuniao'))).toEqual(
      ids(moverColuna(QUADRO, 'proposta', 'reuniao'))
    );
  });

  it('preserva a posição relativa do que não está na faixa', () => {
    // O caso que motiva a função: a oculta `prio` e as de leitura seguem entre
    // as mesmas vizinhas depois do arraste.
    const r = ids(moverColuna(QUADRO, 'reuniao', 'urg'));
    expect(r.indexOf('prio')).toBe(r.indexOf('novos') + 1);
    expect(r.indexOf('conv')).toBe(r.indexOf('resp') + 1);
    expect(r[r.length - 1]).toBe('conv');
  });

  it('preserva escalação ao reordenar', () => {
    const comEscala = QUADRO.map((s) =>
      s.id === 'novos' ? { ...s, escalateAfterMinutes: 15, escalateToStageId: 'urg' } : s
    );
    const r = moverColuna(comEscala, 'reuniao', 'novos');
    const novos = r.find((s) => s.id === 'novos')!;
    expect(novos.escalateAfterMinutes).toBe(15);
    expect(novos.escalateToStageId).toBe('urg');
  });
});

describe('moverVizinho', () => {
  it('anda uma casa para a direita na faixa', () => {
    expect(ids(colunasDaFaixa(moverVizinho(QUADRO, 'novos', 1)))).toEqual([
      'urg', 'novos', 'proposta', 'reuniao',
    ]);
  });

  it('anda uma casa para a esquerda na faixa', () => {
    expect(ids(colunasDaFaixa(moverVizinho(QUADRO, 'reuniao', -1)))).toEqual([
      'novos', 'urg', 'reuniao', 'proposta',
    ]);
  });

  it('pula a coluna oculta em vez de parecer travada', () => {
    // Entre `novos` e `urg` existe a oculta `prio`. Um passo tem que trocar as
    // duas visíveis, não empurrar `novos` para cima de algo invisível.
    const r = moverVizinho(QUADRO, 'novos', 1);
    expect(ids(colunasDaFaixa(r))[0]).toBe('urg');
  });

  it('na ponta não faz nada', () => {
    expect(moverVizinho(QUADRO, 'novos', -1)).toBe(QUADRO);
    expect(moverVizinho(QUADRO, 'reuniao', 1)).toBe(QUADRO);
  });

  it('coluna fora da faixa não anda', () => {
    expect(moverVizinho(QUADRO, 'resp', -1)).toBe(QUADRO);
  });
});

describe('definirVisibilidade', () => {
  it('esconde só a coluna pedida', () => {
    const r = definirVisibilidade(QUADRO, 'urg', false);
    expect(r.find((s) => s.id === 'urg')!.visible).toBe(false);
    expect(r.filter((s) => s.visible).length).toBe(QUADRO.filter((s) => s.visible).length - 1);
  });

  it('traz de volta a que estava oculta', () => {
    expect(definirVisibilidade(QUADRO, 'prio', true).find((s) => s.id === 'prio')!.visible).toBe(true);
  });
});

describe('paraPut', () => {
  it('leva os campos de escalação junto', () => {
    const comEscala = definirVisibilidade(QUADRO, 'novos', true).map((s) =>
      s.id === 'novos' ? { ...s, escalateAfterMinutes: 15, escalateToStageId: 'urg' } : s
    );
    const item = paraPut(comEscala).find((s) => s.id === 'novos')!;
    expect(item).toMatchObject({ escalateAfterMinutes: 15, escalateToStageId: 'urg' });
  });

  it('manda o quadro inteiro, inclusive o que não está na faixa', () => {
    // O PUT grava a lista completa: mandar só o recorte apagaria o resto.
    expect(paraPut(QUADRO)).toHaveLength(QUADRO.length);
  });
});
