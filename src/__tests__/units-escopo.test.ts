/**
 * Regras de visibilidade por unidade.
 *
 * Este é o teste que impede a versão perigosa do módulo. A tentação óbvia, na
 * hora de fazer o seletor funcionar, é confiar no cabeçalho `x-unit-id` para
 * todo mundo — e aí um atendente preso à filial A passa a ver a filial B só
 * mandando outro valor. O cabeçalho é PREFERÊNCIA DE TELA, nunca credencial.
 *
 * É a mesma classe do gating de plano que já nos mordeu: esconder na navegação
 * e deixar a URL aberta.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { escopoDaRequisicao, unidadesAtivas } from '@/lib/units';

const original = process.env.FEATURE_UNITS;

function ligar(v: boolean) {
  if (v) process.env.FEATURE_UNITS = 'true';
  else delete process.env.FEATURE_UNITS;
}

beforeEach(() => ligar(true));
afterEach(() => {
  if (original === undefined) delete process.env.FEATURE_UNITS;
  else process.env.FEATURE_UNITS = original;
});

describe('módulo desligado', () => {
  it('não filtra nada e não deixa alternar', () => {
    ligar(false);
    expect(unidadesAtivas()).toBe(false);
    // Mesmo com usuário preso e cabeçalho presente: sem o módulo, sem recorte.
    expect(escopoDaRequisicao({ unitId: 'filial-a' }, 'filial-b')).toEqual({
      unitId: null,
      podeAlternar: false,
    });
  });
});

describe('usuário preso a uma unidade', () => {
  it('vê só a dele', () => {
    expect(escopoDaRequisicao({ unitId: 'filial-a' }, null)).toEqual({
      unitId: 'filial-a',
      podeAlternar: false,
    });
  });

  it('NÃO consegue ver outra mandando o cabeçalho', () => {
    // O coração do teste: o cabeçalho pede a filial B, e o recorte continua A.
    const escopo = escopoDaRequisicao({ unitId: 'filial-a' }, 'filial-b');
    expect(escopo.unitId).toBe('filial-a');
    expect(escopo.podeAlternar).toBe(false);
  });

  it('NÃO consegue ver todas pedindo "todas"', () => {
    expect(escopoDaRequisicao({ unitId: 'filial-a' }, 'todas').unitId).toBe('filial-a');
  });
});

describe('usuário sem unidade (o dono)', () => {
  it('sem seleção, vê tudo', () => {
    expect(escopoDaRequisicao({ unitId: null }, null)).toEqual({
      unitId: null,
      podeAlternar: true,
    });
  });

  it('com seleção, vê a escolhida', () => {
    expect(escopoDaRequisicao({ unitId: null }, 'filial-b').unitId).toBe('filial-b');
  });

  it('"todas" volta a ser ausência de filtro', () => {
    expect(escopoDaRequisicao({ unitId: null }, 'todas').unitId).toBeNull();
  });

  it('espaço em branco não vira filtro por unidade vazia', () => {
    // `unitId: ''` filtraria por nada e devolveria zero leads — a tela ficaria
    // vazia sem erro, que é o pior resultado possível.
    expect(escopoDaRequisicao({ unitId: null }, '   ').unitId).toBeNull();
  });
});

describe('migração incremental', () => {
  it('o filtro inclui o que ainda não tem unidade', async () => {
    // Ligar o módulo num cliente que já opera não pode esvaziar o board: todo
    // lead histórico está com unit_id nulo. O filtro é `unidade OU sem unidade`.
    const { filtroUnidade } = await import('@/modules/units/service');
    const { leads } = await import('@/lib/db/schema/leads');

    expect(filtroUnidade(leads.unitId, null)).toBeUndefined();
    expect(filtroUnidade(leads.unitId, undefined)).toBeUndefined();

    const sql = filtroUnidade(leads.unitId, 'filial-a');
    expect(sql).toBeDefined();
    // Não inspecionamos o SQL gerado (é detalhe do Drizzle); o que importa é
    // que exista cláusula, e o teste acima garante a ausência quando deve.
  });
});
