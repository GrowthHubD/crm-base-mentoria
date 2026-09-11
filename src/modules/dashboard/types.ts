export interface DashboardMetrics {
  // Pipeline
  totalLeads: number;
  leadsByStatus: Record<string, number>;
  newLeadsToday: number;
  convertedToday: number;
  conversionRate: number; // 0.0 a 1.0
  // Atendimento
  averageResponseTimeMinutes: number;
  activeAttendants: number;
  aiHandledToday: number;
  humanHandledToday: number;
  // Financeiro
  revenueToday: number; // centavos
  revenueThisMonth: number;
  pendingPayments: number;
}

export interface DashboardChartPoint {
  date: string; // ISO date
  leads: number;
  conversions: number;
  revenue: number;
}
