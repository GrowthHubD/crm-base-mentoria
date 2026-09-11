import type { KanbanLead } from './queries';

export interface CrmConnection {
  id: string;
  name: string | null;
  type: string;
  unitId?: string | null;
}

/** Caixa de e-mail conectada — vira UMA aba de filtro (uma por caixa). */
export interface CrmEmailAccount {
  id: string;
  email: string;
  userId: string;
}

/** A aba é uma caixa de e-mail? (`email` = todas; `email:<userId>` = uma caixa) */
export function ehAbaEmail(aba: string): boolean {
  return aba === 'email' || aba.startsWith('email:');
}

/** Dono da caixa selecionada, ou null quando a aba não é `email:<userId>`. */
export function donoDaAbaEmail(aba: string): string | null {
  return aba.startsWith('email:') ? aba.slice('email:'.length) : null;
}

export interface QueuesResponse {
  queues: {
    novos: KanbanLead[];
    prioridade: KanbanLead[];
    urgencia: KanbanLead[];
    respondidos: KanbanLead[];
    convertidos: KanbanLead[];
  };
  connections: CrmConnection[];
  emailAccounts: CrmEmailAccount[];
}

export interface QueuesPollResponse {
  queues: QueuesResponse['queues'];
  connections?: CrmConnection[];
  emailAccounts?: CrmEmailAccount[];
}

export const CONNECTIONS_REFRESH_INTERVAL_MS = 60_000;

export function currentUnitScope(): string {
  if (typeof window === 'undefined') return 'all';
  try {
    return localStorage.getItem('unidade-selecionada') || 'all';
  } catch {
    return 'all';
  }
}

export function crmScopeKey(userId: string, unitId: string, connectionId: string): string {
  return `${userId}\u0000${unitId}\u0000${connectionId}`;
}

export function acceptsBoardResponse(
  activeKey: string | null,
  responseKey: string,
  activeSequence: number,
  responseSequence: number
): boolean {
  return activeKey === responseKey && activeSequence === responseSequence;
}

export function shouldRefreshConnections(
  fetchedAt: number | undefined,
  now = Date.now(),
  intervalMs = CONNECTIONS_REFRESH_INTERVAL_MS
): boolean {
  return fetchedAt === undefined || now - fetchedAt >= intervalMs;
}

export function crmQueuesRequestPath(
  activeConnection: string,
  includeConnections: boolean
): string {
  const params = new URLSearchParams();
  if (activeConnection !== 'all' && !ehAbaEmail(activeConnection)) {
    params.set('connectionId', activeConnection);
  }
  if (!includeConnections) params.set('includeConnections', '0');
  const query = params.toString();
  return `/api/crm/queues${query ? `?${query}` : ''}`;
}

export function mergeQueuesResponse(
  previous: QueuesResponse | undefined,
  incoming: QueuesPollResponse
): QueuesResponse | null {
  if (incoming.connections) {
    return {
      queues: incoming.queues,
      connections: incoming.connections,
      emailAccounts: incoming.emailAccounts ?? [],
    };
  }
  if (!previous) return null;
  return {
    queues: incoming.queues,
    connections: previous.connections,
    emailAccounts: previous.emailAccounts,
  };
}

export function boardClockBucket(data: QueuesResponse, now = Date.now()): string {
  const waitingSeconds = Object.values(data.queues)
    .flat()
    .map((lead) => lead.awaitingSeconds)
    .filter((seconds): seconds is number => typeof seconds === 'number' && seconds >= 0);

  if (waitingSeconds.length === 0) return 'static';
  const interval = waitingSeconds.some((seconds) => seconds < 60) ? 10_000 : 60_000;
  return `${interval}:${Math.floor(now / interval)}`;
}

export function boardSignature(data: QueuesResponse, now = Date.now()): string {
  const leads = Object.values(data.queues)
    .flat()
    .map((lead) => [
      lead.id,
      lead.status,
      lead.stageId,
      lead.name,
      lead.phone,
      lead.lastMessage,
      lead.lastMessageAt,
      lead.unread,
      lead.assignedToId,
      lead.assignedToName,
      lead.ownerId,
      lead.ownerName,
      lead.aiAgentActive,
      lead.aiPausedUntil,
      lead.attendants.map((attendant) => `${attendant.id}:${attendant.lastInteractionAt}`).join(','),
    ].join(':'))
    .join('|');
  const connections = data.connections.map((connection) => `${connection.id}:${connection.name ?? ''}:${connection.type}`).join('|');
  return `${leads}#${connections}#${boardClockBucket(data, now)}`;
}
