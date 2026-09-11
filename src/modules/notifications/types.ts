export type NotificationChannel = 'whatsapp' | 'internal';
export type NotificationType =
  | 'api_failure'
  | 'escalation'
  | 'new_lead'
  | 'lead_assigned'
  | 'payment_confirmed';

export interface NotificationPayload {
  type: NotificationType;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
}

export interface ApiFailureNotification {
  service: string; // 'uazapi' | 'asaas' | 'gemini' | etc.
  endpoint: string;
  statusCode?: number;
  error: string;
  occurredAt: Date;
}
