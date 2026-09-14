/**
 * Socket.IO — só existe no servidor Node (`server.ts`); no Cloudflare não roda.
 *
 * Entrega em tempo real autenticada E autorizada pelo servidor. Não há salas:
 * o cliente não escolhe escopo nenhum. A cada emissão o servidor resolve a
 * quem o evento pertence (lead → unidade e dono) e, para CADA socket aberto,
 * revalida a sessão antes de entregar. Logout, sessão revogada, troca de papel
 * ou de unidade valem para conexões já abertas — autorizar só no handshake
 * deixava um acesso velho vivo até o cliente desconectar.
 *
 * A visibilidade é a INTERSEÇÃO das regras das rotas HTTP (`lib/units.ts` e
 * `lib/escopo-dono.ts`), nunca a união: usuário preso a uma unidade não vê
 * outra, e no modo carteira só o dono (ou admin) recebe. Evento cujo lead não
 * se resolve não é entregue a ninguém — fecha, nunca abre.
 *
 * Custo: uma consulta de lead por evento e uma revalidação por socket
 * conectado. Só existe quando há socket conectado — sem cliente, a fila
 * devolve antes de tocar o banco. As telas hoje usam polling, não socket.
 */
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from './logger';
import type { UserRole } from './auth-helpers';
import { unidadesAtivas } from './units';
import { escopoPorDonoAtivo } from './escopo-dono';

export interface SocketUser {
  id: string;
  role: UserRole;
  unitId: string | null;
}

// `auth` e `db` entram por import dinâmico: este módulo é importado pelos
// services (que rodam também no Worker e nos workers do BullMQ) só pelo
// `emitToEmpresa`; carregar o better-auth em todos eles seria peso sem uso.
const loadAuthModules = () =>
  Promise.all([import('./auth'), import('./db/client'), import('./db/schema/users'), import('drizzle-orm')]);
let authModules: ReturnType<typeof loadAuthModules> | undefined;

/** Resolve o usuário a partir do cookie. `null` = recusar. Sempre consulta o banco. */
export async function authenticateSocket(cookie: string | undefined): Promise<SocketUser | null> {
  if (!cookie) return null;
  const [{ auth }, { db }, { users }, { eq }] = await (authModules ??= loadAuthModules());
  const session = await auth.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableCookieCache: true },
  });
  if (!session?.user?.id) return null;
  const [row] = await db
    .select({ id: users.id, role: users.role, unitId: users.unitId })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  return row ? { id: row.id, role: row.role as UserRole, unitId: row.unitId ?? null } : null;
}

/**
 * Origem do navegador tem que ser um dos domínios de login configurados.
 * Cliente sem `Origin` (não-navegador) passa daqui, mas ainda precisa da
 * sessão — CORS não é autorização.
 */
export function isSocketOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const requested = new URL(origin);
    if (!['http:', 'https:'].includes(requested.protocol)) return false;
    const configured = [
      process.env.BETTER_AUTH_URL,
      process.env.NEXTAUTH_URL,
      ...(process.env.EXTRA_TRUSTED_ORIGINS ?? '').split(','),
    ].filter(Boolean) as string[];
    if (configured.length === 0) configured.push(`http://localhost:${process.env.PORT || '3000'}`);
    const allowed = configured.some((value) => {
      try {
        const target = new URL(value.trim());
        return requested.host.replace(/^www\./, '') === target.host.replace(/^www\./, '');
      } catch {
        return false;
      }
    });
    if (allowed) return true;
    return (
      process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1'].includes(requested.hostname) &&
      ['3000', '3001', '9876', process.env.PORT].includes(requested.port)
    );
  } catch {
    return false;
  }
}

export function registerSocketHandlers(io: SocketIOServer) {
  io.use(async (socket, next) => {
    try {
      if (!isSocketOriginAllowed(socket.handshake.headers.origin)) return next(new Error('unauthorized'));
      const user = await authenticateSocket(socket.handshake.headers.cookie);
      if (!user) return next(new Error('unauthorized'));
      socket.data.user = user;
      next();
    } catch {
      // Nunca logar cookie, token de sessão ou erro que carregue headers.
      logger.warn({ socketId: socket.id }, 'Socket recusado: falha ao validar sessão');
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    // Compatibilidade: cliente antigo ainda manda o evento; ele não escolhe escopo.
    socket.on('join:empresa', () => {});
  });
}

export interface EmitAudience {
  ownerId?: string | null;
  unitId?: string | null;
}

/**
 * Descobre a quem o evento pertence a partir do próprio payload (lead direto,
 * lead dentro da mensagem, ou mensagem → lead). Só a exclusão de lead recebe
 * o recorte pronto do service, porque a linha já não existe para consultar.
 */
async function resolveAudience(
  _empresaId: string,
  event: string,
  data: unknown,
  audience?: EmitAudience
): Promise<EmitAudience | null> {
  if (!unidadesAtivas() && !escopoPorDonoAtivo()) return {};
  if (event === 'lead:deleted' && audience) return audience;
  const payload = data as
    | { leadId?: string; lead?: { id?: string }; messageId?: string; message?: { leadId?: string } }
    | null;
  let leadId = payload?.leadId ?? payload?.lead?.id ?? payload?.message?.leadId;
  const [{ db }, { leads }, { eq }] = await Promise.all([
    import('./db/client'),
    import('./db/schema/leads'),
    import('drizzle-orm'),
  ]);
  if (!leadId && payload?.messageId) {
    const { messages } = await import('./db/schema/messages');
    const [message] = await db
      .select({ leadId: messages.leadId })
      .from(messages)
      .where(eq(messages.id, payload.messageId))
      .limit(1);
    leadId = message?.leadId;
  }
  if (leadId) {
    const [lead] = await db
      .select({ ownerId: leads.ownerId, unitId: leads.unitId })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    return lead ?? null;
  }
  return null;
}

/** Interseção das regras de visibilidade das rotas HTTP — nunca união de unidade/dono. */
export function canReceiveSocketEvent(user: SocketUser, audience: EmitAudience | null): boolean {
  if (!unidadesAtivas() && !escopoPorDonoAtivo()) return true;
  if (!audience) return false;
  const unitAllowed =
    !unidadesAtivas() ||
    !user.unitId ||
    (audience.unitId !== undefined && (!audience.unitId || audience.unitId === user.unitId));
  const ownerAllowed = !escopoPorDonoAtivo() || user.role === 'admin' || audience.ownerId === user.id;
  return unitAllowed && ownerAllowed;
}

// Emissões em série: a autorização é assíncrona e a ordem mensagem → status
// precisa sobreviver a ela.
const pending = new WeakMap<SocketIOServer, { tail: Promise<void>; count: number }>();

/**
 * Emite para a instância. `empresaId` é legado (sempre `crm`) e fica na
 * assinatura para não tocar os chamadores. Devolve a promise da entrega; os
 * chamadores não precisam esperar.
 */
export function emitToEmpresa(
  empresaId: string,
  event: string,
  data: unknown,
  audience?: EmitAudience
): Promise<void> {
  const io = (globalThis as unknown as { io?: SocketIOServer }).io;
  if (!io) return Promise.resolve(); // Cloudflare / worker de fila: nada a fazer.
  let queue = pending.get(io);
  if (!queue) {
    queue = { tail: Promise.resolve(), count: 0 };
    pending.set(io, queue);
  }
  // Se autenticação ou banco caírem, a fila não cresce sem teto: derruba todo
  // mundo e os clientes reconectam e refazem o estado pelo HTTP autorizado.
  if (queue.count >= 256) {
    io.disconnectSockets(true);
    logger.warn('Socket: fila de eventos estourou; clientes precisam ressincronizar');
    return Promise.resolve();
  }
  queue.count++;
  queue.tail = queue.tail
    .then(async () => {
      if (io.sockets.sockets.size === 0) return;
      const scope = await resolveAudience(empresaId, event, data, audience);
      await Promise.all(
        Array.from(io.sockets.sockets.values(), async (socket) => {
          try {
            const user = await authenticateSocket(socket.handshake.headers.cookie);
            if (!user) {
              socket.disconnect(true);
              return;
            }
            socket.data.user = user;
            if (socket.connected && canReceiveSocketEvent(user, scope)) socket.emit(event, data);
          } catch {
            socket.disconnect(true);
            logger.warn({ socketId: socket.id }, 'Socket: autorização indisponível, conexão derrubada');
          }
        })
      );
    })
    .catch(() => {
      logger.warn({ event }, 'Socket: evento retido, autorização indisponível');
    })
    .finally(() => {
      queue!.count--;
    });
  return queue.tail;
}
