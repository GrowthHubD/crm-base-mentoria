/**
 * Filas BullMQ — criadas sob demanda, e só quando há Redis.
 *
 * Dois runtimes muito diferentes importam este arquivo:
 *
 *   Node (npm run dev, VPS)      Redis presente. As filas existem, os workers
 *                                de `src/workers/` consomem, e vale tudo que
 *                                a fila dá: rate-limit, retry, backoff.
 *
 *   Cloudflare Worker            Não há Redis nem processo pra consumir. As
 *                                filas viram no-op e quem produz precisa
 *                                executar o trabalho INLINE — ver `dispatch.ts`.
 *
 * Antes, `new Queue(...)` rodava no import e derrubava qualquer rota que
 * tocasse este módulo dentro do Worker (o webhook respondia 500 antes de
 * executar uma linha). Agora nada é construído até alguém usar.
 *
 * O no-op é RUIDOSO de propósito: sem Redis, um `.add()` que some calado é
 * uma mensagem perdida sem rastro. Ele loga em nível warn com o nome da fila.
 */
import type { Queue } from 'bullmq';
import { getRedis, QUEUES_ENABLED } from './redis';
import { logger } from './logger';

export { QUEUES_ENABLED };

// Retry default: cobre cold-start de Postgres serverless (compute pausa após
// idle). 3 tentativas com backoff exponencial (2s, 4s).
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
};

const built = new Map<string, Queue>();

function buildQueue(name: string): Queue {
  const existing = built.get(name);
  if (existing) return existing;
  const connection = getRedis();
  if (!connection) throw new Error(`Fila "${name}" pedida sem Redis configurado`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Queue: QueueCtor } = require('bullmq') as typeof import('bullmq');
  const q = new QueueCtor(name, { connection, defaultJobOptions });
  built.set(name, q);
  return q;
}

/**
 * Fachada preguiçosa: encaminha para a fila real quando há Redis; degrada para
 * no-op avisado quando não há. Mantém a API (`.add`, `.getJob`, `.name`) usada
 * por dezenas de call sites, então ligar/desligar Redis não exige tocar neles.
 */
function lazyQueue(name: string): Queue {
  const noop = {
    name,
    async add(jobName: string) {
      logger.warn(
        { queue: name, job: jobName },
        '[queue] sem Redis — job NÃO enfileirado; o caminho inline precisa cobrir isso'
      );
      return null;
    },
    async getJob() { return null; },
    async remove() { return 0; },
  };

  return new Proxy({} as Queue, {
    get(_t, prop) {
      if (!QUEUES_ENABLED) {
        const fallback = (noop as Record<string | symbol, unknown>)[prop];
        return typeof fallback === 'function' ? fallback.bind(noop) : fallback;
      }
      const real = buildQueue(name) as unknown as Record<string | symbol, unknown>;
      const value = real[prop];
      return typeof value === 'function' ? value.bind(real) : value;
    },
  });
}

/** Mensagens recebidas via webhook. */
export const messageQueue = lazyQueue('messages');
/** Disparos de IA (agente e assist). */
export const aiQueue = lazyQueue('ai-agent');
/** Escalação automática de pipeline (Novo → Prioridade → Urgência). */
export const escalationQueue = lazyQueue('escalation');
/** Mensagens agendadas (follow-up, campanhas). */
export const schedulerQueue = lazyQueue('scheduler');
/** Envio de mensagens WhatsApp (rate-limited quando há Redis). */
export const sendQueue = lazyQueue('send');
/** Notificações internas (falha de API, alertas). */
export const notificationQueue = lazyQueue('notifications');

// NOTA: `token-refresh` (tokens do Instagram) e `payment-expiry` (PIX/PMS do
// motel) existiam aqui herdadas do fork e foram removidas — nenhuma tinha
// produtor neste produto. Não reintroduzir sem um worker que as consuma.

export const queues = {
  message: messageQueue,
  ai: aiQueue,
  escalation: escalationQueue,
  scheduler: schedulerQueue,
  send: sendQueue,
  notification: notificationQueue,
} as const;

export type QueueName = keyof typeof queues;
