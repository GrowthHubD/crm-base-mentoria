/**
 * Service do módulo notifications — re-export do api-failure.ts e helpers
 * para enfileirar notificações via BullMQ (não-bloqueante).
 *
 * Dois caminhos:
 *   - notifyAPIFailureAsync: enfileira pra worker (não bloqueia caller)
 *   - notifyAPIFailure: chamada direta sync (caller decide await)
 */
import { notificationQueue, QUEUES_ENABLED } from '@/lib/queue';
import { runInBackground } from '@/lib/background';
import { notifyAPIFailure, type ApiFailureDetails } from '@/lib/notifications/api-failure';

export type { ApiFailureDetails };
export { notifyAPIFailure };

/**
 * Enfileira notificação de falha. Worker `notification` consome e chama
 * notifyAPIFailure de fato. Use em hot paths onde o caller não pode esperar.
 */
export async function notifyAPIFailureAsync(details: ApiFailureDetails): Promise<void> {
  // Sem Redis nao ha worker consumindo a fila: notificar em background e o
  // mais proximo do contrato "nao bloqueia o caller" que da pra oferecer.
  // Sem isto o alerta de falha de API era engolido junto com o no-op da fila.
  if (!QUEUES_ENABLED) {
    runInBackground(notifyAPIFailure(details).catch(() => {}));
    return;
  }

  await notificationQueue.add(
    'api-failure',
    { details },
    { attempts: 1, removeOnComplete: 50, removeOnFail: 50 }
  );
}
