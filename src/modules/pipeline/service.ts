/**
 * Service layer do módulo pipeline — escalação automática + transições.
 *
 * Regras (PRD seção 6, Rule 5/6):
 *   - new + lastMessageAt > newToPriorityMinutes → priority
 *   - priority + lastMessageAt > priorityToUrgencyMinutes → urgency + alerta
 *   - urgency continua urgency (não escala mais)
 *   - converted é terminal — nunca sai
 *   - lead inbound novo → resetar status para 'new' se estava 'attending'
 *   - atendente respondeu → 'attending'
 */
import { db } from '@/lib/db/client';
import { pipelineConfig } from '@/lib/db/schema/pipeline-config';
import { eq } from 'drizzle-orm';
import { reads as leadReads, escalate, LeadServiceError } from '@/modules/leads/service';
import { logger } from '@/lib/logger';

export interface PipelineConfig {
  newToPriorityMinutes: number;
  priorityToUrgencyMinutes: number;
  autoEscalationEnabled: boolean;
  notifyOnEscalation: boolean;
}

const DEFAULTS: PipelineConfig = {
  newToPriorityMinutes: 15,
  priorityToUrgencyMinutes: 30,
  autoEscalationEnabled: true,
  notifyOnEscalation: true,
};

/**
 * Lê config ativa. Se não houver row, retorna defaults.
 * Cacheia por 60s pra evitar query a cada tick.
 */
let _cachedConfig: { config: PipelineConfig; expiresAt: number } | null = null;
const CONFIG_TTL_MS = 60_000;

export async function getPipelineConfig(): Promise<PipelineConfig> {
  if (_cachedConfig && _cachedConfig.expiresAt > Date.now()) return _cachedConfig.config;

  const [row] = await db.select().from(pipelineConfig).limit(1);
  const config: PipelineConfig = row
    ? {
        newToPriorityMinutes: row.newToPriorityMinutes,
        priorityToUrgencyMinutes: row.priorityToUrgencyMinutes,
        autoEscalationEnabled: row.autoEscalationEnabled,
        notifyOnEscalation: row.notifyOnEscalation,
      }
    : DEFAULTS;

  _cachedConfig = { config, expiresAt: Date.now() + CONFIG_TTL_MS };
  return config;
}

/**
 * Persiste config (upsert single row). Invalida cache.
 *
 * Validações: minutos entre 1 e 120 (limites da UI).
 */
export async function setPipelineConfig(input: Partial<PipelineConfig>): Promise<PipelineConfig> {
  const current = await getPipelineConfig();
  const next: PipelineConfig = {
    newToPriorityMinutes: clampMin(input.newToPriorityMinutes ?? current.newToPriorityMinutes),
    priorityToUrgencyMinutes: clampMin(input.priorityToUrgencyMinutes ?? current.priorityToUrgencyMinutes),
    autoEscalationEnabled: input.autoEscalationEnabled ?? current.autoEscalationEnabled,
    notifyOnEscalation: input.notifyOnEscalation ?? current.notifyOnEscalation,
  };

  const [existing] = await db.select({ id: pipelineConfig.id }).from(pipelineConfig).limit(1);

  if (existing) {
    await db
      .update(pipelineConfig)
      .set({
        newToPriorityMinutes: next.newToPriorityMinutes,
        priorityToUrgencyMinutes: next.priorityToUrgencyMinutes,
        autoEscalationEnabled: next.autoEscalationEnabled,
        notifyOnEscalation: next.notifyOnEscalation,
        updatedAt: new Date(),
      })
      .where(eq(pipelineConfig.id, existing.id));
  } else {
    await db.insert(pipelineConfig).values(next);
  }

  invalidatePipelineConfigCache();
  return next;
}

function clampMin(v: number): number {
  if (!Number.isFinite(v)) return 15;
  return Math.max(1, Math.min(120, Math.round(v)));
}

export function invalidatePipelineConfigCache() {
  _cachedConfig = null;
}

/**
 * Roda uma passada de escalação. Lê leads candidatos e aplica transições.
 * Chamado pelo escalation worker (cron a cada minuto).
 *
 * Retorna estatísticas pra logging/teste.
 */
export async function runEscalationPass(): Promise<{
  scanned: number;
  promotedToPriority: number;
  promotedToUrgency: number;
  errors: number;
}> {
  const config = await getPipelineConfig();

  if (!config.autoEscalationEnabled) {
    return { scanned: 0, promotedToPriority: 0, promotedToUrgency: 0, errors: 0 };
  }

  // Escalação dirigida pela configuração das COLUNAS: cada uma diz depois de
  // quantos minutos o card sai e para onde vai. É o que permite um funil de dez
  // colunas com sete escalando — antes, escalar era privilégio de duas
  // transições escritas aqui dentro.
  //
  // Sem nenhuma coluna com tempo configurado, cai no caminho antigo logo
  // abaixo e nada muda para quem não mexeu na configuração.
  try {
    const { escalarPorTempo } = await import('./escalation');
    const r = await escalarPorTempo();
    if (r.regras > 0) {
      return { scanned: r.movidos, promotedToPriority: r.movidos, promotedToUrgency: 0, errors: 0 };
    }
  } catch (err) {
    // Falhar aqui não pode deixar o funil sem escalação nenhuma: segue para o
    // caminho antigo, que é o que já estava no ar.
    logger.error(
      { err: err instanceof Error ? err.message : err },
      '[pipeline] escalação por coluna falhou — usando as regras fixas'
    );
  }

  const candidates = await leadReads.listToEscalate(config);
  let promotedToPriority = 0;
  let promotedToUrgency = 0;
  let errors = 0;

  for (const lead of candidates) {
    try {
      if (lead.status === 'new') {
        await escalate(lead.id, 'priority', 1);
        promotedToPriority++;
      } else if (lead.status === 'priority') {
        await escalate(lead.id, 'urgency', 2);
        promotedToUrgency++;
      }
    } catch (err) {
      if (err instanceof LeadServiceError && err.code === 'TERMINAL') continue;
      errors++;
      logger.error(
        { err: err instanceof Error ? err.message : err, leadId: lead.id },
        '[pipeline] escalação falhou'
      );
    }
  }

  if (candidates.length > 0) {
    logger.info(
      { scanned: candidates.length, promotedToPriority, promotedToUrgency, errors },
      '[pipeline] escalation pass'
    );
  }

  return { scanned: candidates.length, promotedToPriority, promotedToUrgency, errors };
}
