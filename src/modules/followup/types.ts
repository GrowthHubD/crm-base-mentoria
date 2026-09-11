export interface Followup {
  id: string;
  leadId: string;
  status: 'pending' | 'sent' | 'cancelled' | 'responded';
  sequence: number;
  body: string;
  scheduledAt: Date;
  sentAt?: Date | null;
  bullJobId?: string | null;
  createdAt: Date;
}

export interface FollowupRule {
  sequence: number;
  delayMinutes: number;
  body: string;
}
