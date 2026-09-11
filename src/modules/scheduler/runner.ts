/**
 * Execução de um agendamento — mensagem agendada ou follow-up.
 *
 * Por que existe: a lógica morava dentro do worker BullMQ, e worker só existe
 * onde há Redis. No Cloudflare quem acorda o trabalho é um Cron Trigger, que
 * não tem fila nem job — precisa chamar a mesma função. Manter isto aqui é o
 * padrão do projeto (route/worker/cron chamam service, service não sabe quem
 * chamou) e evita a pior falha possível: duas cópias da regra divergindo, uma
 * disparando o follow-up que a outra cancelaria.
 *
 * Nenhuma decisão de negócio nova é tomada aqui — o conteúdo é o do worker.
 */
import { logger } from '@/lib/logger';
import { dispatchOutbound } from '@/lib/dispatch';
import { QUEUES_ENABLED, schedulerQueue } from '@/lib/queue';
import { recordPendingOutbound, reads as messageReads } from '@/modules/messages/service';
import {
  getById as getScheduledById,
  ensureLeadHasConnection,
} from '@/modules/scheduler/service';
import {
  getById as getFollowupById,
  markFailed as markFollowupFailed,
  isWithinFollowupWindow,
  nextFollowupWindowOpen,
} from '@/modules/followup/service';

export interface RunResult {
  ok: boolean;
  reason?: string;
  messageId?: string;
}

/** Dispara uma mensagem agendada pelo atendente. */
export async function runScheduledMessage(scheduledMessageId: string): Promise<RunResult> {
  const sched = await getScheduledById(scheduledMessageId);
  if (!sched || sched.status !== 'pending') {
    return { ok: false, reason: `status=${sched?.status ?? 'missing'}` };
  }

  // Garante que o lead tem connection vinculada (auto-fix pra leads criados
  // por agendamento manual antes do fix de connectionId).
  await ensureLeadHasConnection(sched.leadId);

  const msg = await recordPendingOutbound({
    leadId: sched.leadId,
    type: sched.mediaUrl ? 'image' : 'text',
    sender: 'human',
    sentById: sched.createdById,
    body: sched.body,
    mediaUrl: sched.mediaUrl ?? null,
    metadata: { source: 'scheduled-message', scheduledMessageId },
  });

  await dispatchOutbound(
    {
      messageId: msg.id,
      leadId: sched.leadId,
      type: sched.mediaUrl ? 'image' : 'text',
      body: sched.body,
      mediaUrl: sched.mediaUrl ?? null,
      scheduledMessageId,
    },
    { jobId: `out-sched-${msg.id}` }
  );

  return { ok: true, messageId: msg.id };
}

/**
 * Dispara um follow-up automático. O texto é gerado pelo LLM a partir da
 * diretriz salva em `fu.body` — a diretriz NUNCA vai crua pro cliente.
 */
export async function runFollowup(followupId: string): Promise<RunResult> {
  const fu = await getFollowupById(followupId);
  if (!fu || fu.status !== 'pending') {
    // Inclui 'cancelled'/'responded' — cancelPendingByLead marca status no DB
    // antes de remover o job, então se o disparo acontece mesmo assim
    // (race, ou job já active), aqui filtramos.
    logger.info(
      { followupId, status: fu?.status ?? 'missing' },
      '[scheduler:runner] follow-up pulado — status nao-pending'
    );
    return { ok: false, reason: `status=${fu?.status ?? 'missing'}` };
  }

  const { reads } = await import('@/modules/leads/service');
  const lead = await reads.getById(fu.leadId);
  if (!lead || lead.status === 'converted' || lead.status === 'lost') {
    await markFollowupFailed(followupId, `lead status ${lead?.status ?? 'missing'}`);
    return { ok: false, reason: 'lead_terminal' };
  }

  // IA bloqueada (pós-conversão recente, dentro de 24h): follow-ups são
  // mensagens da IA, então não disparam nesse período. O lead pode ter voltado
  // à pipeline por inbound, mas quem responde é o atendente humano.
  if (lead.aiBlockedUntil && lead.aiBlockedUntil.getTime() > Date.now()) {
    await markFollowupFailed(followupId, 'ai_blocked_post_conversion');
    return { ok: false, reason: 'ai_blocked' };
  }

  // Atendente clicou "Resolvido": follow-ups ficam bloqueados até o lead
  // engajar de novo.
  if (lead.resolvedAt) {
    await markFollowupFailed(followupId, 'lead_resolved_manually');
    logger.info(
      { followupId, leadId: fu.leadId, resolvedAt: lead.resolvedAt },
      '[scheduler:runner] follow-up cancelado — lead marcado como Resolvido'
    );
    return { ok: false, reason: 'lead_resolved_manually' };
  }

  // IA global OFF (toggle ou pausa de emergência): cancela em vez de silenciar.
  const { getConfigRow: getAiCfg } = await import('@/modules/ai-agent/queries');
  const aiCfg = await getAiCfg();
  if (!aiCfg || !aiCfg.enabled) {
    await markFollowupFailed(followupId, 'ai_disabled');
    logger.info({ followupId, leadId: fu.leadId }, '[scheduler:runner] follow-up cancelado — IA desligada');
    return { ok: false, reason: 'ai_disabled' };
  }
  if (aiCfg.pausedUntil && aiCfg.pausedUntil.getTime() > Date.now()) {
    await markFollowupFailed(followupId, 'ai_paused');
    logger.info(
      { followupId, leadId: fu.leadId, pausedUntil: aiCfg.pausedUntil },
      '[scheduler:runner] follow-up cancelado — IA em pausa'
    );
    return { ok: false, reason: 'ai_paused' };
  }

  // Circuit breaker: N outbounds seguidos sem NENHUM inbound = conversa morta
  // (bloqueio, troca de número, shadow-ban). Insistir vira spam.
  // Origem: shadow-ban Cozumel 30/05-06/06/2026 — a uazapi retornava 200 OK
  // enquanto o WhatsApp dropava silenciosamente cada mensagem.
  const MAX_SILENT_OUTBOUNDS = parseInt(process.env.FOLLOWUP_MAX_SILENT_OUTBOUNDS ?? '3', 10);
  const silentCount = await messageReads.countOutboundsSinceLastInbound(fu.leadId);
  if (silentCount >= MAX_SILENT_OUTBOUNDS) {
    await markFollowupFailed(followupId, `silent_circuit_breaker:${silentCount}`);
    logger.info(
      { followupId, leadId: fu.leadId, silentCount, threshold: MAX_SILENT_OUTBOUNDS },
      '[scheduler:runner] follow-up cancelado — circuit breaker (lead sem resposta)'
    );
    return { ok: false, reason: 'silent_circuit_breaker' };
  }

  // Janela de horário comercial (default 8h-18h). Respostas reativas continuam
  // 24h — só o proativo espera. Com fila, reagenda pro próximo horário; sem
  // fila, o follow-up continua pending e vencido, e o próximo tick reavalia.
  if (!isWithinFollowupWindow()) {
    const nextOpen = nextFollowupWindowOpen();
    if (QUEUES_ENABLED) {
      const delayMs = Math.max(0, nextOpen.getTime() - Date.now());
      await schedulerQueue.add(
        'followup-message',
        { followupId },
        { jobId: `fu-${followupId}-deferred-${nextOpen.getTime()}`, delay: delayMs }
      );
    }
    logger.info(
      { followupId, leadId: fu.leadId, nextOpen: nextOpen.toISOString(), queued: QUEUES_ENABLED },
      '[scheduler:runner] follow-up adiado — fora da janela comercial'
    );
    return { ok: false, reason: 'outside_business_hours_deferred' };
  }

  // fu.body guarda a DIRETRIZ configurada no /agente-ia. O LLM gera o texto
  // contextualizado pelo histórico.
  //
  // CRÍTICO: se o LLM retornar null (IA desabilitada, lead pausado, OpenRouter
  // falhou), ABORTA. Nunca usar fu.body como fallback de texto — é instrução
  // interna do tipo "Faça oferta de desconto / Gatilhos permitidos: ...", e
  // enviá-la pro cliente VAZOU O PROMPT no incidente de 30/05.
  const { generateFollowupForLead } = await import('@/modules/ai-agent/service');
  const generated = await generateFollowupForLead(fu.leadId, fu.body);
  if (!generated || generated.trim().length === 0) {
    await markFollowupFailed(followupId, 'llm_failed_or_paused');
    logger.info(
      { followupId, leadId: fu.leadId },
      '[scheduler:runner] follow-up abortado — LLM null/pausa (nao envia diretriz crua)'
    );
    return { ok: false, reason: 'llm_failed_or_paused' };
  }
  const finalBody = generated.trim();

  const aiSenderName = aiCfg.agentName ?? 'Assistente';
  const msg = await recordPendingOutbound({
    leadId: fu.leadId,
    type: 'text',
    sender: 'ai',
    senderName: aiSenderName,
    body: finalBody,
    metadata: {
      source: 'followup',
      followupId,
      sequence: fu.sequence,
      instruction: fu.body,
      llmGenerated: true,
    },
  });

  await dispatchOutbound(
    { messageId: msg.id, leadId: fu.leadId, type: 'text', body: finalBody, followupId },
    { jobId: `out-fu-${msg.id}` }
  );

  return { ok: true, messageId: msg.id };
}
