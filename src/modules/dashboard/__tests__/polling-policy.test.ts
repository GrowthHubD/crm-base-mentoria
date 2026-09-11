import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_ANALYTICS_POLL_MS,
  DASHBOARD_LIVE_POLL_MS,
  dashboardQueryActivity,
} from '../polling-policy';

describe('politica de polling do dashboard', () => {
  it('mantem KPIs operacionais mais frequentes que agregacoes historicas', () => {
    expect(DASHBOARD_LIVE_POLL_MS).toBe(10_000);
    expect(DASHBOARD_ANALYTICS_POLL_MS).toBe(60_000);
  });

  it('ativa todos os graficos na visao geral', () => {
    expect(dashboardQueryActivity('geral')).toEqual({
      channels: true,
      timeline: true,
      hourly: true,
    });
  });

  it('mantem somente canais na aba de canais', () => {
    expect(dashboardQueryActivity('canais')).toEqual({
      channels: true,
      timeline: false,
      hourly: false,
    });
  });

  it('pausa todos os graficos na aba de atendimentos', () => {
    expect(dashboardQueryActivity('atendimentos')).toEqual({
      channels: false,
      timeline: false,
      hourly: false,
    });
  });
});
