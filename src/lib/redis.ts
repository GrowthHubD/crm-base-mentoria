/**
 * Conexões Redis — só existem quando há Redis.
 *
 * Por que não é um `new Redis(...)` no topo: este módulo entra na árvore de
 * imports das rotas de webhook e de envio, e essas rotas rodam TAMBÉM no
 * Cloudflare Worker, onde não há socket TCP nem `net`. Construir o cliente no
 * import derrubava a rota inteira antes de qualquer linha de lógica — o
 * webhook respondia 500 e nenhuma mensagem entrava.
 *
 * Agora: sem `REDIS_URL`, `getRedis()` devolve null e o chamador executa o
 * trabalho inline. Com `REDIS_URL`, o cliente é criado na primeira chamada,
 * dentro do processo Node que de fato tem Redis (dev e workers BullMQ).
 */
import type Redis from 'ioredis';
import { logger } from './logger';

/** Vazio/ausente = modo inline. Não assumimos localhost: um default silencioso
 *  faz o Worker tentar conectar num Redis que não existe e falhar tarde. */
export const REDIS_URL = process.env.REDIS_URL?.trim() || null;

/** `true` quando há Redis configurado — logo, quando as filas BullMQ valem. */
export const QUEUES_ENABLED = REDIS_URL !== null;

let client: Redis | null = null;
let subscriber: Redis | null = null;

function create(label: string): Redis | null {
  if (!REDIS_URL) return null;
  // `require` tardio: no Worker esta linha nunca executa, então o bundler não
  // precisa resolver `ioredis` em runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const RedisCtor = require('ioredis') as typeof Redis;
  const conn = new RedisCtor(REDIS_URL, {
    maxRetriesPerRequest: null, // obrigatório para BullMQ
    enableReadyCheck: false,
    lazyConnect: true,
  });
  conn.on('connect', () => logger.info(`Redis conectado (${label})`));
  conn.on('error', (err) => logger.error({ err }, `Erro Redis (${label})`));
  return conn;
}

/** Conexão compartilhada (cache, BullMQ). Null = sem Redis, siga inline. */
export function getRedis(): Redis | null {
  if (!REDIS_URL) return null;
  if (!client) client = create('main');
  return client;
}

/** Conexão separada para pub/sub — o ioredis bloqueia comandos normais numa
 *  conexão em modo subscriber, por isso não dá pra reaproveitar a de cima. */
export function getRedisSub(): Redis | null {
  if (!REDIS_URL) return null;
  if (!subscriber) subscriber = create('sub');
  return subscriber;
}
