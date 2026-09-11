/**
 * Persistência e reprocessamento de eventos crus de webhook.
 *
 * Regra que isto protege: **nunca responder 200 sem que o evento esteja
 * gravado**. Ver o comentário do schema — a Cloud API não retransmite, então
 * o 200 é irreversível e precisa significar "está salvo", não "vou tentar".
 */
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { webhookEvents } from '@/lib/db/schema/webhook-events';
import { logger } from '@/lib/logger';

/** Depois disso, para de retentar e exige olho humano. Cinco tentativas a cada
 *  minuto cobrem indisponibilidade curta de banco sem martelar para sempre. */
const MAX_ATTEMPTS = 5;

export interface RawEvent {
  provider: string;
  connectionId: string | null;
  /** Único por evento do provedor — é o que torna entrega duplicada inofensiva. */
  eventKey: string;
  payload: unknown;
}

/**
 * Grava o evento. Entrega duplicada é no-op silencioso (o UNIQUE resolve),
 * e devolvemos `false` pra quem chamou saber que não há trabalho novo.
 */
export async function persistEvent(event: RawEvent): Promise<{ id: string | null; isNew: boolean }> {
  const [row] = await db
    .insert(webhookEvents)
    .values({
      provider: event.provider,
      connectionIdText: event.connectionId,
      eventKey: event.eventKey,
      payload: event.payload as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: webhookEvents.eventKey })
    .returning({ id: webhookEvents.id });

  return { id: row?.id ?? null, isNew: !!row };
}

export async function markDone(id: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({ status: 'done', processedAt: new Date(), lastError: null })
    .where(eq(webhookEvents.id, id));
}

/**
 * Marca a tentativa falha. Ao cruzar `MAX_ATTEMPTS` o status vira `failed` e o
 * sweeper para de pegar — sem isso um evento envenenado seria retentado a cada
 * minuto para sempre, escondendo os eventos saudáveis atrás dele.
 */
export async function markAttemptFailed(id: string, error: string): Promise<void> {
  await db
    .update(webhookEvents)
    .set({
      attempts: sql`${webhookEvents.attempts} + 1`,
      lastError: error.slice(0, 500),
      status: sql`case when ${webhookEvents.attempts} + 1 >= ${MAX_ATTEMPTS} then 'failed' else 'pending' end`,
    })
    .where(eq(webhookEvents.id, id));
}

/**
 * Eventos pendentes prontos pra nova tentativa.
 *
 * O corte de 30s evita corrida com o processamento em `waitUntil` que acabou
 * de começar: sem ele, o cron pegaria o mesmo evento que a requisição ainda
 * está processando e a mensagem entraria duas vezes.
 */
export async function listPendingForRetry(limit = 20) {
  const cutoff = new Date(Date.now() - 30_000);
  return db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.status, 'pending'), lt(webhookEvents.receivedAt, cutoff)))
    .orderBy(asc(webhookEvents.receivedAt))
    .limit(limit);
}

/** Diagnóstico: quantos ficaram pelo caminho. Alimenta o /api/health. */
export async function countFailed(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEvents)
    .where(eq(webhookEvents.status, 'failed'));
  return row?.n ?? 0;
}

/** Remove eventos concluídos antigos — a tabela é fila, não arquivo. */
export async function pruneDone(olderThanDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .delete(webhookEvents)
    .where(and(eq(webhookEvents.status, 'done'), lt(webhookEvents.processedAt, cutoff)))
    .returning({ id: webhookEvents.id });
  if (rows.length) logger.debug({ removed: rows.length }, '[webhook-events] poda');
  return rows.length;
}
