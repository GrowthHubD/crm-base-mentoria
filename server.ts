/**
 * Custom HTTP server — integra Next.js 15 + Socket.IO + BullMQ workers.
 * Iniciado via `tsx server.ts` (dev) ou PM2 (produção)
 * NUNCA use `output: 'standalone'` ou edge runtime — incompatível com Socket.IO/BullMQ.
 */
import 'dotenv/config';
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server as SocketIOServer } from 'socket.io';
import { logger } from '@/lib/logger';

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT ?? '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  // Socket e workers importam módulos que puxam `next/server`; carregados
  // antes do `prepare()` o servidor caía na primeira requisição.
  const [{ registerSocketHandlers, isSocketOriginAllowed }, { startWorkers, stopWorkers }] = await Promise.all([
    import('@/lib/socket'),
    import('@/workers'),
  ]);
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, callback) => callback(null, isSocketOriginAllowed(origin)),
      credentials: true,
    },
  });

  registerSocketHandlers(io);
  (global as unknown as { io: SocketIOServer }).io = io;

  // Boot dos workers BullMQ (best-effort; falha não derruba HTTP)
  // Em ambiente sem Redis, isso vai logar erros mas continuar — workers ficam idle.
  startWorkers().catch((err) => {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      '[server] falha bootando workers (HTTP segue funcionando)'
    );
  });

  httpServer.listen(port, hostname, () => {
    console.log(
      `> Servidor pronto em http://${hostname}:${port} [${dev ? 'dev' : 'produção'}]`
    );
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[server] shutdown iniciado');
    await stopWorkers().catch(() => {});
    httpServer.close(() => {
      logger.info('[server] HTTP fechado');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
