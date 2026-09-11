/**
 * Helpers de fila pra IA responder o lead.
 *
 * O mesmo mecanismo cobre dois comportamentos:
 *
 * 1) **Debounce de digitação** — se o lead manda 3 mensagens em rajada
 *    dentro da janela `idleSecondsBeforeAi`, a IA processa apenas UMA vez
 *    ao final, com o histórico completo (o service carrega as últimas 20).
 *
 * 2) **Handoff de fila** — se um atendente HUMANO responder durante a espera,
 *    a IA não assume o atendimento: foi o humano quem respondeu.
 *
 * Como cada regime implementa isso:
 *
 *   Com Redis (Node/VPS)   `jobId` estável `ai-lead-{leadId}` no `aiQueue`.
 *                          Re-enfileirar remove o job pendente; o handoff
 *                          chama `cancelPendingReplyForLead`.
 *
 *   Sem Redis (Cloudflare) Não existe fila nem worker consumidor. A espera
 *                          acontece na própria invocação, dentro do
 *                          `waitUntil`, e o "cancelamento" é uma releitura
 *                          do banco: se a última mensagem da conversa mudou
 *                          durante a espera, esta invocação desiste — ou
 *                          chegou mensagem nova do lead (e a invocação mais
 *                          recente responde por todas), ou alguém já
 *                          respondeu (humano ou a própria IA).
 *
 * A regra que isto protege: **nunca dar por enfileirado um trabalho que
 * ninguém vai executar**. Antes desta correção o `aiQueue.add()` sem Redis
 * era um no-op silencioso — o webhook devolvia 200, o log dizia "IA
 * enfileirada", e o cliente nunca recebia resposta.
 */
import { aiQueue, QUEUES_ENABLED } from '@/lib/queue';
import { logger } from '@/lib/logger';
import { reads as messageReads } from '@/modules/messages/service';

function jobIdFor(leadId: string): string {
  return `ai-lead-${leadId}`;
}

/**
 * Teto da espera no modo inline. O `waitUntil` mantém a invocação viva depois
 * da resposta HTTP, mas não indefinidamente — uma unidade configurada com
 * `idleSecondsBeforeAi` alto (o campo aceita até 3600) não pode pendurar o
 * isolate. Acima disto a IA responde mais cedo do que o configurado, que é
 * melhor do que não responder.
 */
const MAX_INLINE_DEBOUNCE_MS = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Id da última mensagem da conversa — a "assinatura" do estado atual. */
async function lastMessageId(leadId: string): Promise<string | null> {
  const rows = await messageReads.byLead(leadId, { limit: 1, order: 'desc' });
  return rows[0]?.id ?? null;
}

/**
 * Espera o silêncio e responde, se ainda fizer sentido. Roda dentro do
 * `waitUntil` — nunca deixe escapar exceção daqui.
 */
async function inlineDebouncedReply(
  leadId: string,
  message: string,
  idleMs: number
): Promise<void> {
  try {
    const armedWith = await lastMessageId(leadId);

    if (idleMs > 0) await sleep(idleMs);

    const current = await lastMessageId(leadId);
    if (current !== armedWith) {
      // Ou o lead mandou outra mensagem (a invocação dela responde por todas),
      // ou humano/IA já falou. Nos dois casos esta desiste.
      logger.info(
        { leadId, armedWith, current },
        '[ai-agent:reply-queue] inline — desistiu: a conversa avançou durante a espera'
      );
      return;
    }

    const { handleLeadMessage } = await import('@/modules/ai-agent/service');
    const result = await handleLeadMessage(leadId, message);
    logger.info({ leadId, ...result }, '[ai-agent:reply-queue] inline — resposta processada');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, leadId },
      '[ai-agent:reply-queue] inline — falhou'
    );
  }
}

/**
 * Agenda a resposta da IA ao lead com espera = `idleSeconds`.
 *
 * Com fila: remove qualquer job pendente do mesmo lead antes — o mais recente
 * sempre vence, com o conteúdo da última mensagem.
 * Sem fila: executa em background, com o mesmo efeito de debounce.
 */
export async function enqueueReplyForLead(
  leadId: string,
  message: string,
  idleSeconds: number
): Promise<void> {
  const delayMs = Math.max(0, Math.floor(idleSeconds * 1_000));

  if (!QUEUES_ENABLED) {
    const idleMs = Math.min(delayMs, MAX_INLINE_DEBOUNCE_MS);
    logger.info(
      { leadId, idleMs, capped: idleMs !== delayMs },
      '[ai-agent:reply-queue] IA respondendo inline (sem Redis)'
    );
    // Awaited de proposito: quem chama ja roda dentro do `waitUntil` do
    // webhook, e herdar essa cadeia e mais seguro do que abrir outra — um
    // `waitUntil` aberto de dentro de outro pode ser recusado, e o trabalho
    // morreria calado, que e exatamente o bug que este caminho conserta.
    await inlineDebouncedReply(leadId, message, idleMs);
    return;
  }

  const jobId = jobIdFor(leadId);

  try {
    const existing = await aiQueue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      // Só remove se ainda não está processando. Estados dispatchable no
      // BullMQ atual: 'waiting' / 'delayed' / 'prioritized'. 'active' deixa.
      if (state === 'delayed' || state === 'waiting' || state === 'prioritized') {
        await existing.remove();
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId },
      '[ai-agent:reply-queue] falha removendo job IA antigo (segue)'
    );
  }

  await aiQueue.add(
    'reply-to-lead',
    { leadId, message },
    {
      jobId,
      delay: delayMs,
      removeOnComplete: true,
      removeOnFail: 50,
    }
  );
  logger.info(
    { leadId, delayMs, idleSeconds },
    '[ai-agent:reply-queue] IA enfileirada com delay'
  );
}

/**
 * Cancela a resposta pendente da IA — usado quando atendente humano responde
 * durante a janela de handoff. Retorna true se havia job e foi removido.
 *
 * Sem fila não há o que remover: a espera inline confere o estado da conversa
 * antes de responder e desiste sozinha ao ver a mensagem do humano. Retorna
 * false, que é a verdade — não havia job.
 */
export async function cancelPendingReplyForLead(leadId: string): Promise<boolean> {
  if (!QUEUES_ENABLED) return false;

  const jobId = jobIdFor(leadId);
  try {
    const existing = await aiQueue.getJob(jobId);
    if (!existing) return false;
    const state = await existing.getState();
    if (state === 'delayed' || state === 'waiting' || state === 'prioritized') {
      await existing.remove();
      logger.info(
        { leadId, jobId, prevState: state },
        '[ai-agent:reply-queue] IA cancelada — atendente humano respondeu antes do handoff'
      );
      return true;
    }
    return false;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId },
      '[ai-agent:reply-queue] falha cancelando job IA (segue)'
    );
    return false;
  }
}
