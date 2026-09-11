/**
 * Webhook da WhatsApp Cloud API (Meta) — `/api/webhooks/meta/<connectionId>`.
 *
 * Duas metades, como manda a Meta:
 *
 *   GET   Verificação do endpoint. A Meta manda `hub.challenge` e espera ele
 *         de volta em texto puro, desde que o `hub.verify_token` confira com
 *         o que você digitou no painel (env `META_VERIFY_TOKEN`).
 *   POST  Eventos: mensagens recebidas e status das que enviamos.
 *
 * Decisões que valem registrar:
 *
 * - **A assinatura é obrigatória quando há `META_APP_SECRET`.** O corpo cru é
 *   validado com HMAC-SHA256 contra `x-hub-signature-256`. Sem o segredo
 *   configurado, o endpoint aceita qualquer payload e diz isso no log — não
 *   deixe assim em produção.
 * - **Sempre 200.** A Meta desabilita webhooks que respondem erro seguidamente,
 *   e um lote com uma mensagem problemática não pode derrubar as outras. O que
 *   falhar fica no log, não na resposta.
 * - **Processamento em background.** O `waitUntil` (via `runInBackground`) é o
 *   que mantém o trabalho vivo depois do 200 — sem ele, no Worker, a promise é
 *   cancelada e a mensagem some sem erro nenhum.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { logger } from '@/lib/logger';
import { runInBackground } from '@/lib/background';
import { persistEvent, markDone, markAttemptFailed } from '@/modules/webhook-events';
import { parseMetaWebhook, type MetaWebhookPayload } from '@/modules/channels/whatsapp/cloud-api/webhook-parser';
import { handleCloudEvents } from '@/modules/channels/whatsapp/cloud-api/ingest';

export const dynamic = 'force-dynamic';

/** Avisa uma vez por isolate que o endpoint está sem verificação de origem. */
let warnedMissingSecret = false;

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody, 'utf8').digest('hex');
  const provided = header.startsWith('sha256=') ? header.slice('sha256='.length) : header;
  try {
    return timingSafeEqualHex(expected, provided);
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const expected = process.env.META_VERIFY_TOKEN;
  if (!expected) {
    logger.error('[webhook:meta] META_VERIFY_TOKEN ausente — a verificação do painel vai falhar');
    return NextResponse.json({ error: 'not configured' }, { status: 500 });
  }

  if (mode === 'subscribe' && token === expected && challenge) {
    logger.info('[webhook:meta] verificação do endpoint concluída');
    // Texto puro: a Meta compara byte a byte e rejeita JSON.
    return new NextResponse(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  logger.warn({ mode, hasToken: !!token }, '[webhook:meta] verificação recusada');
  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params;

  try {
    const rawBody = await req.text();

    const appSecret = process.env.META_APP_SECRET;
    if (appSecret) {
      if (!verifySignature(rawBody, req.headers.get('x-hub-signature-256'), appSecret)) {
        logger.warn({ connectionId }, '[webhook:meta] assinatura inválida — descartado');
        return NextResponse.json({ ok: true });
      }
    } else if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      logger.warn(
        {},
        '[webhook:meta] META_APP_SECRET ausente — o endpoint aceita qualquer payload. Configure antes de produção.'
      );
    }

    let payload: MetaWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as MetaWebhookPayload;
    } catch {
      logger.warn({ connectionId }, '[webhook:meta] corpo não é JSON');
      return NextResponse.json({ ok: true });
    }

    // PERSIST-FIRST, e agora primeiro DE VERDADE.
    //
    // Antes o parse vinha antes da gravação, e um lote que o parser não
    // reconhecesse saía daqui com 200 sem deixar linha nenhuma. Isso torna uma
    // pergunta impossível de responder depois: "a Meta não entregou, ou a gente
    // descartou?". Como a Cloud API NUNCA retransmite depois do 200, essa
    // dúvida é permanente — não há a quem pedir o evento de novo.
    //
    // Agora tudo que passa pela assinatura é gravado, inclusive o que não
    // sabemos tratar. Custa linha de banco (que o `pruneDone` limpa em 7 dias)
    // e compra a capacidade de auditar. Quando o parser ganhar suporte a algo
    // novo, `reprocess.ts` reparseia o payload cru e o evento antigo entra.
    let parsed: ReturnType<typeof parseMetaWebhook>;
    let parseFalhou = false;
    try {
      parsed = parseMetaWebhook(payload);
    } catch (err) {
      // Nem parse quebrado pode apagar o evento — grava e segue.
      parseFalhou = true;
      parsed = { phoneNumberId: null, messages: [], statuses: [] };
      logger.error(
        { err: err instanceof Error ? err.message : err, connectionId },
        '[webhook:meta] parser estourou — evento será gravado mesmo assim'
      );
    }

    const temTrabalho = parsed.messages.length > 0 || parsed.statuses.length > 0;
    const eventKey = temTrabalho
      ? buildEventKey(connectionId, parsed)
      : // Sem ids do provedor para formar chave, usa o hash do corpo: dedupe
        // continua funcionando para reentrega do mesmo payload.
        `cloud-api:${connectionId}:raw:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
    let persisted: { id: string | null; isNew: boolean };
    try {
      persisted = await persistEvent({
        provider: 'cloud-api',
        connectionId,
        eventKey,
        payload,
      });
    } catch (err) {
      // Falhou ao GRAVAR: aqui, e só aqui, devolver erro é o certo. A Meta
      // retransmite em 5xx — é a única chance de não perder o evento.
      logger.error(
        { err: err instanceof Error ? err.message : err, connectionId },
        '[webhook:meta] não foi possível gravar o evento — devolvendo 5xx pra Meta retransmitir'
      );
      return NextResponse.json({ error: 'persist failed' }, { status: 503 });
    }

    if (!persisted.isNew) {
      // Entrega duplicada (a Meta repete quando demora a receber o 200).
      logger.debug({ eventKey }, '[webhook:meta] evento repetido — ignorado');
      return NextResponse.json({ ok: true });
    }

    const eventId = persisted.id!;

    if (!temTrabalho) {
      // Nada a processar (status de template, qualidade do número, ou payload
      // que este parser ainda não entende). Fica gravado e sai de `pending`
      // para não ocupar o sweeper — mas com o payload cru guardado, então um
      // parser futuro alcança este evento via `reprocess.ts`.
      logger.info(
        { eventKey, connectionId, parseFalhou },
        '[webhook:meta] evento sem trabalho conhecido — gravado para auditoria'
      );
      await markDone(eventId).catch(() => {});
      return NextResponse.json({ ok: true });
    }
    runInBackground(
      handleCloudEvents(connectionId, parsed)
        .then(() => markDone(eventId))
        .catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ err: msg, connectionId, eventId }, '[webhook:meta] processamento falhou — vai retentar no tick');
          await markAttemptFailed(eventId, msg).catch(() => {});
        })
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, connectionId },
      '[webhook:meta] erro no handler'
    );
    // 200 mesmo em erro: a Meta desabilita endpoints que falham em série.
    return NextResponse.json({ ok: true });
  }
}

/**
 * Chave de deduplicação do evento.
 *
 * A Meta reenvia o mesmo payload quando demora a receber nosso 200, e nesse
 * caso os ids das mensagens/status vêm iguais. Concatenar todos eles produz
 * uma chave estável para o lote: o reenvio colide no UNIQUE e vira no-op,
 * enquanto um lote genuinamente diferente gera chave diferente.
 */
function buildEventKey(connectionId: string, parsed: ReturnType<typeof parseMetaWebhook>): string {
  const ids = [
    ...parsed.messages.map(m => `m:${m.externalId ?? 'sem-id'}`),
    ...parsed.statuses.map(st => `s:${st.externalId}:${st.status}`),
  ].sort();
  return `cloud-api:${connectionId}:${ids.join('|')}`.slice(0, 500);
}
