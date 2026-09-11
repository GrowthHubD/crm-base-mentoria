/**
 * Reprocessa um evento de webhook gravado que não chegou a ser concluído.
 *
 * Chamado pelo sweeper do `/api/cron/tick`. Reparsear o payload cru em vez de
 * guardar o resultado do parse é deliberado: se a falha original foi um bug no
 * parser, o retry já pega a versão corrigida.
 *
 * Mora aqui, e não sob `cloud-api/`, porque hoje atende os DOIS provedores —
 * enquanto estava dentro da pasta da Meta, dava a impressão de que só a Cloud
 * API tinha rede de proteção, e a uazapi ficou anos sem nenhuma.
 */
import { parseMetaWebhook, type MetaWebhookPayload } from '@/modules/channels/whatsapp/cloud-api/webhook-parser';
import { handleCloudEvents } from '@/modules/channels/whatsapp/cloud-api/ingest';
import { processInboundPayload } from '@/modules/channels/whatsapp/process-inbound';
import type { UazapiV2WebhookPayload } from '@/modules/messages/types';

export interface StoredWebhookEvent {
  id: string;
  provider: string;
  connectionIdText: string | null;
  payload: unknown;
}

export async function reprocessWebhookEvent(event: StoredWebhookEvent): Promise<void> {
  if (!event.connectionIdText) {
    throw new Error('evento sem connection — não há como rotear');
  }

  if (event.provider === 'cloud-api') {
    const parsed = parseMetaWebhook(event.payload as MetaWebhookPayload);
    await handleCloudEvents(event.connectionIdText, parsed);
    return;
  }

  if (event.provider === 'uazapi') {
    const r = await processInboundPayload(event.payload as UazapiV2WebhookPayload, {
      connectionIdOverride: event.connectionIdText,
    });
    // `ok: false` é payload que o parser não entende — retentar dá no mesmo,
    // mas deixar `pending` para sempre esconderia os eventos saudáveis atrás
    // dele. Lançar manda para `failed` depois do teto de tentativas, que é o
    // estado que pede olho humano.
    if (!r.ok) throw new Error(`payload não processável: ${r.reason ?? 'desconhecido'}`);
    return;
  }

  throw new Error(`provedor sem reprocessamento: ${event.provider}`);
}
