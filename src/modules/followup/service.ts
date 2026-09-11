/**
 * Service layer do followup — disparos sequenciais automatizados pela IA.
 *
 * Cada follow-up tem uma `instruction` (diretriz pro LLM) — a MENSAGEM em si
 * é gerada na hora do disparo via `generateFollowupForLead`, baseada no
 * histórico do lead + diretriz. Não há mais templates renderizados no
 * agendamento.
 *
 * Sem DEFAULT_INTERVALS: unidade que não configurou follow-up = nenhum
 * disparo. Admin deve configurar conscientemente em /agente-ia.
 */
import { db } from '@/lib/db/client';
import { followups } from '@/lib/db/schema/followups';
import { eq, and, lt, inArray } from 'drizzle-orm';
import { schedulerQueue } from '@/lib/queue';
import { reads as leadReads } from '@/modules/leads/service';
import { getConfigRow } from '@/modules/ai-agent/queries';
import type { FollowupRule } from '@/lib/db/schema/ai-agent-config';
import { logger } from '@/lib/logger';
import { readPlanFeatures } from '@/lib/plan';

export interface FollowupInterval {
  afterMinutes: number;
  /** Diretriz pra IA escrever a msg do follow-up. */
  instruction: string;
}

/**
 * Carrega regras de followup configuradas. Filtra desabilitadas ou sem
 * instruction/message preenchido. Vazio = não usa follow-up.
 *
 * Aceita configs legadas que ainda têm `message` (vira instruction se
 * `instruction` não foi preenchido). Sem nenhum dos dois = filtrada.
 */
async function loadRules(): Promise<FollowupRule[]> {
  const cfg = await getConfigRow();
  if (!cfg) return [];
  const list = (cfg.followups ?? []).filter(r => {
    if (!r || !r.enabled) return false;
    const text = (r.instruction ?? r.message ?? '').trim();
    return text.length > 0;
  });
  return list;
}

/**
 * True se a IA está totalmente desabilitada — toggle global OFF ou pausa de
 * emergência ativa. Nesse estado, NENHUM follow-up deve ser agendado nem
 * acumulado: quando o admin religar, não queremos disparos represados saindo
 * retroativamente.
 */
async function isAiOff(): Promise<boolean> {
  const cfg = await getConfigRow();
  if (!cfg) return true;
  if (!cfg.enabled) return true;
  if (cfg.pausedUntil && cfg.pausedUntil.getTime() > Date.now()) return true;
  return false;
}

/** Extrai a diretriz (instruction nova ou message legado). */
function ruleText(r: FollowupRule): string {
  return (r.instruction ?? r.message ?? '').trim();
}

/**
 * Agenda toda a sequência de followups pra um lead.
 *
 * `followups.body` armazena a DIRETRIZ (instruction) — não a msg renderizada.
 * Worker `scheduler.ts` chama generateFollowupForLead(leadId, body) na hora
 * do disparo pra gerar texto contextualizado via LLM.
 *
 * Não dispara nada se a unidade não tem regras de follow-up configuradas
 * (sem DEFAULT_INTERVALS — admin precisa configurar no /agente-ia).
 *
 * Também não dispara se lead já bloqueou IA (aiBlockedUntil > now): follow-up
 * é msg da IA, e a IA está silenciada por 24h pós-conversão.
 */
export async function scheduleSequenceForLead(
  leadId: string,
  intervals?: FollowupInterval[]
): Promise<{ scheduled: number }> {
  const lead = await leadReads.getById(leadId);
  if (!lead) return { scheduled: 0 };
  if (lead.status === 'converted' || lead.status === 'lost') return { scheduled: 0 };
  if (lead.aiBlockedUntil && lead.aiBlockedUntil.getTime() > Date.now()) return { scheduled: 0 };

  // IA global da unit desligada (toggle OFF ou pausada) → não agenda nada.
  // Follow-up é mensagem PROATIVA da IA — se a IA está desligada, nem
  // empilhar pra disparar depois. Quando o admin religar, o ciclo recomeça
  // a partir da próxima interação real.
  if (await isAiOff()) return { scheduled: 0 };

  // Toggle por-lead OFF também não agenda (consistente com generateFollowupForLead).
  if (!lead.aiAgentActive) return { scheduled: 0 };

  // Botão "Resolvido" no LeadModal sinaliza "atendente fechou aqui — não me
  // lembre". Enquanto resolvedAt está setado, NÃO agendamos follow-ups novos.
  // É reset automaticamente quando o lead manda inbound (clearLeadResolved).
  if (lead.resolvedAt) return { scheduled: 0 };

  // Se caller não passar intervals, carrega da unidade. Sem regras = sem disparo.
  let resolved: FollowupInterval[];
  if (intervals && intervals.length > 0) {
    resolved = intervals;
  } else {
    const rules = await loadRules();
    if (rules.length === 0) return { scheduled: 0 };
    resolved = rules.map(r => ({ afterMinutes: r.afterMinutes, instruction: ruleText(r) }));
  }

  const now = Date.now();
  let scheduled = 0;

  for (let i = 0; i < resolved.length; i++) {
    const cfg = resolved[i];
    if (!cfg.afterMinutes || cfg.afterMinutes <= 0) continue;
    if (!cfg.instruction || cfg.instruction.trim().length === 0) continue;
    const scheduledAt = new Date(now + cfg.afterMinutes * 60_000);

    const [created] = await db
      .insert(followups)
      .values({
        leadId,
        sequence: i + 1,
        // body guarda a DIRETRIZ — worker passa pra LLM gerar texto na hora.
        body: cfg.instruction,
        scheduledAt,
        status: 'pending',
      })
      .returning({ id: followups.id });

    const job = await schedulerQueue.add(
      'followup-message',
      { followupId: created.id },
      { delay: scheduledAt.getTime() - now, jobId: `fu-${created.id}` }
    );

    await db
      .update(followups)
      .set({ bullJobId: job?.id ?? `fu-${created.id}` })
      .where(eq(followups.id, created.id));

    scheduled++;
  }

  logger.info({ leadId, scheduled }, '[followup] sequência agendada');
  return { scheduled };
}

/**
 * Reseta o ciclo de follow-ups do lead: cancela pendentes e recria a sequência
 * a partir de agora. Chamado quando enviamos uma mensagem nova ao lead — o
 * relógio "X min sem resposta DO LEAD" precisa recomeçar.
 */
export async function rescheduleSequenceForLead(
  leadId: string
): Promise<{ scheduled: number }> {
  await cancelPendingByLead(leadId, 'rescheduled_after_outbound');

  // Follow-up automático é add-on PAGO, e a checagem fica aqui — na origem.
  //
  // Antes, o que impedia um cliente sem o módulo de receber follow-up era não
  // existir tela para configurar a regra: `loadRules()` voltava vazio e nada
  // disparava. Isso é gating por acidente, não por regra. Bastava uma linha
  // entrar em `ai_agent_config.followups` por um seed, uma migração ou um
  // reprocessamento para o cliente passar a mandar mensagem automática que
  // ninguém vendeu — e para o lead dele receber texto escrito por uma IA que o
  // dono do negócio não contratou.
  //
  // O agendamento MANUAL não passa por aqui: ele é do plano base e continua
  // funcionando normalmente.
  if (!readPlanFeatures().followups) return { scheduled: 0 };

  const rules = await loadRules();
  if (rules.length === 0) return { scheduled: 0 };
  return scheduleSequenceForLead(
    leadId,
    rules.map(r => ({ afterMinutes: r.afterMinutes, instruction: ruleText(r) }))
  );
}

/**
 * Cancela followups pendentes do lead. Chamado quando lead responde (volta a
 * engajar) ou quando é convertido/perdido.
 */
export async function cancelPendingByLead(leadId: string, reason: string = 'lead_responded'): Promise<number> {
  const pendings = await db
    .select({ id: followups.id, bullJobId: followups.bullJobId })
    .from(followups)
    .where(and(eq(followups.leadId, leadId), eq(followups.status, 'pending')));

  if (pendings.length === 0) return 0;

  // CRÍTICO: marca status no DB ANTES de tentar remover do BullMQ. Se o job
  // já está active (em execução), job.remove() falha silenciosamente — sem
  // essa marcação no DB primeiro, o follow-up dispararia mesmo cancelado
  // (bug do incidente de 30/05).
  const finalStatus = reason === 'lead_responded' ? 'responded' : 'cancelled';
  await db
    .update(followups)
    .set({ status: finalStatus, metadata: { reason } })
    .where(inArray(followups.id, pendings.map(p => p.id)));

  for (const p of pendings) {
    if (!p.bullJobId) continue;
    try {
      const job = await schedulerQueue.getJob(p.bullJobId);
      if (job) await job.remove();
    } catch {
      // best-effort
    }
  }
  return pendings.length;
}

/**
 * Cancela TODOS os follow-ups pendentes — usado pelo botão "Pausar IA" no
 * /agente-ia quando o admin precisa parar tudo de uma vez.
 *
 * Marca status='cancelled' no DB ANTES de tentar remover do BullMQ — assim,
 * mesmo se o job já estiver `active` (não-removível), o scheduler.ts re-lê
 * o status antes de processar e aborta.
 */
export async function cancelPendingByUnit(reason: string = 'unit_paused'): Promise<number> {
  const pendings = await db
    .select({ id: followups.id, bullJobId: followups.bullJobId })
    .from(followups)
    .where(eq(followups.status, 'pending'));

  if (pendings.length === 0) return 0;

  // 1) Marca status no DB primeiro — barreira de segurança caso job já esteja active.
  await db
    .update(followups)
    .set({ status: 'cancelled', metadata: { reason } })
    .where(inArray(followups.id, pendings.map(p => p.id)));

  // 2) Remove jobs do BullMQ (best-effort — jobs active não-removíveis serão
  //    abortados pelo scheduler.ts ao ver status != pending).
  for (const p of pendings) {
    if (!p.bullJobId) continue;
    try {
      const job = await schedulerQueue.getJob(p.bullJobId);
      if (job) await job.remove();
    } catch {
      // best-effort
    }
  }

  logger.info({ cancelled: pendings.length, reason }, '[followup] cancelados em massa');
  return pendings.length;
}

export async function markSent(id: string): Promise<void> {
  await db.update(followups).set({ status: 'sent', sentAt: new Date() }).where(eq(followups.id, id));
}

export async function markFailed(id: string, error: string): Promise<void> {
  await db.update(followups).set({ status: 'cancelled', metadata: { error } }).where(eq(followups.id, id));
}

export async function getById(id: string) {
  const [row] = await db.select().from(followups).where(eq(followups.id, id)).limit(1);
  return row;
}

export async function listOverduePending() {
  const rows = await db
    .select()
    .from(followups)
    .where(and(eq(followups.status, 'pending'), lt(followups.scheduledAt, new Date())))
    .limit(500);
  return rows;
}

// ─── Janela de horário comercial pra follow-ups ────────────────────────────
// Follow-ups são MENSAGENS PROATIVAS da IA — não podem cair de madrugada nem
// na hora do almoço. Respostas REATIVAS da IA continuam 24h.
// Janela default: 8h-18h hora local do servidor (VPS roda em America/Sao_Paulo,
// confirmado via `timedatectl`). Configurável via env pra ajuste rápido.

const FOLLOWUP_WINDOW_START_HOUR = parseInt(
  process.env.FOLLOWUP_WINDOW_START_HOUR ?? '8',
  10
);
const FOLLOWUP_WINDOW_END_HOUR = parseInt(
  process.env.FOLLOWUP_WINDOW_END_HOUR ?? '18',
  10
);

/**
 * True se o instante está dentro da janela permitida pra disparar follow-up.
 * Janela é meio-aberta: [start, end). 18h00 já é fora.
 */
export function isWithinFollowupWindow(date: Date = new Date()): boolean {
  const h = date.getHours();
  return h >= FOLLOWUP_WINDOW_START_HOUR && h < FOLLOWUP_WINDOW_END_HOUR;
}

/**
 * Próximo instante de abertura da janela (HH:00:00) a partir de `from`.
 * - Antes da abertura no mesmo dia → hoje no horário de start.
 * - Já dentro da janela → retorna `from` (no-op).
 * - Depois do fechamento → amanhã no horário de start.
 */
export function nextFollowupWindowOpen(from: Date = new Date()): Date {
  if (isWithinFollowupWindow(from)) return from;
  const next = new Date(from);
  const h = from.getHours();
  if (h >= FOLLOWUP_WINDOW_END_HOUR) {
    next.setDate(next.getDate() + 1);
  }
  next.setHours(FOLLOWUP_WINDOW_START_HOUR, 0, 0, 0);
  return next;
}

