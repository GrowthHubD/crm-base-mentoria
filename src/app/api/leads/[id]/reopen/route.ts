/**
 * POST /api/leads/[id]/reopen — reabre lead convertido/perdido (volta pra 'new').
 *
 * Bypassa o bloqueio de status terminal — usado quando admin clicou
 * "Converti!"/"Perdi" por engano.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAoLead } from '@/lib/escopo-dono';
import { reopenLead, LeadServiceError } from '@/modules/leads/service';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const acesso = await garantirAcessoAoLead(guard.user, id);
  if ('response' in acesso) return acesso.response;
  try {
    const lead = await reopenLead(id);
    return NextResponse.json({ lead });
  } catch (err) {
    if (err instanceof LeadServiceError) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 500 }
    );
  }
}
