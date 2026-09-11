export type AutomationTrigger =
  | 'first_message'
  | 'lead_inactive'
  | 'stage_enter'
  | 'tag_added'
  | 'manual';

export type AutomationStepType =
  | 'send_text'
  | 'send_media'
  | 'wait'
  | 'set_status'
  | 'add_tag'
  | 'notify_human';

export type AutomationLogStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled';

export interface Automation {
  id: string;
  name: string;
  description?: string | null;
  trigger: AutomationTrigger;
  enabled: boolean;
  triggerConfig?: Record<string, unknown> | null;
  filters?: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AutomationStep {
  id: string;
  automationId: string;
  sequence: number;
  type: AutomationStepType;
  config: Record<string, unknown>;
  createdAt: Date;
}

export interface AutomationLog {
  id: string;
  automationId: string;
  stepId?: string | null;
  leadId: string;
  status: AutomationLogStatus;
  scheduledAt: Date;
  executedAt?: Date | null;
  bullJobId?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: Date;
}

// ── Configs estritamente tipados por tipo de step ─────────────

export interface SendTextStepConfig {
  body: string; // suporta placeholders {{name}}, {{phone}}
  delayMinutes?: number;
}

export interface SendMediaStepConfig {
  url: string;
  mediaType: 'image' | 'video' | 'audio' | 'document';
  caption?: string;
  fileName?: string;
  delayMinutes?: number;
}

export interface WaitStepConfig {
  minutes: number;
}

export interface SetStatusStepConfig {
  status: 'new' | 'priority' | 'urgency' | 'attending' | 'converted' | 'lost';
}

export interface AddTagStepConfig {
  tag: string;
}

export interface NotifyHumanStepConfig {
  message: string;
}

// ── Configs por tipo de trigger ───────────────────────────────

export interface FirstMessageTriggerConfig {
  // pode ter filtros específicos no futuro
}

export interface LeadInactiveTriggerConfig {
  days: number; // dias sem resposta do lead após última msg do operador
}

export interface StageEnterTriggerConfig {
  stage: 'new' | 'priority' | 'urgency' | 'attending' | 'converted' | 'lost';
}

export interface TagAddedTriggerConfig {
  tag: string;
}
