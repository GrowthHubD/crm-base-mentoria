/**
 * Socket.IO só aceita quem tem sessão, e no modo carteira só emite para quem
 * pode ver.
 *
 * Antes, o middleware do handshake só chamava `next()` e o cliente escolhia a
 * sala: qualquer processo conectado ao servidor Node recebia `message:new`
 * com o conteúdo das conversas, sem cookie nenhum.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getSession = vi.fn();
const selectRow = vi.fn();

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: (...a: unknown[]) => getSession(...a) } },
}));

vi.mock('@/lib/db/client', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => selectRow(),
        }),
      }),
    }),
  },
}));

import { authenticateSocket, registerSocketHandlers, emitToEmpresa } from '@/lib/socket';

beforeEach(() => {
  getSession.mockReset();
  selectRow.mockReset();
  delete process.env.FEATURE_LEAD_OWNERSHIP;
});

afterEach(() => {
  delete (global as { io?: unknown }).io;
});

describe('authenticateSocket', () => {
  it('sem cookie: recusa sem nem consultar a sessão', async () => {
    expect(await authenticateSocket(undefined)).toBeNull();
    expect(await authenticateSocket('')).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('cookie sem sessão válida: recusa', async () => {
    getSession.mockResolvedValue(null);
    expect(await authenticateSocket('better-auth.session_token=inventado')).toBeNull();
  });

  it('sessão válida mas usuário sumiu do banco: recusa', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    selectRow.mockResolvedValue([]);
    expect(await authenticateSocket('better-auth.session_token=ok')).toBeNull();
  });

  it('sessão válida: devolve id e papel vindos do banco, não do cookie', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    selectRow.mockResolvedValue([{ id: 'u1', role: 'admin' }]);
    expect(await authenticateSocket('better-auth.session_token=ok')).toEqual({ id: 'u1', role: 'admin' });
  });
});

describe('registerSocketHandlers', () => {
  function fakeIo() {
    const handlers: { use?: (s: unknown, n: (e?: Error) => void) => void; connection?: (s: unknown) => void } = {};
    const io = {
      use: (fn: typeof handlers.use) => { handlers.use = fn; },
      on: (ev: string, fn: (s: unknown) => void) => { if (ev === 'connection') handlers.connection = fn; },
    };
    return { io, handlers };
  }

  it('handshake sem sessão chama next com erro', async () => {
    const { io, handlers } = fakeIo();
    registerSocketHandlers(io as never);
    const next = vi.fn();
    await handlers.use!({ id: 's1', handshake: { headers: {} }, data: {} }, next);
    expect(next).toHaveBeenCalledOnce();
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('sessão válida: entra nas salas decididas pelo servidor, e join:empresa do cliente é ignorado', async () => {
    getSession.mockResolvedValue({ user: { id: 'u1' } });
    selectRow.mockResolvedValue([{ id: 'u1', role: 'admin' }]);
    const { io, handlers } = fakeIo();
    registerSocketHandlers(io as never);

    const next = vi.fn();
    const socket = {
      id: 's1',
      handshake: { headers: { cookie: 'better-auth.session_token=ok' } },
      data: {} as Record<string, unknown>,
      join: vi.fn(),
      on: vi.fn(),
    };
    await handlers.use!(socket, next);
    expect(next).toHaveBeenCalledWith();

    handlers.connection!(socket);
    const salas = socket.join.mock.calls.map((c) => c[0]);
    expect(salas).toEqual(['empresa:crm', 'user:u1', 'role:admin']);

    const joinEmpresa = socket.on.mock.calls.find((c) => c[0] === 'join:empresa')?.[1] as (id: string) => void;
    joinEmpresa('outra-empresa');
    expect(socket.join).toHaveBeenCalledTimes(3);
  });
});

describe('emitToEmpresa', () => {
  function fakeGlobalIo() {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    (global as { io?: unknown }).io = { to };
    return { to, emit };
  }

  it('sem modo carteira: sala da instância inteira', () => {
    const { to, emit } = fakeGlobalIo();
    emitToEmpresa('crm', 'message:new', { x: 1 }, { ownerId: 'o1' });
    expect(to).toHaveBeenCalledWith('empresa:crm');
    expect(emit).toHaveBeenCalledWith('message:new', { x: 1 });
  });

  it('modo carteira: admins + dono do lead', () => {
    process.env.FEATURE_LEAD_OWNERSHIP = 'true';
    const { to } = fakeGlobalIo();
    emitToEmpresa('crm', 'lead:updated', {}, { ownerId: 'o1' });
    expect(to).toHaveBeenCalledWith(['role:admin', 'user:o1']);
  });

  it('modo carteira sem dono conhecido: só admins — fecha, nunca abre', () => {
    process.env.FEATURE_LEAD_OWNERSHIP = 'true';
    const { to } = fakeGlobalIo();
    emitToEmpresa('crm', 'message:new', {});
    expect(to).toHaveBeenCalledWith(['role:admin']);
  });

  it('sem servidor Socket.IO (Cloudflare): não faz nada', () => {
    expect(() => emitToEmpresa('crm', 'x', {})).not.toThrow();
  });
});
