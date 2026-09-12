/**
 * Socket.IO — só existe no servidor Node (`server.ts`); no Cloudflare não roda.
 *
 * O handshake EXIGE sessão do better-auth. O cookie chega no header do upgrade
 * e é validado como em `requireSession`: sessão válida E linha em `users`. Sem
 * isso, qualquer cliente Socket.IO — não precisa ser navegador — entrava na sala
 * e recebia `message:new` com o conteúdo das conversas.
 *
 * As salas são decididas AQUI, pelo servidor, a partir de quem está logado:
 * `empresa:crm` (a instância inteira), `user:<id>` e `role:admin`. O cliente
 * não escolhe sala — `join:empresa` ficou só como compatibilidade e é ignorado.
 *
 * No modo carteira-por-dono (`FEATURE_LEAD_OWNERSHIP`), o que sai pelo socket
 * respeita o mesmo recorte das rotas HTTP: admin vê tudo; atendente só o que é
 * do dono dele. Evento sem dono conhecido vai só para admins — o padrão é
 * fechar, nunca abrir.
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { escopoPorDonoAtivo } from './escopo-dono';
import { logger } from './logger';
import type { UserRole } from './auth-helpers';

export interface SocketUser {
  id: string;
  role: UserRole;
}

/**
 * Resolve o usuário a partir do cookie do handshake. `null` = recusar.
 *
 * `auth` e `db` entram por import dinâmico de propósito: este módulo é
 * importado pelos services (que rodam também no Worker e nos workers do
 * BullMQ) só pelo `emitToEmpresa`; carregar o better-auth em todos eles por
 * causa do handshake seria peso sem uso.
 */
export async function authenticateSocket(cookie: string | undefined): Promise<SocketUser | null> {
  if (!cookie) return null;
  const [{ auth }, { db }, { users }, { eq }] = await Promise.all([
    import('./auth'),
    import('./db/client'),
    import('./db/schema/users'),
    import('drizzle-orm'),
  ]);
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session?.user?.id) return null;
  const [row] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  return row ? { id: row.id, role: row.role as UserRole } : null;
}

export function registerSocketHandlers(io: SocketIOServer) {
  io.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket.handshake.headers.cookie);
      if (!user) {
        logger.warn({ socketId: socket.id }, 'Socket recusado: sem sessão');
        return next(new Error('unauthorized'));
      }
      socket.data.user = user;
      next();
    } catch (err) {
      logger.warn(
        { socketId: socket.id, err: err instanceof Error ? err.message : err },
        'Socket recusado: falha ao validar sessão'
      );
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as SocketUser;
    socket.join('empresa:crm');
    socket.join(`user:${user.id}`);
    if (user.role === 'admin') socket.join('role:admin');
    logger.debug({ socketId: socket.id, userId: user.id, role: user.role }, 'Socket conectado');

    // Compatibilidade com clientes antigos que ainda mandam o evento. A sala
    // já foi definida acima e o valor enviado não é usado.
    socket.on('join:empresa', () => {});

    socket.on('disconnect', () => {
      logger.debug({ socketId: socket.id, userId: user.id }, 'Socket desconectado');
    });
  });
}

export interface EmitAudience {
  /** Dono do lead a que o evento se refere. Só importa no modo carteira. */
  ownerId?: string | null;
}

/**
 * Emite para a instância. `empresaId` é legado (sempre `crm`) e fica na
 * assinatura para não tocar os chamadores.
 */
export function emitToEmpresa(empresaId: string, event: string, data: unknown, audience?: EmitAudience) {
  const io = (global as unknown as { io?: SocketIOServer }).io;
  if (!io) return;
  if (!escopoPorDonoAtivo()) {
    io.to(`empresa:${empresaId}`).emit(event, data);
    return;
  }
  const rooms = ['role:admin'];
  if (audience?.ownerId) rooms.push(`user:${audience.ownerId}`);
  io.to(rooms).emit(event, data);
}
