/**
 * POST   /api/leads/[id]/resolve — marca lead como Resolvido manualmente.
 * DELETE /api/leads/[id]/resolve — limpa o estado Resolvido (atendente
 *   trocou de ideia OU teste manual). Lead retorna ao ciclo normal de
 *   follow-up sem precisar esperar inbound novo.
 *
 * Efeitos do POST:
 *   - leads.resolvedAt = now
 *   - leads.status = 'attending' (a menos que já esteja em converted/lost)
 *   - todos os follow-ups pendentes do lead viram cancelled
 *
 * Aberto pra qualquer user autenticado da unit (atendente também usa).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAoLead } from '@/lib/escopo-dono';
import { reads as leadReads, markLeadResolved, clearLeadResolved } from '@/modules/leads/service';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(_req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAoLead(guard.user, id);
  if ('response' in acesso) return acesso.response;
  const existing = await leadReads.getById(id);
  if (!existing) return NextResponse.json({ error: 'lead não encontrado' }, { status: 404 });

  const lead = await markLeadResolved(id);
  return NextResponse.json({ lead });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAoLead(guard.user, id);
  if ('response' in acesso) return acesso.response;
  const existing = await leadReads.getById(id);
  if (!existing) return NextResponse.json({ error: 'lead não encontrado' }, { status: 404 });

  await clearLeadResolved(id);
  const lead = await leadReads.getById(id);
  return NextResponse.json({ lead });
}
