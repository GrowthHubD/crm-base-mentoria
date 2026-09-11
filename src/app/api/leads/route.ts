/**
 * GET /api/leads — lista leads (com filtros via query string)
 *   ?status=new|priority|urgency|attending|converted|lost  (pode repetir)
 *   ?channel=whatsapp|instagram|google|manual
 *   ?limit=50 ?offset=0 ?order=recent|oldest
 *
 * Auth obrigatório — e verificado AQUI, não no middleware.
 *
 * A versão anterior confiava no middleware, o que era falso: `getSessionCookie`
 * do better-auth só olha se o cookie EXISTE, não valida assinatura nem
 * expiração (a própria doc avisa que serve só pra redirect otimista). Na
 * prática, `cookie: better-auth.session_token=qualquercoisa` devolvia a lista
 * completa de leads — nome e telefone de todo mundo — sem login.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createLeadFromContact, reads } from '@/modules/leads/service';
import { requireSession } from '@/lib/auth-helpers';
import { escopoDaRequisicao, unidadeSelecionada } from '@/lib/units';
import { escopoDono } from '@/lib/escopo-dono';
import type { LeadStatus, LeadChannel } from '@/modules/leads/types';
import { listActiveConnections } from '@/modules/pipeline/queries';
import { listStages } from '@/modules/pipeline/stages';
import {
  manualExternalContactId,
  manualLeadSchema,
  normalizeManualLead,
  resolveManualLeadDestination,
} from '@/modules/leads/manual-create';

const VALID_STATUSES: LeadStatus[] = ['new', 'priority', 'urgency', 'attending', 'converted', 'lost'];
// Filtra por `leads.channel` (canal de CONVERSA), não por origem — por isso
// Instagram e Google não entram aqui.
const VALID_CHANNELS: LeadChannel[] = ['whatsapp', 'manual'];

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const url = new URL(req.url);
  const statuses = url.searchParams.getAll('status').filter(s => VALID_STATUSES.includes(s as LeadStatus)) as LeadStatus[];
  const channelParam = url.searchParams.get('channel');
  const channel = channelParam && VALID_CHANNELS.includes(channelParam as LeadChannel) ? (channelParam as LeadChannel) : undefined;
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));
  const order = url.searchParams.get('order') === 'oldest' ? 'oldest' : 'recent';

  const escopo = escopoDaRequisicao(guard.user, unidadeSelecionada(req));

  const dono = escopoDono(guard.user);

  const leads = await reads.list({
    unitId: escopo.unitId,
    ownerId: dono.ownerId,
    status: statuses.length === 1 ? statuses[0] : statuses.length > 1 ? statuses : undefined,
    channel,
    limit,
    offset,
    order,
  });

  return NextResponse.json({ leads, total: leads.length });
}

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const parsed = manualLeadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Dados inválidos' },
      { status: 400 }
    );
  }

  const input = normalizeManualLead(parsed.data);
  const escopo = escopoDaRequisicao(guard.user, unidadeSelecionada(req));
  const dono = escopoDono(guard.user);

  const [stages, allowedConnections] = await Promise.all([
    listStages(),
    input.connectionId
      ? listActiveConnections({ ownerId: dono.ownerId, unitId: escopo.unitId })
      : Promise.resolve([]),
  ]);

  let destination: ReturnType<typeof resolveManualLeadDestination>;
  try {
    destination = resolveManualLeadDestination(input, stages);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Coluna inválida' },
      { status: 400 }
    );
  }

  const selectedConnection = input.connectionId
    ? allowedConnections.find((connection) => connection.id === input.connectionId)
    : undefined;
  if (input.connectionId && !selectedConnection) {
    return NextResponse.json({ error: 'Conexão não disponível neste escopo' }, { status: 404 });
  }

  const channel: LeadChannel = selectedConnection ? 'whatsapp' : 'manual';
  const externalContactId = manualExternalContactId({
    connectionId: selectedConnection?.id,
    phone: input.phone,
    id: crypto.randomUUID(),
  });

  if (channel === 'whatsapp') {
    const existing = await reads.findByContact(channel, externalContactId);
    if (existing) {
      return NextResponse.json(
        { error: 'Já existe um lead de WhatsApp com este telefone' },
        { status: 409 }
      );
    }
  }

  try {
    const lead = await createLeadFromContact({
      externalContactId,
      channel,
      connectionId: selectedConnection?.id,
      unitId: selectedConnection?.unitId ?? escopo.unitId,
      ownerId: selectedConnection ? undefined : dono.ownerId,
      name: input.name,
      phone: input.phone,
      email: input.email,
      notes: input.notes,
      attributedChannel: input.attributedChannel,
      status: destination.status,
      stageId: destination.stageId,
      aiAgentActive: false,
    });
    return NextResponse.json({ lead }, { status: 201 });
  } catch (err) {
    const code = databaseErrorCode(err);
    if (code === '23505') {
      return NextResponse.json({ error: 'Este lead já existe no CRM' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Não foi possível criar o lead' }, { status: 500 });
  }
}

function databaseErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code) return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}
