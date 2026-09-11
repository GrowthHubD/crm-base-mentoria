/**
 * GET /api/admin/pipeline-config — config atual
 * PUT /api/admin/pipeline-config — atualiza
 *
 * Liberado pra todos os roles (incluindo attendant) — o cliente quer que
 * atendentes consigam ajustar os tempos de escalonamento da pipeline a partir
 * do botão de "Configurações de fila" no CRM.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/auth-helpers';
import { getPipelineConfig, setPipelineConfig } from '@/modules/pipeline/service';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const config = await getPipelineConfig();
  return NextResponse.json({ config });
}

export async function PUT(req: NextRequest) {
  // `requireAdmin`: os tempos de escalação valem para a instalação inteira.
  // Estava em `requireSession`, ou seja, qualquer atendente logado podia mudar
  // a fila de todo mundo pela API — o botão não aparecia para ele, a rota sim.
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  try {
    const config = await setPipelineConfig({
      newToPriorityMinutes: typeof body.newToPriorityMinutes === 'number' ? body.newToPriorityMinutes : undefined,
      priorityToUrgencyMinutes: typeof body.priorityToUrgencyMinutes === 'number' ? body.priorityToUrgencyMinutes : undefined,
      autoEscalationEnabled: typeof body.autoEscalationEnabled === 'boolean' ? body.autoEscalationEnabled : undefined,
      notifyOnEscalation: typeof body.notifyOnEscalation === 'boolean' ? body.notifyOnEscalation : undefined,
    });
    return NextResponse.json({ config });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[PUT pipeline-config] falhou');
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 500 }
    );
  }
}
