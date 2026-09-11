import { describe, it, expect } from 'vitest';
import { parseSupportOutput } from '@/modules/ai-agent/support';

describe('parseSupportOutput', () => {
  it('separa conselho e rascunho com marcadores', () => {
    const raw = [
      '[CONSELHO]',
      'Sugiro fechar com pix de 50%. Ele já quer o plano X.',
      '',
      '[CLIENTE]',
      'Pra garantir sua vaga, é só um pix de 50%. Que horas você chega?',
    ].join('\n');
    const { advice, draft } = parseSupportOutput(raw);
    expect(advice).toBe('Sugiro fechar com pix de 50%. Ele já quer o plano X.');
    expect(draft).toBe('Pra garantir sua vaga, é só um pix de 50%. Que horas você chega?');
  });

  it('sem marcador [CLIENTE]: tudo vira conselho, draft vazio', () => {
    const raw = '[CONSELHO]\nEsse lead está frio, não vale forçar agora.';
    const { advice, draft } = parseSupportOutput(raw);
    expect(advice).toBe('Esse lead está frio, não vale forçar agora.');
    expect(draft).toBe('');
  });

  it('"(sem rascunho)" explícito zera o draft', () => {
    const raw = '[CONSELHO]\nPergunta interna, sem mensagem pro cliente.\n[CLIENTE]\n(sem rascunho)';
    const { advice, draft } = parseSupportOutput(raw);
    expect(advice).toBe('Pergunta interna, sem mensagem pro cliente.');
    expect(draft).toBe('');
  });

  it('tolera marcadores sem o [CONSELHO] inicial', () => {
    const raw = 'Sugiro confirmar o horário.\n[CLIENTE]\nQue horas você pretende chegar?';
    const { advice, draft } = parseSupportOutput(raw);
    expect(advice).toBe('Sugiro confirmar o horário.');
    expect(draft).toBe('Que horas você pretende chegar?');
  });

  it('tolera variações de caixa/espaço nos marcadores', () => {
    const raw = '[ conselho ]\nFaça X.\n[ Cliente ]\nOlá, tudo bem?';
    const { advice, draft } = parseSupportOutput(raw);
    expect(advice).toBe('Faça X.');
    expect(draft).toBe('Olá, tudo bem?');
  });
});
