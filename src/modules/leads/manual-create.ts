import { z } from 'zod';
import type { StageColumn } from '@/modules/pipeline/types';
import type { LeadAttributedChannel, LeadStatus } from './types';

const OPERATIONAL_STATUSES = ['new', 'priority', 'urgency', 'attending'] as const;
const ATTRIBUTED_CHANNELS = ['whatsapp', 'instagram', 'google', 'email', 'manual'] as const;

const optionalText = (max: number) => z.string().trim().max(max).optional().default('');

export const manualLeadSchema = z.object({
  name: z.string().trim().min(2, 'Informe o nome do lead').max(120),
  phone: optionalText(30),
  email: optionalText(254),
  notes: optionalText(5_000),
  connectionId: optionalText(160),
  attributedChannel: z.enum(ATTRIBUTED_CHANNELS).nullable().optional(),
  status: z.enum(OPERATIONAL_STATUSES),
  stageId: z.string().trim().min(1).max(160).nullable(),
}).superRefine((value, ctx) => {
  const phone = digitsOnly(value.phone);
  const email = value.email.toLowerCase();
  if (!phone && !email) {
    ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Informe telefone ou e-mail' });
  }
  if (phone && (phone.length < 8 || phone.length > 15)) {
    ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Informe um telefone válido com DDD' });
  }
  if (email && !z.string().email().safeParse(email).success) {
    ctx.addIssue({ code: 'custom', path: ['email'], message: 'Informe um e-mail válido' });
  }
  if (value.connectionId && !phone) {
    ctx.addIssue({ code: 'custom', path: ['phone'], message: 'Telefone é obrigatório para WhatsApp' });
  }
});

export type ManualLeadRequest = z.infer<typeof manualLeadSchema>;

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

export function normalizeManualLead(value: ManualLeadRequest) {
  const phone = digitsOnly(value.phone);
  const email = value.email.trim().toLowerCase();
  return {
    ...value,
    phone: phone || undefined,
    email: email || undefined,
    notes: value.notes.trim() || null,
    connectionId: value.connectionId || undefined,
    attributedChannel: (value.attributedChannel ?? 'manual') as LeadAttributedChannel,
  };
}

export function resolveManualLeadDestination(
  requested: Pick<ManualLeadRequest, 'status' | 'stageId'>,
  stages: StageColumn[]
): { status: LeadStatus; stageId: string | null } {
  const stage = requested.stageId
    ? stages.find((candidate) => candidate.id === requested.stageId)
    : stages.find((candidate) => !candidate.isCustom && candidate.status === requested.status);

  if (!stage || !stage.visible) throw new Error('A coluna escolhida não está disponível');
  if (!OPERATIONAL_STATUSES.includes(stage.status as (typeof OPERATIONAL_STATUSES)[number])) {
    throw new Error('Crie o lead em uma coluna operacional');
  }

  return {
    status: stage.status,
    stageId: stage.isCustom ? stage.id : null,
  };
}

export function manualExternalContactId(args: {
  connectionId?: string;
  phone?: string;
  id: string;
}): string {
  return args.connectionId && args.phone ? args.phone : `manual:${args.id}`;
}
