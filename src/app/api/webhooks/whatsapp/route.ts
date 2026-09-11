/**
 * Webhook uazapi v2 — recebe eventos de mensagens WhatsApp.
 *
 * Comportamento:
 *   - SEMPRE retorna 200 (uazapi tem retry agressivo)
 *   - Tenta enfileirar em BullMQ (produção com Redis)
 *   - Se Redis indisponível → processa inline diretamente (dev sem Redis)
 *   - Idempotência via jobId derivado do messageId
 *   - Aceita payload v1 (legacy) e v2 (flat)
 *   - Validação opcional via header `x-webhook-secret`
 */
import { NextRequest, NextResponse } from 'next/server';
import { messageQueue, QUEUES_ENABLED } from '@/lib/queue';
import { runInBackground } from '@/lib/background';
import { logger } from '@/lib/logger';
import { processInboundPayload } from '@/modules/channels/whatsapp/process-inbound';
import type { UazapiV2WebhookPayload } from '@/modules/messages/types';

/**
 * Alerta de configuracao emitido uma vez por isolate — o webhook e hot path,
 * nao pode logar a mesma linha a cada mensagem.
 */
let warnedMissingSecret = false;

/** BullMQ rejeita ':' em custom job id. Substituímos por '-' e mantemos o resto. */
function safeJobId(raw: string): string {
  return raw.replace(/[:|\s]/g, '-');
}

function extractIdempotencyKey(payload: UazapiV2WebhookPayload | Record<string, unknown>): string {
  const v2 = payload as UazapiV2WebhookPayload;
  if (v2.message?.id) return safeJobId(`wa-${v2.message.id}`);
  if (v2.message?.messageid) return safeJobId(`wa-${v2.message.messageid}`);
  const v1 = payload as { data?: { id?: string } };
  if (v1.data?.id) return safeJobId(`wa-${v1.data.id}`);
  return `wa-fallback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function POST(req: NextRequest) {
  try {
    // Rota LEGADA (sem connectionId na URL). Mesmo motivo da rota por conexão:
    // a uazapi não envia header nenhum, então comparar `x-webhook-secret` com
    // `WEBHOOK_SECRET` era uma porta que NUNCA abria — e fechava respondendo
    // 200, descartando a mensagem do cliente em silêncio.
    //
    // Só passa a valer de novo com `WEBHOOK_SECRET_ENFORCE=true`, e aí é uma
    // decisão explícita de quem sabe que o provedor consegue mandar o header
    // (não é o caso da uazapi hoje). Ver o cabeçalho de
    // `[connectionId]/route.ts` para a história inteira.
    const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
    const exigirHeader = process.env.WEBHOOK_SECRET_ENFORCE === 'true';
    if (WEBHOOK_SECRET && exigirHeader) {
      const provided = req.headers.get('x-webhook-secret') || req.headers.get('x-uazapi-secret');
      if (provided !== WEBHOOK_SECRET) {
        logger.error(
          { provided: provided ? 'present-mismatch' : 'absent' },
          '[webhook:whatsapp] payload REJEITADO por header ausente/errado — a mensagem foi descartada'
        );
        return NextResponse.json({ ok: true });
      }
    } else if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn(
        {},
        '[webhook:whatsapp] rota legada sem autenticação de header — prefira /api/webhooks/whatsapp/<connectionId>, cuja URL já é o segredo'
      );
    }

    const raw = await req.json();
    const payload = raw as UazapiV2WebhookPayload;
    const jobId = extractIdempotencyKey(payload);


    // Tenta enfileirar no BullMQ (requer Redis)
    // Sem Redis não há consumidor: vai direto pro inline. Tentar enfileirar
    // aqui devolveria "sucesso" de um no-op e a mensagem sumiria calada.
    let queued = false;
    if (QUEUES_ENABLED) try {
      await messageQueue.add(
        'inbound-whatsapp',
        { payload, channel: 'whatsapp' },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 200,
          removeOnFail: 100,
        }
      );
      queued = true;
      logger.debug({ jobId, eventType: payload.EventType }, '[webhook:whatsapp] enfileirado');
    } catch (err) {
      // Redis indisponível ou erro no enqueue — processa inline com fallback
      logger.warn(
        { jobId, err: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join(' | ') : undefined },
        '[webhook:whatsapp] enqueue falhou, processando inline'
      );
    }

    if (!queued) {
      // Processamento direto sem BullMQ. Não aguardamos — a uazapi recebe 200
      // na hora —, mas `runInBackground` mantém o trabalho vivo: no Cloudflare
      // Worker uma promise solta é cancelada quando a resposta sai.
      runInBackground(
        processInboundPayload(payload)
          .then(result => {
            logger.debug({ jobId, result }, '[webhook:whatsapp] processado inline');
          })
          .catch(err => {
            logger.error(
              { jobId, err: err instanceof Error ? err.message : err },
              '[webhook:whatsapp] falha no processamento inline'
            );
          })
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      '[webhook:whatsapp] erro no handler'
    );
    return NextResponse.json({ ok: true });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
