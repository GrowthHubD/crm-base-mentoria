/**
 * Webhook da Evolution API — `/api/webhooks/evolution/<connectionId>`.
 *
 * Diferente da Meta, a Evolution não faz challenge de verificação: não há GET.
 * O que existe no lugar é um **segredo compartilhado no header**, gravado na
 * connection e registrado na instância no momento do `/instance/create`.
 *
 * Por que o segredo é obrigatório aqui e não "recomendado": a Evolution é
 * self-hosted e a URL deste endpoint é previsível a partir do domínio do
 * cliente. Sem o header, qualquer pessoa que descubra a URL injeta mensagem
 * falsa no CRM — cria lead, dispara automação, aciona o agente de IA. A Meta
 * ao menos assina o corpo; aqui a única defesa é esta.
 *
 * Decisões herdadas do canal oficial, pelos mesmos motivos:
 *
 * - **Sempre 200 depois de autenticado.** Um evento problemático não pode
 *   fazer a Evolution desistir de entregar os outros.
 * - **Persist-first.** O evento é gravado antes de ser processado, inclusive
 *   quando o parser não o reconhece — é o que permite responder depois "a
 *   Evolution não entregou, ou a gente descartou?".
 * - **Processamento em background.** `runInBackground` é o que mantém o
 *   trabalho vivo depois do 200; sem ele, no Worker, a promise é cancelada e a
 *   mensagem some sem erro nenhum.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { logger } from '@/lib/logger';
import { runInBackground } from '@/lib/background';
import { persistEvent, markDone, markAttemptFailed } from '@/modules/webhook-events';
import {
  parseEvolutionWebhook,
  buildEvolutionEventKey,
  type EvolutionWebhookPayload,
} from '@/modules/channels/whatsapp/evolution/webhook-parser';
import { handleEvolutionEvents } from '@/modules/channels/whatsapp/evolution/ingest';
import { getEvolutionConnection } from '@/modules/channels/whatsapp/evolution/provider';

export const dynamic = 'force-dynamic';

/** Header onde a instância apresenta o segredo (setado no `createInstance`). */
const TOKEN_HEADER = 'x-evolution-token';

function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  const { connectionId } = await params;

  try {
    const rawBody = await req.text();

    // A connection é buscada ANTES de gravar qualquer coisa, porque é ela que
    // guarda o segredo esperado. É uma query a mais no caminho quente (o
    // ingest busca de novo), e vale: sem isso o endpoint gravaria no banco
    // tudo que qualquer um mandasse.
    const connection = await getEvolutionConnection(connectionId);
    if (!connection) {
      logger.warn({ connectionId }, '[webhook:evolution] connection inexistente — descartado');
      return NextResponse.json({ ok: true });
    }

    if (!connection.webhookToken) {
      // Connection criada antes do token existir. Recusamos em vez de aceitar:
      // um endpoint aberto é pior do que um número que precisa ser reconectado.
      logger.error(
        { connectionId },
        '[webhook:evolution] connection sem webhookToken — recadastre a instância; eventos estão sendo recusados'
      );
      return NextResponse.json({ ok: true });
    }

    const provided = req.headers.get(TOKEN_HEADER);
    if (!provided || !timingSafeEqualStr(provided, connection.webhookToken)) {
      logger.warn(
        { connectionId, temHeader: !!provided },
        '[webhook:evolution] token inválido — descartado'
      );
      return NextResponse.json({ ok: true });
    }

    let payload: EvolutionWebhookPayload;
    try {
      payload = JSON.parse(rawBody) as EvolutionWebhookPayload;
    } catch {
      logger.warn({ connectionId }, '[webhook:evolution] corpo não é JSON');
      return NextResponse.json({ ok: true });
    }

    let parsed: ReturnType<typeof parseEvolutionWebhook>;
    let parseFalhou = false;
    try {
      parsed = parseEvolutionWebhook(payload);
    } catch (err) {
      // Nem parse quebrado pode apagar o evento — grava e segue.
      parseFalhou = true;
      parsed = {
        instanceName: typeof payload.instance === 'string' ? payload.instance : null,
        event: null,
        messages: [],
        statuses: [],
        connectionState: null,
      };
      logger.error(
        { err: err instanceof Error ? err.message : err, connectionId },
        '[webhook:evolution] parser estourou — evento será gravado mesmo assim'
      );
    }

    const temTrabalho = parsed.messages.length > 0 || parsed.statuses.length > 0;
    const eventKey =
      buildEvolutionEventKey(connectionId, parsed) ??
      // Sem id do provedor para formar chave (connection.update, evento
      // desconhecido), usa o hash do corpo: dedupe continua funcionando para
      // reentrega do mesmo payload.
      `evolution:${connectionId}:raw:${crypto.createHash('sha256').update(rawBody).digest('hex')}`;

    let persisted: { id: string | null; isNew: boolean };
    try {
      persisted = await persistEvent({
        provider: 'evolution',
        connectionId,
        eventKey,
        payload,
      });
    } catch (err) {
      // Falhou ao GRAVAR: aqui, e só aqui, devolver erro é o certo — é a
      // única chance de a Evolution reentregar.
      logger.error(
        { err: err instanceof Error ? err.message : err, connectionId },
        '[webhook:evolution] não foi possível gravar o evento — devolvendo 5xx'
      );
      return NextResponse.json({ error: 'persist failed' }, { status: 503 });
    }

    if (!persisted.isNew) {
      logger.debug({ eventKey }, '[webhook:evolution] evento repetido — ignorado');
      return NextResponse.json({ ok: true });
    }

    const eventId = persisted.id!;

    if (!temTrabalho) {
      logger.info(
        { eventKey, connectionId, event: parsed.event, parseFalhou },
        '[webhook:evolution] evento sem trabalho conhecido — gravado para auditoria'
      );
      await markDone(eventId).catch(() => {});
      return NextResponse.json({ ok: true });
    }

    runInBackground(
      handleEvolutionEvents(connectionId, parsed)
        .then(() => markDone(eventId))
        .catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error(
            { err: msg, connectionId, eventId },
            '[webhook:evolution] processamento falhou — vai retentar no tick'
          );
          await markAttemptFailed(eventId, msg).catch(() => {});
        })
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, connectionId },
      '[webhook:evolution] erro no handler'
    );
    return NextResponse.json({ ok: true });
  }
}
