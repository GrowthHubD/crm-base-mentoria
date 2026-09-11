/**
 * Regras da configuração de colunas.
 *
 * O que se protege aqui é a tela do cliente: uma configuração inválida salva
 * com sucesso vira kanban quebrado em produção, e o sintoma ("sumiram meus
 * leads") não aponta para a causa. Por isso a validação recusa antes de gravar,
 * com mensagem que diz QUAL coluna está errada.
 */
import { describe, it, expect } from 'vitest';
import { validarStages, StageValidationError, type StageView } from '../stages';

const EXISTENTES: StageView[] = [
  { id: 'id-new', status: 'new', isCustom: false, label: 'Novos', color: '#9154FF', position: 0, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
  { id: 'id-prio', status: 'priority', isCustom: false, label: 'Prioridade', color: '#F59E0B', position: 1, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
  { id: 'id-custom', status: 'attending', isCustom: true, label: 'Proposta', color: '#22C55E', position: 2, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
];

function coluna(
  over: Partial<{
    id: string; label: string; color: string; position: number; visible: boolean;
    escalateAfterMinutes: number | null; escalateToStageId: string | null;
  }> = {}
) {
  return { id: 'id-new', label: 'Novos', color: '#9154FF', position: 0, visible: true, ...over };
}

describe('validarStages', () => {
  it('aceita um quadro válido e normaliza', () => {
    const r = validarStages(
      [coluna(), coluna({ id: 'id-prio', label: '  Quente  ', color: '#F59E0B', position: 1 })],
      EXISTENTES
    );
    expect(r).toHaveLength(2);
    expect(r[1].label).toBe('Quente'); // trim
  });

  it('recusa lista vazia', () => {
    expect(() => validarStages([], EXISTENTES)).toThrow(StageValidationError);
  });

  it('recusa coluna que não existe', () => {
    // Protege contra a tela mandar um id inventado ou de outra instalação.
    expect(() => validarStages([coluna({ id: 'nao-existe' })], EXISTENTES)).toThrow(/desconhecida/i);
  });

  it('recusa a mesma coluna duas vezes', () => {
    expect(() => validarStages([coluna(), coluna({ label: 'Outra' })], EXISTENTES)).toThrow(/duas vezes/i);
  });

  it('recusa nome vazio', () => {
    expect(() => validarStages([coluna({ label: '   ' })], EXISTENTES)).toThrow(/nome/i);
  });

  it('recusa nome longo demais', () => {
    expect(() => validarStages([coluna({ label: 'x'.repeat(41) })], EXISTENTES)).toThrow(/longo/i);
  });

  it.each(['azul', '#FFF', '#GGGGGG', 'rgb(0,0,0)', ''])('recusa cor inválida: %s', (cor) => {
    expect(() => validarStages([coluna({ color: cor })], EXISTENTES)).toThrow(/cor inválida/i);
  });

  it('a mensagem de cor inválida diz QUAL coluna', () => {
    expect(() => validarStages([coluna({ label: 'Urgência', color: 'roxo' })], EXISTENTES)).toThrow(/Urgência/);
  });

  it('recusa esconder todas as colunas', () => {
    // Um quadro sem coluna visível é uma tela em branco sem explicação.
    expect(() =>
      validarStages(
        [coluna({ visible: false }), coluna({ id: 'id-prio', visible: false })],
        EXISTENTES
      )
    ).toThrow(/visível/i);
  });

  it('permite esconder algumas, desde que sobre uma', () => {
    const r = validarStages(
      [coluna({ visible: true }), coluna({ id: 'id-prio', visible: false })],
      EXISTENTES
    );
    expect(r.filter((s) => s.visible)).toHaveLength(1);
  });

  it('aceita configurar coluna personalizada como qualquer outra', () => {
    const r = validarStages([coluna({ id: 'id-custom', label: 'Negociação', color: '#22C55E' })], EXISTENTES);
    expect(r[0].label).toBe('Negociação');
  });

  it('usa o índice quando a posição não é número', () => {
    const r = validarStages(
      [
        coluna({ position: undefined as unknown as number }),
        coluna({ id: 'id-prio', position: undefined as unknown as number }),
      ],
      EXISTENTES
    );
    expect(r.map((s) => s.position)).toEqual([0, 1]);
  });

  it('aceita escalação completa: tempo + destino', () => {
    const r = validarStages(
      [coluna({ escalateAfterMinutes: 15, escalateToStageId: 'id-prio' })],
      EXISTENTES
    );
    expect(r[0].escalateAfterMinutes).toBe(15);
    expect(r[0].escalateToStageId).toBe('id-prio');
  });

  it('recusa tempo de escalação sem destino', () => {
    // Configuração pela metade: o card estouraria o tempo e não teria para onde
    // ir. Melhor recusar do que gravar uma regra que nunca dispara.
    expect(() => validarStages([coluna({ escalateAfterMinutes: 15 })], EXISTENTES)).toThrow(
      /para onde/i
    );
  });

  it('recusa coluna que escala para si mesma', () => {
    // Viraria um card "escalando" para o mesmo lugar a cada passada do cron.
    expect(() =>
      validarStages([coluna({ escalateAfterMinutes: 15, escalateToStageId: 'id-new' })], EXISTENTES)
    ).toThrow(/ela mesma/i);
  });

  it('recusa destino que não existe', () => {
    expect(() =>
      validarStages(
        [coluna({ escalateAfterMinutes: 15, escalateToStageId: 'nao-existe' })],
        EXISTENTES
      )
    ).toThrow(/não existe/i);
  });

  it('destino sem tempo não vira regra', () => {
    // Sem tempo a regra nunca dispararia; guardar o destino sozinho só criaria
    // configuração fantasma na tela.
    const r = validarStages([coluna({ escalateToStageId: 'id-prio' })], EXISTENTES);
    expect(r[0].escalateAfterMinutes).toBeNull();
    expect(r[0].escalateToStageId).toBeNull();
  });

  it('tempo zero ou negativo desliga a escalação', () => {
    expect(validarStages([coluna({ escalateAfterMinutes: 0 })], EXISTENTES)[0].escalateAfterMinutes).toBeNull();
    expect(validarStages([coluna({ escalateAfterMinutes: -5 })], EXISTENTES)[0].escalateAfterMinutes).toBeNull();
  });

  it('aceita hex em maiúscula e minúscula', () => {
    expect(validarStages([coluna({ color: '#aabbcc' })], EXISTENTES)[0].color).toBe('#aabbcc');
    expect(validarStages([coluna({ color: '#AABBCC' })], EXISTENTES)[0].color).toBe('#AABBCC');
  });
});
