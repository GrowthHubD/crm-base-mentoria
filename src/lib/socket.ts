/**
 * Registro de handlers Socket.IO
 * Chamado pelo server.ts na inicialização
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { logger } from './logger';

export function registerSocketHandlers(io: SocketIOServer) {
  io.use((socket, next) => {
    // TODO: validar sessão better-auth via cookie/token no handshake
    next();
  });

  io.on('connection', (socket: Socket) => {
    logger.debug({ socketId: socket.id }, 'Socket conectado');

    // Cada empresa fica em sua própria sala
    socket.on('join:empresa', (empresaId: string) => {
      socket.join(`empresa:${empresaId}`);
      logger.debug({ socketId: socket.id, empresaId }, 'Socket entrou na sala');
    });

    socket.on('disconnect', () => {
      logger.debug({ socketId: socket.id }, 'Socket desconectado');
    });
  });
}

// Helper para emitir eventos para uma empresa (usado nos workers e API routes)
export function emitToEmpresa(empresaId: string, event: string, data: unknown) {
  const io = (global as unknown as { io?: SocketIOServer }).io;
  if (!io) return;
  io.to(`empresa:${empresaId}`).emit(event, data);
}
