/**
 * Agendar sem Redis não pode estourar.
 *
 * No Cloudflare não há fila: `queue.add()` é um no-op que devolve `null` (o
 * contrato está em lib/queue.ts). Quem produzia agendamento lia `job.id`
 * direto e quebrava — o popup "Agendar mensagem" respondia HTTP 500.
 *
 * A linha em `scheduled_messages` É o agendamento; o job do BullMQ sempre foi
 * só o despertador, e o /api/cron/tick varre o que venceu. Então a ausência de
 * fila é um regime esperado, não uma falha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const inserted: Record<string, unknown>[] = [];
const updated: Record<string, unknown>[] = [];

vi.mock('@/lib/db/client', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        return { returning: async () => [{ id: 'sm-1' }] };
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updated.push(v);
        return { where: async () => undefined };
      },
    }),
  },
}));

// Fila desligada: exatamente o que lib/queue.ts devolve sem REDIS_URL.
vi.mock('@/lib/queue', () => ({
  QUEUES_ENABLED: false,
  schedulerQueue: {
    name: 'scheduler',
    add: async () => null,
    getJob: async () => null,
  },
}));

const { scheduleMessage } = await import('@/modules/scheduler/service');

beforeEach(() => {
  inserted.length = 0;
  updated.length = 0;
});

describe('scheduleMessage sem Redis', () => {
  it('não lança e grava o agendamento', async () => {
    const when = new Date(Date.now() + 3_600_000);
    const result = await scheduleMessage({
      leadId: 'lead-1',
      createdById: 'user-1',
      body: 'Opa, teste de agendamento',
      scheduledAt: when,
    });

    expect(result.id).toBe('sm-1');
    // A linha no banco é a fonte de verdade — precisa existir mesmo sem fila.
    expect(inserted[0]).toMatchObject({ leadId: 'lead-1', status: 'pending', scheduledAt: when });
  });

  it('usa um bullJobId sintético quando não há job', async () => {
    const result = await scheduleMessage({
      leadId: 'lead-1',
      createdById: 'user-1',
      body: 'x',
      scheduledAt: new Date(Date.now() + 60_000),
    });
    expect(result.bullJobId).toBe('sm-sm-1');
    expect(updated[0]).toMatchObject({ bullJobId: 'sm-sm-1' });
  });
});
