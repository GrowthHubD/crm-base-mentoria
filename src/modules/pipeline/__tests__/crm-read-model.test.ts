import { describe, expect, it } from 'vitest';
import {
  acceptsBoardResponse,
  boardClockBucket,
  boardSignature,
  crmQueuesRequestPath,
  crmScopeKey,
  mergeQueuesResponse,
  shouldRefreshConnections,
  type QueuesResponse,
} from '@/modules/pipeline/crm-read-model';

function board(overrides: Record<string, unknown> = {}): QueuesResponse {
  const lead = {
    id: 'lead-1',
    status: 'new',
    stageId: null,
    name: 'Pessoa A',
    phone: '5511000000000',
    lastMessage: 'Oi',
    lastMessageAt: '2026-09-04T12:00:00.000Z',
    unread: true,
    assignedToId: null,
    assignedToName: null,
    ownerId: 'user-a',
    ownerName: 'Usuario A',
    aiAgentActive: false,
    aiPausedUntil: null,
    awaitingSeconds: 10,
    attendants: [],
    ...overrides,
  };
  return {
    queues: {
      novos: [lead],
      prioridade: [],
      urgencia: [],
      respondidos: [],
      convertidos: [],
    },
    connections: [{ id: 'connection-a', name: 'Numero A', type: 'whatsapp' }],
  } as unknown as QueuesResponse;
}

describe('crmScopeKey', () => {
  it('isola usuario, unidade e conexao', () => {
    const base = crmScopeKey('user-a', 'unit-a', 'connection-a');
    expect(crmScopeKey('user-b', 'unit-a', 'connection-a')).not.toBe(base);
    expect(crmScopeKey('user-a', 'unit-b', 'connection-a')).not.toBe(base);
    expect(crmScopeKey('user-a', 'unit-a', 'connection-b')).not.toBe(base);
  });

  it('nao produz colisao por concatenacao ambigua', () => {
    expect(crmScopeKey('ab', 'c', 'd')).not.toBe(crmScopeKey('a', 'bc', 'd'));
  });
});

describe('acceptsBoardResponse', () => {
  it('aceita somente a resposta do escopo e da sequencia ainda ativos', () => {
    expect(acceptsBoardResponse('user-a', 'user-a', 3, 3)).toBe(true);
    expect(acceptsBoardResponse('user-b', 'user-a', 3, 3)).toBe(false);
    expect(acceptsBoardResponse('user-a', 'user-a', 4, 3)).toBe(false);
  });
});

describe('poll leve do board', () => {
  it('preserva conexoes do snapshot completo ao receber somente filas', () => {
    const previous = board();
    const nextQueues = board({ name: 'Pessoa B' }).queues;

    expect(mergeQueuesResponse(previous, { queues: nextQueues })).toEqual({
      queues: nextQueues,
      connections: previous.connections,
    });
  });

  it('rejeita resposta parcial quando nao existe snapshot completo', () => {
    expect(mergeQueuesResponse(undefined, { queues: board().queues })).toBeNull();
  });

  it('substitui conexoes quando a resposta e completa', () => {
    const previous = board();
    const incoming = board();
    incoming.connections = [{ id: 'connection-b', name: 'Numero B', type: 'whatsapp' }];

    expect(mergeQueuesResponse(previous, incoming)?.connections).toEqual(incoming.connections);
  });

  it('atualiza conexoes no primeiro load e depois do TTL', () => {
    expect(shouldRefreshConnections(undefined, 10_000)).toBe(true);
    expect(shouldRefreshConnections(10_000, 69_999)).toBe(false);
    expect(shouldRefreshConnections(10_000, 70_000)).toBe(true);
  });

  it('monta URL leve sem perder o filtro de conexao', () => {
    expect(crmQueuesRequestPath('connection a', false)).toBe(
      '/api/crm/queues?connectionId=connection+a&includeConnections=0'
    );
    expect(crmQueuesRequestPath('all', false)).toBe('/api/crm/queues?includeConnections=0');
    expect(crmQueuesRequestPath('email', true)).toBe('/api/crm/queues');
  });
});

describe('boardSignature', () => {
  it('permanece estavel para o mesmo payload', () => {
    const data = board();
    expect(boardSignature(data)).toBe(boardSignature(data));
  });

  it.each([
    ['name', 'Pessoa B'],
    ['lastMessage', 'Mensagem nova'],
    ['ownerId', 'user-b'],
    ['unread', false],
  ])('detecta mudanca visual em %s', (field, value) => {
    expect(boardSignature(board({ [field]: value }), 100_000)).not.toBe(
      boardSignature(board(), 100_000)
    );
  });

  it('nao invalida o quadro por diferenca de segundos dentro do mesmo bucket', () => {
    expect(boardSignature(board({ awaitingSeconds: 11 }), 100_000)).toBe(
      boardSignature(board({ awaitingSeconds: 19 }), 100_000)
    );
  });
});

describe('boardClockBucket', () => {
  it('avanca a cada dez segundos quando existe espera abaixo de um minuto', () => {
    const data = board({ awaitingSeconds: 30 });
    expect(boardClockBucket(data, 19_999)).toBe(boardClockBucket(data, 10_000));
    expect(boardClockBucket(data, 20_000)).not.toBe(boardClockBucket(data, 19_999));
  });

  it('avanca somente a cada minuto para esperas mais longas', () => {
    const data = board({ awaitingSeconds: 120 });
    expect(boardClockBucket(data, 59_999)).toBe(boardClockBucket(data, 1_000));
    expect(boardClockBucket(data, 60_000)).not.toBe(boardClockBucket(data, 59_999));
  });

  it('permanece estatico quando nenhum card esta aguardando', () => {
    const data = board({ awaitingSeconds: null });
    expect(boardClockBucket(data, 0)).toBe('static');
    expect(boardClockBucket(data, 9_999_999)).toBe('static');
  });
});
