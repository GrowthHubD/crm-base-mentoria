/**
 * Webhook uazapi v2 POR CONEXÃO — `/api/webhooks/whatsapp/<connectionId>`.
 *
 * Por que essa rota existe (além da `/api/webhooks/whatsapp` legada):
 *
 * Quando duas instâncias uazapi pertencem à mesma unidade e ambas apontam pro
 * mesmo endpoint `/api/webhooks/whatsapp`, observamos que o segundo número
 * deixava de responder — provável dedup no servidor uazapi por URL idêntica
 * (ou um webhook a nível de servidor sobrescrevendo o per-instance). Dar uma
 * URL ÚNICA por instância elimina essa ambiguidade e ainda nos permite saber
 * a connection sem depender do parser de `instanceName` no payload.
 *
 * O handler delega ao mesmo `processInboundPayload`, passando o `connectionId`
 * como override — o resolver interno só cai pro lookup por `instanceName`
 * quando essa rota for usada sem o path.
 */
import { NextRequest, NextResponse } from 'next/server';
import { messageQueue, QUEUES_ENABLED } from '@/lib/queue';
import { runInBackground } from '@/lib/background';
import { logger } from '@/lib/logger';
import { processInboundPayload } from '@/modules/channels/whatsapp/process-inbound';
import { persistEvent, markDone, markAttemptFailed } from '@/modules/webhook-events';
import type { UazapiV2WebhookPayload } from '@/modules/messages/types';

/**
 * Alerta de configuracao emitido uma vez por isolate — o webhook e hot path,
 * nao pode logar a mesma linha a cada mensagem.
 */
let warnedMissingSecret = false;

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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params;
  try {
    // ATENÇÃO antes de reintroduzir um header obrigatório aqui.
    //
    // Esta rota já É autenticada pela URL: o `connectionId` é um UUID v4 que
    // só existe no banco do cliente e é entregue à uazapi no momento de ligar
    // a instância. Quem não tem o UUID não acha o endereço.
    //
    // O que havia antes era um `WEBHOOK_SECRET` comparado com o header
    // `x-webhook-secret`. **A uazapi não manda header nenhum** — e o código
    // respondia 200 ao rejeitar (correto para não gerar reentrega infinita),
    // então cada mensagem do cliente era descartada em silêncio, com o
    // provedor marcando "entregue". Foi assim que a Acme passou um dia
    // inteiro sem receber nada: instância conectada, webhook configurado,
    // POSTs chegando, zero linhas no banco.
    //
    // Piorava porque a variável nem era do cliente: ela vinha do `.env` da
    // máquina de desenvolvimento, embutida no bundle pelo build do
    // OpenNext (ver `.open-next/cloudflare/next-env.mjs`). Ou seja, ninguém
    // "ligou" essa exigência para a Acme — ela veio de carona.
    //
    // Se um dia for preciso um segredo aqui, ele tem que ser algo que o
    // provedor CONSIGA enviar (a uazapi só permite acrescentar dados na URL),
    // e a rejeição precisa ser barulhenta.
    if (process.env.WEBHOOK_SECRET && !warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn(
        { connectionId },
        '[webhook:whatsapp:conn] WEBHOOK_SECRET definido mas IGNORADO nesta rota — a uazapi não envia header; a autenticação é o UUID da URL'
      );
    }

    const raw = await req.json();
    const payload = raw as UazapiV2WebhookPayload;
    const jobId = extractIdempotencyKey(payload);

    // GRAVA ANTES DE PROCESSAR. A uazapi também não retransmite depois do 200,
    // e sem esta linha um evento que o parser descarta não deixa rastro: a
    // pergunta "por que a mensagem do cliente não apareceu no CRM" não tinha
    // como ser respondida, só como ser adivinhada. Custa um INSERT no caminho
    // quente e paga cada diagnóstico daqui pra frente.
    //
    // A chave é `uazapi:<connection>:<id da mensagem>` — reentrega do mesmo
    // evento vira no-op no INSERT, sem lock nem transação.
    let eventId: string | null = null;
    try {
      const p = await persistEvent({
        provider: 'uazapi',
        connectionId,
        eventKey: `uazapi:${connectionId}:${jobId}`,
        payload,
      });
      if (!p.isNew) {
        logger.debug({ jobId, connectionId }, '[webhook:whatsapp:conn] evento repetido — ignorado');
        return NextResponse.json({ ok: true });
      }
      eventId = p.id;
    } catch (err) {
      // Banco fora não pode virar 200 mudo: sem a linha gravada, responder OK
      // seria dizer à uazapi que a mensagem está guardada quando ela se perdeu.
      // 500 faz o provedor tentar de novo — é a única chance que resta.
      logger.error(
        { jobId, connectionId, err: err instanceof Error ? err.message : String(err) },
        '[webhook:whatsapp:conn] falha ao gravar o evento cru'
      );
      return NextResponse.json({ ok: false }, { status: 500 });
    }

    // Sem Redis não há consumidor: vai direto pro inline. Tentar enfileirar
    // aqui devolveria "sucesso" de um no-op e a mensagem sumiria calada.
    let queued = false;
    if (QUEUES_ENABLED) try {
      await messageQueue.add(
        'inbound-whatsapp',
        { payload, channel: 'whatsapp', connectionId },
        {
          jobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 200,
          removeOnFail: 100,
        }
      );
      queued = true;
      // A fila passa a ser a dona do evento: ela tem as próprias tentativas.
      // Deixar `pending` faria o sweeper do cron processar o MESMO evento em
      // paralelo com o worker.
      if (eventId) await markDone(eventId).catch(() => {});
      logger.debug(
        { jobId, eventType: payload.EventType, connectionId },
        '[webhook:whatsapp:conn] enfileirado'
      );
    } catch (err) {
      logger.warn(
        {
          jobId,
          connectionId,
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        },
        '[webhook:whatsapp:conn] enqueue falhou, processando inline'
      );
    }

    if (!queued) {
      // `runInBackground` é obrigatório aqui: no Cloudflare Worker a promise
      // solta morre no instante em que a resposta sai, e a mensagem nunca
      // chega ao banco — com 200 no log do provedor.
      const id = eventId;
      runInBackground(
        processInboundPayload(payload, { connectionIdOverride: connectionId })
          .then(async (result) => {
            logger.debug({ jobId, result, connectionId }, '[webhook:whatsapp:conn] processado inline');
            // `ok: false` é payload que o parser não entendeu. Fica `pending`
            // de propósito: o tick retenta, e se um parser corrigido chegar
            // antes do teto de tentativas, a mensagem entra atrasada em vez de
            // nunca. É a diferença entre "não sei ler" e "não tem nada aqui".
            if (id && result.ok) await markDone(id).catch(() => {});
          })
          .catch(async (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(
              { jobId, connectionId, eventId: id, err: msg },
              '[webhook:whatsapp:conn] falha no processamento inline — vai retentar no tick'
            );
            if (id) await markAttemptFailed(id, msg).catch(() => {});
          })
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error(
      { connectionId, err: err instanceof Error ? err.message : String(err) },
      '[webhook:whatsapp:conn] erro no handler'
    );
    return NextResponse.json({ ok: true });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params;
  return NextResponse.json({ ok: true, connectionId, ts: Date.now() });
}
