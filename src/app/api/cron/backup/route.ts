/**
 * POST /api/cron/backup — dispara o backup na hora.
 *
 * O agendado roda no `/api/cron/tick` aos domingos. Este endpoint existe pra
 * rodar sob demanda: antes de uma migration arriscada, ou pra conferir que o
 * backup funciona sem esperar o domingo chegar.
 *
 * Mesmo `CRON_SECRET` do tick — responde 404 sem o header, pra não confirmar
 * a existência do endpoint a quem varre a aplicação.
 */
import { NextRequest, NextResponse } from 'next/server';
import { runBackup } from '@/modules/backup';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  try {
    const result = await runBackup();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:backup] falhou');
    return NextResponse.json({ ok: false, error: 'backup falhou' }, { status: 500 });
  }
}
