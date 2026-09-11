/**
 * Quem enxerga a conversa de quem.
 *
 * Este é o módulo que fecha um vazamento REAL: um BDR recém-criado abriu o CRM
 * e estava vendo as conversas do número do admin. Os testes aqui existem para
 * que a regressão apareça como teste vermelho e não como um cliente
 * descobrindo a carteira do colega.
 *
 * A assimetria dos erros guia o que se testa: mostrar de menos é um bug que
 * alguém reclama; mostrar de mais é um vazamento que ninguém vê. Por isso a
 * ênfase está nos casos em que o filtro poderia sumir — módulo desligado,
 * papel desconhecido, dono nulo.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { escopoDono, escopoPorDonoAtivo, rotuloDoPapel } from '../escopo-dono';

const FLAG = 'FEATURE_LEAD_OWNERSHIP';
const LABEL = 'ROLE_ATTENDANT_LABEL';
const ORIGINAIS = { flag: process.env[FLAG], label: process.env[LABEL] };

function ligar(v?: string) {
  if (v === undefined) delete process.env[FLAG];
  else process.env[FLAG] = v;
}

afterEach(() => {
  ligar(ORIGINAIS.flag);
  if (ORIGINAIS.label === undefined) delete process.env[LABEL];
  else process.env[LABEL] = ORIGINAIS.label;
});

const ADMIN = { id: 'u-admin', role: 'admin' as const };
const BDR = { id: 'u-bdr', role: 'attendant' as const };

describe('escopoPorDonoAtivo', () => {
  it.each(['1', 'true', 'TRUE', 'on'])('liga com %s', (v) => {
    ligar(v);
    expect(escopoPorDonoAtivo()).toBe(true);
  });

  it.each(['0', 'false', 'off', '', 'sim'])('fica desligado com %s', (v) => {
    ligar(v);
    expect(escopoPorDonoAtivo()).toBe(false);
  });

  it('desligado quando a variável não existe', () => {
    ligar(undefined);
    expect(escopoPorDonoAtivo()).toBe(false);
  });
});

describe('escopoDono — módulo DESLIGADO', () => {
  // Os seis clientes de atendimento vivem aqui. A fila deles é compartilhada
  // de propósito: qualquer atendente pega o próximo. Um recorte que vazasse
  // para cá quebraria a operação de quem não pediu nada.
  it('ninguém filtra nada, nem o atendente', () => {
    ligar('false');
    expect(escopoDono(BDR)).toEqual({ ownerId: null, veTudo: true });
    expect(escopoDono(ADMIN)).toEqual({ ownerId: null, veTudo: true });
  });
});

describe('escopoDono — módulo LIGADO', () => {
  it('admin vê tudo', () => {
    ligar('true');
    expect(escopoDono(ADMIN)).toEqual({ ownerId: null, veTudo: true });
  });

  it('BDR fica preso ao próprio id', () => {
    ligar('true');
    expect(escopoDono(BDR)).toEqual({ ownerId: 'u-bdr', veTudo: false });
  });

  it('papel desconhecido é tratado como BDR, não como admin', () => {
    // Fail-closed: se um papel novo aparecer no enum e ninguém lembrar deste
    // arquivo, ele entra restrito. O erro cai do lado barato.
    ligar('true');
    const estranho = { id: 'u-x', role: 'supervisor' as unknown as 'admin' };
    expect(escopoDono(estranho)).toEqual({ ownerId: 'u-x', veTudo: false });
  });

  it('o recorte é o id de quem está logado, não algo que se possa pedir', () => {
    // `escopoDono` não recebe nada além do usuário — é o que garante que um
    // cabeçalho ou query string não consiga ampliar a visão.
    ligar('true');
    expect(escopoDono.length).toBe(1);
  });
});

describe('rotuloDoPapel', () => {
  it('admin é sempre Administrador', () => {
    process.env[LABEL] = 'BDR';
    expect(rotuloDoPapel('admin')).toBe('Administrador');
  });

  it('usa a etiqueta desta instalação', () => {
    process.env[LABEL] = 'BDR';
    expect(rotuloDoPapel('attendant')).toBe('BDR');
  });

  it('sem etiqueta configurada, segue Atendente', () => {
    // Os clientes de atendimento não passam a variável — não podem ver o nome
    // do papel mudar por causa de um deploy feito para outro cliente.
    delete process.env[LABEL];
    expect(rotuloDoPapel('attendant')).toBe('Atendente');
  });

  it('etiqueta em branco não vira papel sem nome', () => {
    process.env[LABEL] = '   ';
    expect(rotuloDoPapel('attendant')).toBe('Atendente');
  });
});
