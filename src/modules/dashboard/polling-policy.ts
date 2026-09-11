export type DashboardTab = 'geral' | 'canais' | 'atendimentos';

/** Indicadores operacionais do cabeçalho continuam próximos de tempo real. */
export const DASHBOARD_LIVE_POLL_MS = 10_000;

/** Agregações históricas são caras e não precisam ser recalculadas a cada 10s. */
export const DASHBOARD_ANALYTICS_POLL_MS = 60_000;

export function dashboardQueryActivity(tab: DashboardTab) {
  return {
    channels: tab === 'geral' || tab === 'canais',
    timeline: tab === 'geral',
    hourly: tab === 'geral',
  };
}
