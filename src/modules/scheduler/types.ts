export interface ScheduledMessage {
  id: string;
  leadId: string;
  createdById?: string | null;
  status: 'pending' | 'sent' | 'cancelled' | 'failed';
  body: string;
  mediaUrl?: string | null;
  scheduledAt: Date;
  sentAt?: Date | null;
  bullJobId?: string | null;
  createdAt: Date;
}

export interface CreateScheduledMessageInput {
  leadId: string;
  body: string;
  mediaUrl?: string;
  scheduledAt: Date;
  createdById?: string;
}
