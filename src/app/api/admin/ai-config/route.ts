/**
 * GET  /api/admin/ai-config — lê a config (singleton; cria default se vazia)
 * PUT  /api/admin/ai-config — patch parcial na config
 *
 * Apenas admin (super_admin ou admin). Atendente recebe 403.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { getPublicConfig, saveConfig, getConfigRow } from '@/modules/ai-agent';
import { bulkEnableAiForUnit } from '@/modules/leads/service';
import { cancelPendingByUnit } from '@/modules/followup/service';
import type { AiAgentConfigInput } from '@/modules/ai-agent';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const config = await getPublicConfig();
  return NextResponse.json({ config });
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let raw: AiAgentConfigInput & { propagateToExistingLeads?: boolean };
  try {
    raw = (await req.json()) as AiAgentConfigInput & { propagateToExistingLeads?: boolean };
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const { propagateToExistingLeads, ...body } = raw;

  try {
    // Captura `enabled` ANTES do save pra detectar transição OFF→ON. Sem
    // isso o propagate roda toda vez que enabled=true é enviado, mesmo se já
    // estava true (sobrescrevia overrides manuais por-lead).
    const before = await getConfigRow();
    const wasEnabled = before?.enabled ?? false;
    const config = await saveConfig(body);
    let propagated: { affected: number } | undefined;
    if (propagateToExistingLeads && !wasEnabled && config.enabled) {
      propagated = await bulkEnableAiForUnit();
    }

    // Transição ON→OFF do toggle global: cancela todos os follow-ups
    // pendentes da unit. Sem isso, mensagens proativas continuam empilhadas
    // e disparariam atrasadas quando a IA fosse religada — que é exatamente
    // o cenário que o admin quis evitar ao desligar a IA.
    let cancelledFollowups = 0;
    if (wasEnabled && !config.enabled) {
      try {
        cancelledFollowups = await cancelPendingByUnit('unit_ai_disabled');
        logger.info(
          { cancelledFollowups },
          '[api:admin.ai-config] IA desligada — follow-ups pendentes cancelados'
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err },
          '[api:admin.ai-config] falha ao cancelar follow-ups pós-disable'
        );
      }
    }

    return NextResponse.json({ config, propagated, cancelledFollowups });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'erro inesperado';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
