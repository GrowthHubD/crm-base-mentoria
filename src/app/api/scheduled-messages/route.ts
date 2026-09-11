/**
 * GET  /api/scheduled-messages — lista agendamentos da unidade ATIVA do usuário,
 *      com nome do lead, atendente que criou (se houver) e nota interna.
 *
 * POST /api/scheduled-messages — cria um novo agendamento. Resolve/cria o lead
 *      baseado em (canal, contato) e enfileira o job BullMQ.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { db } from '@/lib/db/client';
import { scheduledMessages } from '@/lib/db/schema/scheduled-messages';
import { leads } from '@/lib/db/schema/leads';
import { users } from '@/lib/db/schema/users';
import { eq, desc } from 'drizzle-orm';
import { scheduleMessage, findOrCreateLeadForSchedule } from '@/modules/scheduler/service';
import type { LeadChannel } from '@/modules/leads/types';

export interface ScheduledMessageView {
  id: string;
  leadId: string;
  leadName: string | null;
  leadPhone: string | null;
  channel: string;
  status: string;
  body: string;
  mediaUrl: string | null;
  scheduledAt: Date;
  sentAt: Date | null;
  createdAt: Date;
  createdByName: string | null;
  internalNote: string | null;
  /** 'human' quando criado por atendente; 'ai' quando criado pelo agente IA. */
  origin: 'human' | 'ai';
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  // ?leadId=<uuid> restringe ao lead específico (usado pelo tab Agendamentos do lead modal).
  const url = new URL(req.url);
  const leadIdFilter = url.searchParams.get('leadId');

  const whereClause = leadIdFilter
    ? eq(scheduledMessages.leadId, leadIdFilter)
    : undefined;

  const rows = await db
    .select({
      id: scheduledMessages.id,
      leadId: scheduledMessages.leadId,
      leadName: leads.name,
      leadPhone: leads.phone,
      channel: leads.channel,
      status: scheduledMessages.status,
      body: scheduledMessages.body,
      mediaUrl: scheduledMessages.mediaUrl,
      scheduledAt: scheduledMessages.scheduledAt,
      sentAt: scheduledMessages.sentAt,
      createdAt: scheduledMessages.createdAt,
      createdById: scheduledMessages.createdById,
      createdByName: users.name,
      metadata: scheduledMessages.metadata,
    })
    .from(scheduledMessages)
    .innerJoin(leads, eq(scheduledMessages.leadId, leads.id))
    .leftJoin(users, eq(scheduledMessages.createdById, users.id))
    .where(whereClause)
    .orderBy(desc(scheduledMessages.scheduledAt))
    .limit(200);

  const result: ScheduledMessageView[] = rows.map(r => {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      leadId: r.leadId,
      leadName: r.leadName,
      leadPhone: r.leadPhone,
      channel: (r.channel as string) ?? 'whatsapp',
      status: r.status as string,
      body: r.body,
      mediaUrl: r.mediaUrl,
      scheduledAt: r.scheduledAt,
      sentAt: r.sentAt,
      createdAt: r.createdAt,
      createdByName: r.createdByName,
      internalNote: typeof meta.internalNote === 'string' ? meta.internalNote : null,
      origin: r.createdById ? 'human' : 'ai',
    };
  });

  return NextResponse.json({ scheduledMessages: result });
}

interface CreateBody {
  /** Alternativa A — informa leadId existente. */
  leadId?: string;
  /** Alternativa B — informa canal + contato + nome (resolve ou cria lead). */
  channel?: LeadChannel;
  contact?: string;
  name?: string;
  /** Mensagem agendada. */
  body: string;
  mediaUrl?: string;
  /** ISO string ou epoch ms. */
  scheduledAt: string | number;
  internalNote?: string;
}

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  if (!body.body || !body.body.trim()) {
    return NextResponse.json({ error: 'mensagem é obrigatória' }, { status: 400 });
  }
  if (!body.scheduledAt) {
    return NextResponse.json({ error: 'scheduledAt é obrigatório' }, { status: 400 });
  }

  const scheduledAt = new Date(body.scheduledAt);
  if (Number.isNaN(scheduledAt.getTime())) {
    return NextResponse.json({ error: 'scheduledAt inválido' }, { status: 400 });
  }
  if (scheduledAt.getTime() < Date.now() - 60_000) {
    return NextResponse.json({ error: 'data de envio deve ser no futuro' }, { status: 400 });
  }

  // Resolve leadId
  let leadId = body.leadId;
  if (!leadId) {
    if (!body.channel || !body.contact) {
      return NextResponse.json(
        { error: 'informe leadId OU (channel + contact)' },
        { status: 400 }
      );
    }
    // Só WhatsApp: não existe adapter de conversa por Instagram. Aceitar o
    // valor aqui criaria lead num canal que nenhum worker sabe entregar.
    if (body.channel !== 'whatsapp') {
      return NextResponse.json({ error: 'canal inválido' }, { status: 400 });
    }
    try {
      const resolved = await findOrCreateLeadForSchedule({
        channel: body.channel,
        contact: body.contact,
        name: body.name,
      });
      leadId = resolved.leadId;
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'falha resolvendo lead' },
        { status: 400 }
      );
    }
  } else {
    // Valida que o leadId existe
    const [lead] = await db.select({ id: leads.id }).from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json({ error: 'lead não encontrado' }, { status: 404 });
    }
  }

  const created = await scheduleMessage({
    leadId,
    createdById: guard.user.id,
    body: body.body.trim(),
    mediaUrl: body.mediaUrl,
    scheduledAt,
    metadata: body.internalNote ? { internalNote: body.internalNote.trim() } : undefined,
  });

  return NextResponse.json({ ok: true, id: created.id }, { status: 201 });
}
