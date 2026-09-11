/**
 * POST /api/admin/ai-config/pause — pausa de emergência da IA da unidade.
 *
 * Body:
 *   { minutes: number }  — pausa pelos próximos N minutos (1-1440)
 *   { minutes: 0 }       — pausa indefinida (até admin desligar manualmente)
 *   { until: null }      — RESUME (limpa a pausa)
 *
 * Efeitos:
 *   - Seta ai_agent_config.paused_until pra now + minutes (ou null no resume)
 *   - Cancela TODOS os follow-ups pendentes da unit (para de vez sem precisar
 *     desconectar o número, que foi o que aconteceu no incidente de 30/05).
 *
 * Apenas admin/super_admin. Atendente recebe 403.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { saveConfig, getPublicConfig } from '@/modules/ai-agent';
import { cancelPendingByUnit } from '@/modules/followup/service';
import { logger } from '@/lib/logger';

interface PauseBody {
  /** Pausa por N minutos. 0 = indefinida. Ignorado se `until: null`. */
  minutes?: number;
  /** Passar `null` explicitamente pra RESUMIR (limpa pausedUntil). */
  until?: null;
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let body: PauseBody;
  try {
    body = (await req.json()) as PauseBody;
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  // Resume: until: null explicito
  if (body.until === null) {
    await saveConfig({ pausedUntil: null });
    const config = await getPublicConfig();
    logger.info({ by: guard.user.id }, '[ai-config.pause] IA retomada');
    return NextResponse.json({ config, action: 'resumed' });
  }

  // Pause
  const minutes = typeof body.minutes === 'number' ? body.minutes : 60;
  if (minutes < 0 || minutes > 1440) {
    return NextResponse.json({ error: 'minutes deve estar entre 0 e 1440' }, { status: 400 });
  }

  // minutes=0 → pausa indefinida (10 anos no futuro, prático pra checks > now).
  const pausedUntil = minutes === 0
    ? new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000)
    : new Date(Date.now() + minutes * 60_000);

  await saveConfig({ pausedUntil });
  const cancelled = await cancelPendingByUnit('unit_paused');
  const config = await getPublicConfig();

  logger.info(
    { by: guard.user.id, minutes, pausedUntil, cancelledFollowups: cancelled },
    '[ai-config.pause] IA pausada'
  );
  return NextResponse.json({
    config,
    action: 'paused',
    cancelledFollowups: cancelled,
  });
}
