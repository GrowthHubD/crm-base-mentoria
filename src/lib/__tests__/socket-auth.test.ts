/**
 * Socket.IO sobre transporte REAL (servidor em porta efêmera de loopback):
 * quem entra, quem recebe e quem é derrubado.
 *
 * Duas falhas por trás destes casos: o handshake que só chamava `next()`
 * (qualquer processo recebia `message:new`), e depois a versão por salas, que
 * autenticava mas entregava evento de uma filial a atendente de outra e, no
 * modo carteira, deixava o próprio dono sem evento porque os services não
 * informavam o dono. Aqui cada caso mede a entrega de verdade, positiva e
 * negativa, com sessão e banco simulados.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { io as connect, type Socket } from 'socket.io-client';

const state = vi.hoisted(() => ({
  users: new Map<string, Record<string, unknown>>(),
  leads: new Map<string, Record<string, unknown>>(),
  messages: new Map<string, Record<string, unknown>>(),
  revoked: new Set<string>(),
  fail: false,
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: async ({ headers }: { headers: Headers }) => {
        const id = headers.get('cookie') ?? '';
        return state.users.has(id) && !state.revoked.has(id) ? { user: { id } } : null;
      },
    },
  },
}));

vi.mock('@/lib/db/client', async () => {
  const { getTableName } = await import('drizzle-orm');
  return {
    db: {
      select: () => ({
        from: (table: never) => ({
          where: (sql: { queryChunks: { value?: string }[] }) => ({
            limit: async () => {
              if (state.fail) throw new Error('database unavailable');
              const id = sql.queryChunks.find((c) => typeof c.value === 'string')?.value ?? '';
              const name = getTableName(table);
              const rows = name === 'users' ? state.users : name === 'leads' ? state.leads : state.messages;
              const row = rows.get(id);
              return row ? [row] : [];
            },
          }),
        }),
      }),
    },
  };
});

import { registerSocketHandlers, emitToEmpresa, authenticateSocket } from '@/lib/socket';

let server: Server;
let url: string;
const clients: Socket[] = [];

beforeEach(async () => {
  state.users.clear();
  state.leads.clear();
  state.messages.clear();
  state.revoked.clear();
  state.fail = false;
  vi.stubEnv('FEATURE_UNITS', 'true');
  vi.stubEnv('FEATURE_LEAD_OWNERSHIP', 'false');
  vi.stubEnv('NEXTAUTH_URL', 'http://localhost:9876');
  const http = createServer();
  server = new Server(http);
  registerSocketHandlers(server);
  (globalThis as { io?: Server }).io = server;
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete (globalThis as { io?: Server }).io;
  vi.unstubAllEnvs();
});

async function user(id: string, role = 'attendant', unitId: string | null = 'a') {
  state.users.set(id, { id, role, unitId });
  const client = connect(url, { transports: ['websocket'], reconnection: false, extraHeaders: { Cookie: id } });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
  return client;
}

async function rejected(headers: Record<string, string>) {
  const client = connect(url, { transports: ['websocket'], reconnection: false, extraHeaders: headers });
  clients.push(client);
  return new Promise<string>((resolve, reject) => {
    client.once('connect_error', (e) => resolve(e.message));
    client.once('connect', () => reject(new Error('unexpected authentication')));
  });
}

async function deliver(event: string, payload: unknown, audience?: { unitId?: string | null; ownerId?: string | null }) {
  const received: string[] = [];
  for (const c of clients) c.once(event, () => received.push(c.id!));
  await emitToEmpresa('LEGACY_ROOM', event, payload, audience);
  // Deixa o transporte de loopback drenar antes de afirmar entrega ou ausência.
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const c of clients) c.removeAllListeners(event);
  return received;
}

describe('Socket.IO autenticado sobre transporte real', () => {
  it('recusa anônimo e sessão inventada', async () => {
    expect(await authenticateSocket(undefined)).toBeNull();
    expect(await rejected({})).toBe('unauthorized');
    expect(await rejected({ Cookie: 'invented' })).toBe('unauthorized');
  });

  it('recusa origem hostil mesmo com sessão válida', async () => {
    state.users.set('valid', { id: 'valid', role: 'admin', unitId: null });
    expect(await rejected({ Cookie: 'valid', Origin: 'https://attacker.invalid' })).toBe('unauthorized');
  });

  it('sessão revogada é derrubada antes do próximo evento', async () => {
    const c = await user('one');
    state.leads.set('l1', { unitId: 'a', ownerId: 'one' });
    expect(await deliver('lead:updated', { leadId: 'l1' })).toContain(c.id);
    state.revoked.add('one');
    expect(await deliver('lead:updated', { leadId: 'l1' })).toEqual([]);
    expect(c.connected).toBe(false);
  });

  it('banco fora do ar: fecha, sem estourar no chamador', async () => {
    await user('one');
    state.fail = true;
    expect(await deliver('message:new', { message: { leadId: 'l1' } })).toEqual([]);
  });

  it('mensagem vai só para a unidade do lead e para o admin global; sala pedida é ignorada', async () => {
    const a = await user('a');
    const b = await user('b', 'attendant', 'b');
    const globalAdmin = await user('admin', 'admin', null);
    const localAdmin = await user('localAdmin', 'admin', 'b');
    b.emit('join:empresa', 'a');
    state.leads.set('l1', { unitId: 'a', ownerId: 'a' });
    expect((await deliver('message:new', { message: { leadId: 'l1', body: 'private' } })).sort()).toEqual(
      [a.id, globalAdmin.id].sort()
    );
    expect(localAdmin.connected).toBe(true);
  });

  it('modo carteira: resolve o dono sem quarto argumento e intersecta com a unidade', async () => {
    vi.stubEnv('FEATURE_LEAD_OWNERSHIP', 'true');
    const a = await user('a');
    await user('b');
    const admin = await user('admin', 'admin', null);
    state.leads.set('l1', { unitId: 'a', ownerId: 'a' });
    expect((await deliver('message:new', { message: { leadId: 'l1' } })).sort()).toEqual([a.id, admin.id].sort());
    state.leads.set('l1', { unitId: 'b', ownerId: 'a' });
    expect(await deliver('lead:updated', { leadId: 'l1' })).toEqual([admin.id]);
  });

  it('fila compartilhada continua igual quando os dois recortes estão desligados', async () => {
    vi.stubEnv('FEATURE_UNITS', 'false');
    const a = await user('a');
    const b = await user('b', 'attendant', 'b');
    expect((await deliver('lead:updated', { leadId: 'l1' })).sort()).toEqual([a.id, b.id].sort());
  });

  it('lead sem unidade é visível como no HTTP; lead sem dono fica só com admin no modo carteira', async () => {
    const a = await user('a');
    const admin = await user('admin', 'admin', null);
    state.leads.set('l1', { unitId: null, ownerId: null });
    expect((await deliver('lead:updated', { leadId: 'l1' })).sort()).toEqual([a.id, admin.id].sort());
    vi.stubEnv('FEATURE_LEAD_OWNERSHIP', 'true');
    expect(await deliver('lead:updated', { leadId: 'l1' })).toEqual([admin.id]);
  });

  it('status resolve pelo id da mensagem; exclusão usa o recorte que o service manda', async () => {
    const a = await user('a');
    await user('b', 'attendant', 'b');
    state.leads.set('l1', { unitId: 'a', ownerId: 'a' });
    state.messages.set('m1', { leadId: 'l1' });
    expect(await deliver('message:statusChanged', { messageId: 'm1', status: 'sent' })).toEqual([a.id]);
    state.messages.delete('m1');
    expect(await deliver('message:deleted', { messageId: 'm1', leadId: 'l1' })).toEqual([a.id]);
    state.leads.delete('l1');
    expect(await deliver('lead:deleted', { leadId: 'l1' }, { unitId: 'a', ownerId: 'a' })).toEqual([a.id]);
    expect(await deliver('lead:updated', { leadId: 'unknown' })).toEqual([]);
  });

  it('troca de unidade vale para quem já está conectado', async () => {
    const a = await user('a');
    state.leads.set('l1', { unitId: 'a', ownerId: 'a' });
    expect(await deliver('lead:updated', { leadId: 'l1' })).toEqual([a.id]);
    state.users.set('a', { id: 'a', role: 'attendant', unitId: 'b' });
    expect(await deliver('lead:updated', { leadId: 'l1' })).toEqual([]);
  });
});
