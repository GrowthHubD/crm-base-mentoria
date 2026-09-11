/**
 * A separação comercial entre agendar e fazer follow-up.
 *
 * São dois produtos e o cliente paga por um deles:
 *
 *   agendamento MANUAL — o atendente escreve "Bom dia, conseguiu ver?" e marca
 *     a hora para UM lead. Sem IA, sem automação: é um lembrete entregue no
 *     horário. Faz parte do CRM de atendimento, como o kanban → PLANO BASE.
 *
 *   follow-up AUTOMÁTICO — o sistema decide sozinho o que mandar, lendo o
 *     contexto da conversa, e dispara por inatividade do lead → ADD-ON PAGO.
 *
 * Estavam sob a MESMA flag, e invertidos: o agendamento manual nascia
 * desligado, como se fosse o produto caro. Cliente do plano base ficava sem a
 * tela de agendamento que já tinha comprado.
 *
 * Este teste existe porque juntar os dois de novo é a simplificação tentadora
 * — "os dois mandam mensagem depois, é a mesma coisa". Não é: o que se cobra
 * no follow-up é a automação e a leitura de contexto, não a entrega programada.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readPlanFeatures, FEATURE_LABELS, isPathAllowed, BASE_PLAN } from '@/lib/plan';

const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

describe('agendamento manual é do plano base', () => {
  it('vem LIGADO quando ninguém configurou nada', () => {
    delete process.env.FEATURE_SCHEDULING;
    expect(readPlanFeatures().scheduling).toBe(true);
  });

  it('só some se alguém desligar de propósito', () => {
    process.env.FEATURE_SCHEDULING = 'false';
    expect(readPlanFeatures().scheduling).toBe(false);
  });

  it('a tela e a API respondem no plano base', () => {
    expect(isPathAllowed('/agendamentos', BASE_PLAN)).toBe(true);
    expect(isPathAllowed('/api/scheduled-messages', BASE_PLAN)).toBe(true);
  });
});

describe('follow-up automático é add-on pago', () => {
  it('vem DESLIGADO quando ninguém configurou nada', () => {
    delete process.env.FEATURE_FOLLOWUPS;
    expect(readPlanFeatures().followups).toBe(false);
  });

  it('só liga quando explicitamente contratado', () => {
    process.env.FEATURE_FOLLOWUPS = 'true';
    expect(readPlanFeatures().followups).toBe(true);
  });

  it('não vem junto no plano base', () => {
    expect(BASE_PLAN.followups).toBe(false);
    expect(BASE_PLAN.scheduling).toBe(true);
  });
});

describe('são módulos independentes', () => {
  it('ligar um NÃO liga o outro', () => {
    delete process.env.FEATURE_FOLLOWUPS;
    process.env.FEATURE_SCHEDULING = 'true';
    const p = readPlanFeatures();
    expect(p.scheduling).toBe(true);
    expect(p.followups).toBe(false);
  });

  it('desligar o agendamento não desliga o follow-up contratado', () => {
    process.env.FEATURE_SCHEDULING = 'false';
    process.env.FEATURE_FOLLOWUPS = 'true';
    const p = readPlanFeatures();
    expect(p.scheduling).toBe(false);
    expect(p.followups).toBe(true);
  });

  it('têm nomes comerciais distintos', () => {
    // Se voltarem a compartilhar rótulo, é sinal de que alguém os fundiu.
    expect(FEATURE_LABELS.scheduling).not.toBe(FEATURE_LABELS.followups);
    expect(FEATURE_LABELS.scheduling).toMatch(/agendad/i);
    expect(FEATURE_LABELS.followups).toMatch(/follow/i);
  });
});
