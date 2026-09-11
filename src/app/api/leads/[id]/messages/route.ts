/**
 * GET  /api/leads/[id]/messages — histórico de conversa
 * POST /api/leads/[id]/messages — atendente envia mensagem (texto/mídia)
 */
import { NextRequest, NextResponse } from 'next/server';
import { reads as messageReads, recordPendingOutbound } from '@/modules/messages/service';
import { reads as leadReads, renewAiPause } from '@/modules/leads/service';
import { dispatchOutbound } from '@/lib/dispatch';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAoLead } from '@/lib/escopo-dono';
import { auth } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { rescheduleSequenceForLead } from '@/modules/followup/service';
import { ensureLeadHasConnection } from '@/modules/scheduler/service';
import { getConfigRow } from '@/modules/ai-agent/queries';
import { cancelPendingReplyForLead } from '@/modules/ai-agent/reply-queue';
import type { MessageType } from '@/modules/messages/types';
import { db } from '@/lib/db/client';
import { users } from '@/lib/db/schema/users';
import { eq } from 'drizzle-orm';
import { messageWindowEtag, requestHasMessageEtag } from '@/modules/messages/http-cache';

/**
 * Tipos que o outbound sabe ENVIAR. É um subconjunto de `MessageType`, que
 * cobre também o que só sabemos RECEBER (sticker, location) — despachar um
 * desses cairia fora do switch do envio e a mensagem seria marcada como
 * enviada sem nunca sair. O predicado abaixo faz o TypeScript garantir isso
 * no lugar de confiar na leitura.
 */
const VALID_TYPES = ['text', 'image', 'audio', 'video', 'document'] as const;
type SendableType = (typeof VALID_TYPES)[number];

function isSendable(t: MessageType): t is SendableType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // O middleware NÃO substitui isto: `getSessionCookie` só verifica que o
  // cookie EXISTE, não que ele é válido. Sem esta linha, qualquer requisição
  // com um cookie inventado lia o histórico inteiro da conversa.
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id: leadId } = await params;
  const acesso = await garantirAcessoAoLead(guard.user, leadId);
  if ('response' in acesso) return acesso.response;

  const url = new URL(req.url);
  const limit = Math.min(200, parseInt(url.searchParams.get('limit') ?? '50', 10));
  const beforeParam = url.searchParams.get('before');
  const before = beforeParam ? new Date(beforeParam) : undefined;
  // `order` controla só a ORDEM DE SAÍDA. Sempre buscamos a JANELA MAIS RECENTE
  // (desc + limit); o default 'asc' devolve em ordem cronológica pro chat, e
  // 'desc' devolve do mais novo pro mais antigo (ex.: SuporteIaTab pega o último
  // inbound). Antes o default era asc+limit na QUERY, que pegava as N mais
  // ANTIGAS — em conversa com +N msgs o chat congelava: tudo que entrava depois
  // (enviado OU recebido) ficava fora da janela e nunca aparecia.
  const order = url.searchParams.get('order') === 'desc' ? 'desc' : 'asc';

  // `before` (timestamp ISO) pagina pra trás: busca as N mais recentes ANTES do
  // cursor, pro "carregar mensagens anteriores" ao rolar pro topo.
  const recent = await messageReads.byLead(leadId, { limit, before, order: 'desc' });
  const messages = order === 'desc' ? recent : recent.slice().reverse();
  // hasMore = a janela veio cheia → provavelmente há mais antigas pra carregar.
  const hasMore = recent.length === limit;
  const payload = JSON.stringify({ messages, hasMore });
  const etag = messageWindowEtag(payload);
  const cacheHeaders = {
    'Cache-Control': 'private, no-cache',
    ETag: etag,
    Vary: 'Cookie',
  };

  if (requestHasMessageEtag(req.headers.get('if-none-match'), etag)) {
    return new NextResponse(null, { status: 304, headers: cacheHeaders });
  }

  return new NextResponse(payload, {
    status: 200,
    headers: { ...cacheHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

interface SendMessageBody {
  type: MessageType;
  body?: string;
  mediaUrl?: string;
  mediaCaption?: string;
  fileName?: string;
  /** Quando o atendente envia múltiplas fotos do catálogo, cada chamada
   *  inclui albumOrder (0..N-1) e albumTotal pra o worker entregar em
   *  sequência rápida (sem presence delay) e maximizar a chance do
   *  WhatsApp mobile agrupar visualmente em álbum. */
  albumOrder?: number;
  albumTotal?: number;
  /** Internal message id da mensagem sendo citada (reply/quote no WhatsApp).
   *  Backend resolve external_id + preview do conteúdo. */
  quotedMessageId?: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: leadId } = await params;
  // `requireSession` e não `auth.api.getSession`: o portão de dono precisa do
  // PAPEL do usuário, que só vem da consulta ao banco.
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const session = { user: guard.user };
  const acesso = await garantirAcessoAoLead(guard.user, leadId);
  if ('response' in acesso) return acesso.response;

  const lead = await leadReads.getById(leadId);
  if (!lead) return NextResponse.json({ error: 'lead not found' }, { status: 404 });

  // Lead órfão (sem connection) — tenta auto-vincular à WhatsApp ativa da unidade
  // antes de enfileirar o envio, senão o worker falha com "Lead sem connection vinculada".
  if (!lead.connectionId) {
    const fixed = await ensureLeadHasConnection(leadId);
    if (!fixed) {
      return NextResponse.json(
        {
          error:
            'lead sem conexão WhatsApp vinculada e a unidade ainda não tem nenhuma instância configurada — abra /conexoes',
        },
        { status: 409 }
      );
    }
  }

  const data = (await req.json()) as SendMessageBody;
  if (!isSendable(data.type)) {
    return NextResponse.json({ error: 'invalid type' }, { status: 400 });
  }
  // A partir daqui `sendableType` é um dos 5 que o outbound entende — o
  // predicado acima já eliminou sticker/location no nível do tipo.
  const sendableType: SendableType = data.type;
  if (data.type === 'text' && !data.body) {
    return NextResponse.json({ error: 'body required for text' }, { status: 400 });
  }
  if (data.type !== 'text' && !data.mediaUrl) {
    return NextResponse.json({ error: 'mediaUrl required for media' }, { status: 400 });
  }

  // Resolve nome do atendente — vai pra `senderName` e o worker outbound usa
  // pra prefixar a mensagem que sai pro WhatsApp ("Atendente Fulano\n\n…").
  const [userRow] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, session.user.id))
    .limit(1);
  const senderName = userRow?.name ?? null;

  const isAlbum = typeof data.albumOrder === 'number' && typeof data.albumTotal === 'number' && data.albumTotal > 1;
  const albumMeta = isAlbum
    ? { albumOrder: data.albumOrder!, albumTotal: data.albumTotal! }
    : null;

  // Reply/quote: se o caller passou o id interno da msg citada, resolve o
  // preview (body OU mediaCaption) pra exibir no MessageBubble. O id INTERNO
  // vai pra `quoted_message_id`; o worker outbound resolve `external_id`
  // (msgid do WhatsApp) na hora de chamar a uazapi.
  let quotedMessageId: string | null = null;
  let quotedContent: string | null = null;
  if (data.quotedMessageId) {
    const quoted = await messageReads.getById(data.quotedMessageId);
    if (quoted && quoted.leadId === leadId) {
      quotedMessageId = quoted.id;
      quotedContent = (quoted.body ?? quoted.mediaCaption ?? '').slice(0, 500) || null;
    }
  }

  // Persiste mensagem 'pending' (body fica LIMPO no banco — assinatura é
  // adicionada só na saída pra uazapi, pelo worker)
  const message = await recordPendingOutbound({
    leadId,
    type: data.type,
    sender: 'human',
    sentById: session.user.id,
    senderName,
    body: data.body ?? null,
    mediaUrl: data.mediaUrl ?? null,
    mediaCaption: data.mediaCaption ?? null,
    fileName: data.fileName ?? null,
    quotedMessageId,
    quotedContent,
    metadata: albumMeta,
  });

  // Enfileira envio. Pra fotos de álbum, escalona com delay pequeno (250ms
  // por posição) garantindo ordem mesmo com concurrency=3 da sendQueue, sem
  // demorar tanto a ponto do WhatsApp mobile parar de agrupar visualmente.
  const bullmqDelay = isAlbum && data.albumOrder! > 0 ? data.albumOrder! * 250 : undefined;
  await dispatchOutbound(
    {
      messageId: message.id,
      leadId,
      type: sendableType,
      body: data.body,
      mediaUrl: data.mediaUrl,
      mediaCaption: data.mediaCaption,
      fileName: data.fileName,
    },
    { jobId: `out-${message.id}`, delayMs: bullmqDelay }
  );

  // Atendente respondeu → relógio de follow-ups recomeça a partir de agora.
  rescheduleSequenceForLead(leadId).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId },
      '[api:leads.messages] reagendar follow-ups falhou'
    );
  });

  // Renova a pausa renovável da IA — atendente humano falou, IA cala pelos
  // próximos N minutos (config da unit). Cada msg humana empurra o timer
  // pra frente. Sem isso, IA e humano falariam ao mesmo tempo no chat.
  //
  // Também cancela QUALQUER job da IA pendente pro lead — se a IA estava
  // aguardando a janela de handoff (idleSecondsBeforeAi) pra assumir e o
  // atendente respondeu antes, o reset zera o relógio: a IA não assume
  // essa rodada, só seria considerada de novo na próxima inbound do lead.
  void (async () => {
    try {
      const cfg = await getConfigRow();
      const minutes = cfg?.aiPauseMinutesAfterHuman ?? 20;
      await renewAiPause(leadId, minutes, 'human_message');
      await cancelPendingReplyForLead(leadId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, leadId },
        '[api:leads.messages] renovar aiPausedUntil / cancelar IA falhou'
      );
    }
  })();

  return NextResponse.json({ message }, { status: 201 });
}
