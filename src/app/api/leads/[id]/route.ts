/**
 * GET    /api/leads/[id] — detalhe do lead
 * PATCH  /api/leads/[id] — atualiza dados/status (admin/atendente)
 * DELETE /api/leads/[id] — hard delete (admin)
 */
import { NextRequest, NextResponse } from 'next/server';
import { reads, patchLead, deleteLead, LeadServiceError } from '@/modules/leads/service';
import { auth } from '@/lib/auth';
import { requireAdmin, requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAoLead } from '@/lib/escopo-dono';
import { cancelPendingByLead } from '@/modules/followup/service';
import { logger } from '@/lib/logger';
import type { UpdateLeadInput } from '@/modules/leads/types';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Sem isto o detalhe do lead — telefone, canal, histórico de status — saía
  // pra qualquer requisição com um cookie inventado. O PATCH logo abaixo já
  // validava; só o GET tinha ficado para trás.
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAoLead(guard.user, id);
  if ('response' in acesso) return acesso.response;

  const lead = await reads.getById(id);
  if (!lead) return NextResponse.json({ error: 'lead not found' }, { status: 404 });

  return NextResponse.json({ lead });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // `requireSession` e não `auth.api.getSession`: o portão de dono precisa do
  // PAPEL do usuário, que só vem da consulta ao banco.
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const session = { user: guard.user };
  const acesso = await garantirAcessoAoLead(guard.user, id);
  if ('response' in acesso) return acesso.response;

  const body = (await req.json()) as UpdateLeadInput;

  // Atendente humano clicando "Converti!" no LeadModal → registra autoria
  // pro ranking de conversões no dashboard. Conversões automáticas (IA tool /
  // webhook Asaas) chamam setLeadStatus direto e deixam convertedById=null.
  const enriched: UpdateLeadInput =
    body.status === 'converted'
      ? { ...body, convertedById: session.user.id }
      : body;

  try {
    const lead = await patchLead(id, enriched);
    // Conversão dispara cancelamento de follow-ups pendentes — IA não
    // deve mais falar com esse lead até passar a janela de 24h.
    if (enriched.status === 'converted') {
      cancelPendingByLead(id, 'converted').catch((err) => {
        logger.warn(
          { err: err instanceof Error ? err.message : err, leadId: id },
          '[api:leads.patch] cancelar follow-ups na conversão falhou'
        );
      });
    }
    return NextResponse.json({ lead });
  } catch (err) {
    if (err instanceof LeadServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'TERMINAL' ? 409 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}

/**
 * Hard delete. Restrito a admin — atendente NÃO pode apagar
 * pra evitar perda de histórico acidental.
 *
 * Cascade do DB cuida de messages/scheduled/followups/payments/attendance/automation.
 * Jobs BullMQ pendentes são cancelados no service antes do delete.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  try {
    await deleteLead(id, guard.user.id);
    logger.info({ leadId: id, by: guard.user.id }, '[api:leads.delete] lead apagado');
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof LeadServiceError && err.code === 'NOT_FOUND') {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    logger.error(
      { leadId: id, err: err instanceof Error ? err.message : err },
      '[api:leads.delete] erro'
    );
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }
}
