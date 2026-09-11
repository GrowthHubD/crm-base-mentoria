/**
 * Módulo não contratado não pode abrir por URL direta.
 *
 * O gating nasceu só na navegação: o item sumia do menu, mas `/agente-ia`
 * respondia 200 e `/api/admin/ai-config` também, num deploy que não tinha o
 * agente no plano. Esconder o link não é bloquear — e o cliente encontra a
 * URL pelo histórico, por um print, ou digitando.
 */
import { describe, it, expect } from 'vitest';
import { isPathAllowed, featureForPath, BASE_PLAN, type PlanFeatures } from '@/lib/plan';

const SO_CRM: PlanFeatures = { aiAgent: false, scheduling: false, quickReplies: false, ranking: true, units: false, followups: false, email: false };
const COMPLETO: PlanFeatures = { aiAgent: true, scheduling: true, quickReplies: true, ranking: true, units: true, followups: true, email: true };

describe('featureForPath', () => {
  it('associa a rota ao módulo que ela exige', () => {
    expect(featureForPath('/agente-ia')).toBe('aiAgent');
    expect(featureForPath('/api/admin/ai-config')).toBe('aiAgent');
    expect(featureForPath('/textos-rapidos')).toBe('quickReplies');
    expect(featureForPath('/api/scheduled-messages')).toBe('scheduling');
  });

  it('pega sub-rotas, não só o prefixo exato', () => {
    expect(featureForPath('/api/admin/ai-config/pause')).toBe('aiAgent');
    expect(featureForPath('/api/scheduled-messages/abc/send-now')).toBe('scheduling');
  });

  it('rota do plano base não exige módulo nenhum', () => {
    expect(featureForPath('/crm')).toBeNull();
    expect(featureForPath('/dashboard')).toBeNull();
    expect(featureForPath('/api/leads')).toBeNull();
  });

  it('não casa por substring solta — /agente-ia não bloqueia /agentes-externos', () => {
    expect(featureForPath('/agentes-externos')).toBeNull();
  });
});

describe('isPathAllowed', () => {
  it('bloqueia o que o plano não tem', () => {
    expect(isPathAllowed('/agente-ia', SO_CRM)).toBe(false);
    expect(isPathAllowed('/api/admin/ai-config', SO_CRM)).toBe(false);
    expect(isPathAllowed('/textos-rapidos', SO_CRM)).toBe(false);
    expect(isPathAllowed('/agendamentos', SO_CRM)).toBe(false);
  });

  it('libera o que o plano tem', () => {
    expect(isPathAllowed('/agente-ia', COMPLETO)).toBe(true);
    expect(isPathAllowed('/ranking', SO_CRM)).toBe(true);
  });

  it('nunca bloqueia o núcleo do CRM, em plano nenhum', () => {
    for (const plano of [SO_CRM, COMPLETO, BASE_PLAN]) {
      expect(isPathAllowed('/crm', plano)).toBe(true);
      expect(isPathAllowed('/dashboard', plano)).toBe(true);
      expect(isPathAllowed('/api/leads', plano)).toBe(true);
      expect(isPathAllowed('/conexoes', plano)).toBe(true);
    }
  });
});

/**
 * O canal de e-mail nasceu para o fluxo de BDR de UM cliente e ficou ligado
 * para todos, porque não tinha flag nenhuma. Quem comprou "CRM de WhatsApp"
 * via no menu um módulo que não contratou — e o submenu WhatsApp|E-mail dentro
 * de "CRM" fazia parecer que faltava algo.
 *
 * A armadilha ao corrigir: pôr a flag no ITEM "CRM" do menu. Aí o cliente sem
 * e-mail perde o kanban inteiro. O que o e-mail controla é o SUBMENU, não o
 * CRM — por isso o teste de "núcleo do CRM" acima vale também sem `email`.
 */
describe('canal de e-mail é add-on', () => {
  it('não vem no plano base', () => {
    expect(BASE_PLAN.email).toBe(false);
  });

  it('a tela e a API só respondem para quem contratou', () => {
    expect(isPathAllowed('/configuracoes/email', SO_CRM)).toBe(false);
    expect(isPathAllowed('/api/email/accounts', SO_CRM)).toBe(false);
    expect(isPathAllowed('/configuracoes/email', COMPLETO)).toBe(true);
    expect(isPathAllowed('/api/email/accounts', COMPLETO)).toBe(true);
  });

  it('o kanban continua aberto para quem NÃO tem e-mail', () => {
    expect(isPathAllowed('/crm', SO_CRM)).toBe(true);
    expect(featureForPath('/crm')).toBeNull();
  });
});
