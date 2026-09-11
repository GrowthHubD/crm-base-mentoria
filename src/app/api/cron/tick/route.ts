/**
 * POST /api/cron/tick — a batida do relógio do produto.
 *
 * No Node, quatro coisas acordam sozinhas porque existe BullMQ: a escalação
 * do pipeline (repeatable job), as mensagens agendadas, os follow-ups e os
 * steps de automação (todos jobs `delayed`). No Cloudflare não há fila nem
 * worker — quem acorda é o Cron Trigger, e ele bate aqui.
 *
 * O tick não reimplementa regra nenhuma: varre o que já está vencido no banco
 * e chama exatamente as mesmas funções que o worker chamaria. A fonte da
 * verdade do agendamento sempre foi a linha no banco; o job do BullMQ era só
 * o despertador.
 *
 * Fechado por `CRON_SECRET` — responde 404 sem o header certo, pra não
 * confirmar a existência do endpoint pra quem varre a aplicação.
 */
import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { runEscalationPass } from '@/modules/pipeline/service';
import { listOverduePending as listOverdueScheduled } from '@/modules/scheduler/service';
import { listOverduePending as listOverdueFollowups } from '@/modules/followup/service';
import { runScheduledMessage, runFollowup } from '@/modules/scheduler/runner';
import { runOverdueSteps } from '@/modules/automations/service';
import { runBackup } from '@/modules/backup';
import {
  listPendingForRetry,
  markDone,
  markAttemptFailed,
  countFailed,
  pruneDone,
} from '@/modules/webhook-events';
import { reprocessWebhookEvent } from '@/modules/webhook-events/reprocess';

export const dynamic = 'force-dynamic';

/**
 * Teto por passada. O Worker tem tempo e subrequests limitados, e uma unidade
 * com backlog grande (servidor parado, madrugada inteira de follow-ups
 * represados) não pode tentar drenar tudo numa invocação só. O que sobra
 * continua vencido no banco e sai no minuto seguinte — o cron roda a cada 1
 * minuto. Quando trunca, o log diz quanto ficou pra trás: backlog silencioso
 * é o que faz parecer que "está tudo em dia".
 */
const BATCH = 25;

export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected || req.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const stats: Record<string, unknown> = {};

  // 1) Escalação do pipeline (Novo → Prioridade → Urgência).
  try {
    stats.escalation = await runEscalationPass();
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:tick] escalação falhou');
    stats.escalation = { error: true };
  }

  // 2) Mensagens agendadas pelo atendente.
  try {
    const due = await listOverdueScheduled();
    const batch = due.slice(0, BATCH);
    let sent = 0;
    for (const row of batch) {
      const result = await runScheduledMessage(row.id);
      if (result.ok) sent++;
    }
    stats.scheduled = { due: due.length, ran: batch.length, sent, deferred: Math.max(0, due.length - batch.length) };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:tick] agendadas falharam');
    stats.scheduled = { error: true };
  }

  // 3) Follow-ups automáticos.
  try {
    const due = await listOverdueFollowups();
    const batch = due.slice(0, BATCH);
    let sent = 0;
    for (const row of batch) {
      const result = await runFollowup(row.id);
      if (result.ok) sent++;
    }
    stats.followups = { due: due.length, ran: batch.length, sent, deferred: Math.max(0, due.length - batch.length) };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:tick] follow-ups falharam');
    stats.followups = { error: true };
  }

  // 4) Steps de automação vencidos.
  try {
    stats.automations = await runOverdueSteps(BATCH);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:tick] automações falharam');
    stats.automations = { error: true };
  }

  // 5) Webhooks (Cloud API e uazapi) que ficaram sem processar.
  //
  //    É a segunda metade do persist-first: a rota grava o evento e responde
  //    200; se o processamento falhar depois, a linha continua `pending` e a
  //    recuperação é aqui. Sem isto o evento ficaria salvo mas nunca virava
  //    mensagem — que é o mesmo prejuízo, só mais silencioso.
  try {
    const pending = await listPendingForRetry(BATCH);
    let recovered = 0;
    for (const row of pending) {
      try {
        await reprocessWebhookEvent(row);
        await markDone(row.id);
        recovered++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await markAttemptFailed(row.id, msg).catch(() => {});
        logger.warn({ eventId: row.id, err: msg }, '[cron:tick] reprocessamento de webhook falhou');
      }
    }
    const failed = await countFailed();
    stats.webhookEvents = { pending: pending.length, recovered, failed };
    // `failed` só cresce quando um evento esgotou as tentativas — é sinal de
    // olhar, não de retentar. Sobe no log pra aparecer sem precisar consultar.
    if (failed > 0) {
      logger.warn({ failed }, '[cron:tick] eventos de webhook em falha definitiva — exigem inspeção');
    }
    await pruneDone().catch(() => {});
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:tick] sweeper de webhooks falhou');
    stats.webhookEvents = { error: true };
  }

  // 5b) E-mails recebidos — a cada 2 minutos.
  //
  //     O tick roda de minuto em minuto; buscar a cada passada dobraria as
  //     chamadas à API do Google sem ganho perceptível para quem atende. Dois
  //     minutos é o intervalo em que a resposta do cliente ainda chega "na
  //     hora" para o atendente e o consumo de cota fica bem abaixo do limite.
  //
  //     Só faz alguma coisa onde há conta conectada; nas demais instalações a
  //     consulta encontra a lista vazia e sai.
  try {
    if (new Date().getUTCMinutes() % 2 === 0) {
      const { syncTodasAsContas } = await import('@/modules/email/ingest');
      const r = await syncTodasAsContas();
      if (r.contas > 0) stats.email = r;
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:tick] sync de e-mail falhou');
    stats.email = { error: true };
  }

  // 6) Backup diário — na primeira passada das 7h UTC (madrugada no Brasil).
  //
  //    O free do Supabase não tem backup nenhum, e o que está no banco é
  //    conversa de cliente de terceiro. Roda dentro do tick que já existe em
  //    vez de um cron próprio: menos uma peça, e o horário de madrugada evita
  //    competir com uso real.
  try {
    const agora = new Date();
    // DIÁRIO, e não mais semanal. Como não há PITR no free do Supabase, a
    // frequência do backup É a janela de perda: semanal significava "perdi até
    // sete dias de conversa"; diário reduz para um. O custo é sete vezes mais
    // objetos no R2, que continua irrisório perto dos 10 GB livres.
    const madrugada = agora.getUTCHours() === 7;
    // O tick roda a cada minuto — só a primeira passada da hora dispara.
    if (madrugada && agora.getUTCMinutes() === 0) {
      const result = await runBackup();
      stats.backup = { key: result.key, bytes: result.bytes, skipped: result.skipped.length };
      logger.info({ backup: result }, '[cron:tick] backup diário gravado');
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[cron:tick] backup falhou');
    stats.backup = { error: true };
  }

  logger.info({ stats }, '[cron:tick] passada concluída');
  return NextResponse.json({ ok: true, stats });
}
