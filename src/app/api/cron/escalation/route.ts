/**
 * POST /api/cron/escalation — uma passada de escalação do pipeline.
 *
 * Substitui o repeatable job do BullMQ (`escalation:tick`, a cada 60s), que
 * não existe no Cloudflare: lá quem chama é um Cron Trigger, e o handler
 * `scheduled` do Worker bate nesta rota.
 *
 * Não usa sessão — quem chama é máquina, não usuário. O acesso é fechado por
 * `CRON_SECRET`: sem o header certo, 404 em vez de 401, pra não confirmar a
 * existência do endpoint pra quem varre a aplicação.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runEscalationPass } from '@/modules/pipeline/service';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  try {
    const stats = await runEscalationPass();
    logger.info({ stats }, '[cron:escalation] passada concluída');
    return NextResponse.json({ ok: true, stats });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      '[cron:escalation] passada falhou'
    );
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
