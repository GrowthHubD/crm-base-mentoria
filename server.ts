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
import { registerSocketHandlers } from '@/lib/socket';
import { startWorkers, stopWorkers } from '@/workers';
import { logger } from '@/lib/logger';

const dev = process.env.NODE_ENV !== 'production';
const hostname = '0.0.0.0';
const port = parseInt(process.env.PORT ?? '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl);
  });

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin:
        process.env.NODE_ENV === 'production'
          ? process.env.NEXTAUTH_URL
          : [
              'http://localhost:3000',
              'http://localhost:3001',
              'http://localhost:9876',
              'http://127.0.0.1:9876',
            ],
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
