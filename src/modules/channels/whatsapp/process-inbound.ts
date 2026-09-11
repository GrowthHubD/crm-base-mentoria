/**
 * Lógica central de processamento de mensagens inbound WhatsApp.
 *
 * Usado tanto pelo worker BullMQ (quando Redis disponível) quanto
 * diretamente no webhook handler (fallback sem Redis em dev).
 */
import { parseV2Webhook, detectEventType, normalizeWaMessageId } from './webhook-parser';
import type { ParsedInbound } from './webhook-parser';
import type { MediaBlob } from './media';
import { transcribeAudio } from '@/modules/ai-agent/transcribe';
import { resolveMediaBlob, buildStorageKey } from './media';
import { findConnectionByInstance } from '@/modules/channels/service';
import { upsertLeadFromContact, reads as leadReads } from '@/modules/leads/service';
import { recordInboundMessage, recordOwnerOutbound, updateExternalStatus, updateInboundMessageBody } from '@/modules/messages/service';
import { reevaluateChannelAttribution } from '@/modules/channels/keyword-attribution';
import { uploadMedia } from '@/lib/storage';
import { fireTrigger } from '@/modules/automations/service';
import { cancelPendingByLead as cancelScheduled } from '@/modules/scheduler/service';
import { cancelPendingByLead as cancelFollowup } from '@/modules/followup/service';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { connections } from '@/lib/db/schema/connections';
import { eq } from 'drizzle-orm';
import { decrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { enqueueReplyForLead, cancelPendingReplyForLead } from '@/modules/ai-agent/reply-queue';
import type { UazapiV2WebhookPayload } from '@/modules/messages/types';

export interface ProcessInboundResult {
  ok: boolean;
  leadId?: string;
  isNewLead?: boolean;
  skipped?: string;
  reason?: string;
  eventType?: string;
}

export async function processInboundPayload(
  payload: UazapiV2WebhookPayload | Record<string, unknown>,
  /**
   * - `enqueueAi`: override de testes pra pular o delay padrão.
   * - `connectionIdOverride`: quando o webhook chega pela rota dinâmica
   *   `/api/webhooks/whatsapp/<id>`, já sabemos a connection — não precisamos
   *   inferir por `instanceName` do payload (ambíguo se duas instâncias da
   *   mesma unit compartilham URL legada). Quando ausente, cai no resolver
   *   antigo (compat com a rota `/api/webhooks/whatsapp`).
   */
  opts?: {
    enqueueAi?: (leadId: string, message: string, externalId: string) => Promise<void>;
    connectionIdOverride?: string;
  }
): Promise<ProcessInboundResult> {
  const eventType = detectEventType(payload as UazapiV2WebhookPayload);

  // Status updates: delivered/read/failed + EDIÇÕES de mensagem + REACTIONS.
  //
  // A uazapi v2 manda edits dentro de `messages_update` carregando o novo
  // texto em `message.text` / `message.content.text`. Não há flag dedicada,
  // então a heurística: se o evento traz texto novo, é edit (status updates
  // genuínos vêm com `messageType=delivered|read|failed` e sem text).
  //
  // Reactions: ainda heurística — uazapi pode mandar via `reactionMessage`,
  // `reaction`, ou `messageType` contendo "reaction". Quando o payload real
  // ficar conhecido, simplificar o branch abaixo.
  if (eventType === 'messages_update') {
    const data = (payload as UazapiV2WebhookPayload).message;
    if (data?.id) {
      // uazapi manda o id do webhook prefixado (`<número>:<msgid>`); o
      // external_id gravado no envio é pelado. Normaliza pra casar. Ver
      // normalizeWaMessageId. Sem isso, delivered/read/edit/reaction não
      // encontram a mensagem.
      const msgId = normalizeWaMessageId(data.id)!;
      const mt = String(data.messageType ?? '').toLowerCase();

      // Detecta reaction antes de status/edit. Variantes conhecidas + best-effort.
      const isReaction =
        mt.includes('reaction') ||
        !!data.reactionMessage ||
        !!data.reaction ||
        !!data.reactionFor;
      if (isReaction) {
        const targetExternalId = normalizeWaMessageId(
          data.reactionMessage?.key?.id ??
          data.reaction?.messageid ??
          data.reaction?.id ??
          data.reactionFor ??
          null
        );
        const emoji =
          (data.reactionMessage?.text ?? data.reaction?.text ?? data.text ?? '').toString();
        if (targetExternalId) {
          const { upsertMessageReactionByExternalId } = await import('@/modules/messages/mutations');
          await upsertMessageReactionByExternalId(targetExternalId, {
            emoji,
            sender: data.fromMe ? 'owner' : 'lead',
            timestamp: new Date(data.messageTimestamp ?? Date.now()).toISOString(),
            externalSenderId: data.sender ?? null,
          }).catch((err) => {
            logger.warn(
              { err: err instanceof Error ? err.message : err, targetExternalId },
              '[process-inbound] upsert reaction falhou'
            );
          });
          return { ok: true, eventType };
        }
        logger.warn(
          { messageType: mt, externalId: data.id },
          '[process-inbound] reaction sem targetExternalId — payload desconhecido, ignorando'
        );
        return { ok: true, eventType };
      }

      if (mt.includes('delivered')) {
        await updateExternalStatus(msgId, 'delivered');
        return { ok: true, eventType };
      }
      if (mt.includes('read')) {
        await updateExternalStatus(msgId, 'read');
        return { ok: true, eventType };
      }
      const newText = (data.text ?? data.content?.text ?? '').trim();
      if (newText) {
        const row = await updateInboundMessageBody(msgId, newText);
        if (row) {
          try {
            const { getLeadById } = await import('@/modules/leads/queries');
            const lead = await getLeadById(row.leadId);
            if (lead) {
              const { getConfigRow } = await import('@/modules/ai-agent/queries');
              const aiCfg = await getConfigRow();
              await reevaluateChannelAttribution({
                leadId: lead.id,
                text: newText,
                currentAttribution: lead.attributedChannel,
                rules: aiCfg?.channelKeywords ?? [],
                source: 'edit',
              });
            }
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.message : err, externalId: data.id },
              '[process-inbound] reavaliar keyword em edit falhou'
            );
          }
        }
      }
    }
    return { ok: true, eventType };
  }

  if (eventType !== 'messages') {
    logger.debug({ eventType }, '[process-inbound] evento ignorado');
    return { ok: true, eventType };
  }

  const parsed = parseV2Webhook(payload as UazapiV2WebhookPayload);
  if (!parsed) {
    logger.warn('[process-inbound] payload sem dados parseáveis');
    return { ok: false, reason: 'unparseable' };
  }

  if (parsed.isGroup) {
    logger.debug({ jid: parsed.contactJid }, '[process-inbound] grupo ignorado');
    return { ok: true, skipped: 'group' };
  }

  // Diagnóstico de payloads não cobertos pela heurística — fica em warn pra
  // a gente capturar amostra real e ajustar formatBusinessCatalog. Só logamos
  // quando mediaType ficou como 'unknown' E não dá pra recuperar texto.
  if (parsed.mediaType === 'unknown' && !parsed.content) {
    logger.warn(
      {
        rawMessageType: (payload as UazapiV2WebhookPayload).message?.messageType,
        rawMediaType: (payload as UazapiV2WebhookPayload).message?.mediaType,
        rawType: (payload as UazapiV2WebhookPayload).message?.type,
        keys: Object.keys((payload as UazapiV2WebhookPayload).message ?? {}),
      },
      '[process-inbound] mediaType=unknown sem content — payload desconhecido, considere mapear'
    );
  }

  return ingestParsedInbound(parsed, opts);
}

/**
 * Ingestao de uma mensagem recebida, JA parseada — a parte que nao depende de
 * provedor: acha a connection, cria/atualiza o lead, resolve midia, grava a
 * mensagem, dispara automacoes e (se ligado) o agente.
 *
 * Existe separada porque o CRM fala com dois canais de WhatsApp: a uazapi
 * (nao-oficial, parser em `webhook-parser.ts`) e a Cloud API da Meta (oficial,
 * parser em `cloud-api/webhook-parser.ts`). Os dois produzem `ParsedInbound` e
 * entram por aqui — o que muda entre eles fica no parser e no `resolveMedia`,
 * nunca na regra de negocio.
 */
export async function ingestParsedInbound(
  parsed: ParsedInbound,
  opts?: {
    enqueueAi?: (leadId: string, message: string, externalId: string) => Promise<void>;
    connectionIdOverride?: string;
    /**
     * Como baixar a midia deste provedor. A uazapi manda URL ou base64 no
     * proprio webhook; a Meta manda so um id que exige duas chamadas
     * autenticadas. Ausente = comportamento uazapi.
     */
     resolveMedia?: (parsed: ParsedInbound) => Promise<MediaBlob | null>;
  }
): Promise<ProcessInboundResult> {


  // Lookup connection — prioriza override do path (rota dinâmica) e cai pro
  // resolver por instanceName quando não vier (compat com webhook legado).
  let connection: { id: string; status: string } | null = null;
  if (opts?.connectionIdOverride) {
    const [row] = await db
      .select({ id: connections.id, status: connections.status })
      .from(connections)
      .where(eq(connections.id, opts.connectionIdOverride))
      .limit(1);
    connection = row ?? null;
    if (!connection) {
      logger.warn(
        { connectionId: opts.connectionIdOverride },
        '[process-inbound] connection do override sumiu — caindo no resolver legado'
      );
    }
  }
  if (!connection) connection = await findConnectionByInstance(parsed.instanceName);
  if (!connection) {
    const [first] = await db
      .select({ id: connections.id, status: connections.status })
      .from(connections)
      .where(eq(connections.type, 'whatsapp'))
      .limit(1);
    connection = first ?? null;

    if (!connection) {
      logger.warn({ instanceName: parsed.instanceName }, '[process-inbound] sem connection — criando auto');
      const [created] = await db
        .insert(connections)
        .values({
          type: 'whatsapp',
          externalId: parsed.instanceName ?? 'default',
          status: 'connected',
          displayName: 'WhatsApp Principal',
        })
        .returning({ id: connections.id, status: connections.status });
      connection = created;
    }
  }

  // Se o agente IA está ativo, leads NOVOS nascem com aiAgentActive=true pra IA
  // assumir o atendimento imediatamente. Leads existentes mantêm seu flag.
  const { getConfigRow } = await import('@/modules/ai-agent/queries');
  const aiCfg = await getConfigRow();
  const aiActiveByDefault = aiCfg?.enabled ?? false;

  // Upsert lead
  const { lead, isNew } = await upsertLeadFromContact({
    externalContactId: parsed.contactPhone,
    channel: 'whatsapp',
    connectionId: connection.id,
    // A unidade do lead vem da CONEXÃO por onde a mensagem entrou — é o único
    // sinal confiável de qual filial atendeu. O número de WhatsApp pertence a
    // uma filial; quem escreveu para ele é lead dela.
    unitId: (connection as { unitId?: string | null }).unitId ?? null,
    // `pushName` é o nome de QUEM ENVIOU, não do contato — e num eco `fromMe`
    // quem enviou somos nós. Usá-lo aí batizava o lead com o nome do DONO da
    // conta: a conversa com o cliente aparecia no CRM com o nome do vendedor,
    // e o telefone certo do lado. Só mensagem RECEBIDA diz como o contato se
    // chama; no eco, deixamos o nome como está (ou o lookup adiante resolve).
    name: parsed.fromMe ? undefined : (parsed.pushName ?? undefined),
    phone: parsed.contactPhone,
    // Mesma lógica: a foto de perfil no eco é a nossa.
    avatarUrl: parsed.fromMe ? undefined : (parsed.profilePic ?? undefined),
    aiAgentActive: aiActiveByDefault,
  });

  // Atribuição de anúncio (Click-to-WhatsApp). A Meta manda o `referral` só na
  // PRIMEIRA mensagem da conversa e só uma vez — não existe endpoint para
  // perguntar depois de qual anúncio o lead veio. Se não gravar aqui, a origem
  // se perde para sempre, e é exatamente o que o cliente compra ao anunciar.
  //
  // Grava em `metadata` (jsonb) e não em coluna nova: evita migration, e o
  // formato do `referral` é da Meta, não nosso — enrijecer em colunas obrigaria
  // uma migration a cada campo que eles acrescentarem.
  //
  // Só escreve quando ainda não existe: mensagens seguintes da mesma conversa
  // não trazem `referral`, e uma segunda campanha para um lead conhecido não
  // deve apagar de onde ele veio na primeira vez.
  if (parsed.adReferral) {
    const jaTem = (lead.metadata as Record<string, unknown> | null)?.adReferral;
    if (!jaTem) {
      try {
        await db
          .update(leads)
          .set({
            metadata: {
              ...((lead.metadata as Record<string, unknown> | null) ?? {}),
              adReferral: { ...parsed.adReferral, capturadoEm: new Date().toISOString() },
            },
            updatedAt: new Date(),
          })
          .where(eq(leads.id, lead.id));
        logger.info(
          { leadId: lead.id, sourceId: parsed.adReferral.sourceId, headline: parsed.adReferral.headline },
          '[process-inbound] lead veio de anúncio — atribuição gravada'
        );
      } catch (err) {
        // Não derruba a mensagem: perder a atribuição é ruim, perder o lead é pior.
        logger.error(
          { err: err instanceof Error ? err.message : err, leadId: lead.id },
          '[process-inbound] falha ao gravar atribuição de anúncio'
        );
      }
    }
  }

  // Lead sem nome (webhook não trouxe pushName em nenhum dos campos): faz
  // best-effort GET /chat/details na uazapi pra puxar o nome público do
  // WhatsApp. Roda assíncrono — não bloqueia processamento da mensagem.
  // Sem await: erros são swallowed dentro de fetchContactNameForLead.
  if (!lead.name || lead.name.trim() === '') {
    void (async () => {
      try {
        const { fetchContactNameForLead } = await import('@/modules/channels/service');
        const info = await fetchContactNameForLead(connection.id, parsed.contactPhone);
        if (info?.name || info?.avatarUrl) {
          const { patchLead } = await import('@/modules/leads/service');
          await patchLead(lead.id, {
            ...(info.name ? { name: info.name } : {}),
            ...(info.avatarUrl ? { avatarUrl: info.avatarUrl } : {}),
          });
          logger.info(
            { leadId: lead.id, name: info.name },
            '[process-inbound] nome puxado via /chat/details'
          );
        }
      } catch (err) {
        logger.warn(
          { leadId: lead.id, err: err instanceof Error ? err.message : err },
          '[process-inbound] fetch pushName falhou'
        );
      }
    })();
  }

  // Resolve mídia
  let mediaUrl: string | null = null;
  let mediaMimeType: string | null = parsed.mimeType;
  const fileName: string | null = parsed.fileName;
  // Texto da mensagem (parsed.content é null pra áudio puro). Pode ser
  // sobrescrito abaixo pela transcrição quando o áudio for processado com
  // sucesso, daí a IA enxerga como mensagem de texto normal.
  let messageBody: string | null = parsed.content;

  if (['image', 'video', 'audio', 'document', 'sticker'].includes(parsed.mediaType)) {
    try {
      const [conn] = await db.select().from(connections).where(eq(connections.id, connection.id)).limit(1);
      let token: string | undefined;
      if (conn?.accessTokenEncrypted) {
        try { token = decrypt(conn.accessTokenEncrypted); } catch { /* ignore */ }
      }
      token = token ?? process.env.UAZAPI_TOKEN;

      const blob = opts?.resolveMedia
        ? await opts.resolveMedia(parsed)
        : await resolveMediaBlob(parsed, token);
      if (blob) {
        const key = buildStorageKey(`whatsapp/${parsed.mediaType}`, blob.mimeType, fileName);
        const upload = await uploadMedia(key, blob.buffer, blob.mimeType);
        mediaUrl = upload.url;
        mediaMimeType = blob.mimeType;
        logger.info(
          { source: blob.source, backend: upload.backend, mediaType: parsed.mediaType, externalId: parsed.externalId },
          '[process-inbound] mídia armazenada'
        );

        // Áudio: transcreve via Whisper pra IA conseguir interpretar e
        // responder. O texto vira o `body` da mensagem — bubble mostra junto
        // com o player; preview do kanban mostra a transcrição em vez de
        // "🎤 Áudio"; e o fluxo de hasText abaixo enfileira a IA naturalmente.
        if (parsed.mediaType === 'audio' && mediaUrl) {
          const transcript = await transcribeAudio(mediaUrl, mediaMimeType);
          if (transcript) {
            messageBody = transcript;
          }
        }
      } else {
        // uazapi NÃO retém mídia decriptada por padrão — quando o webhook chega sem
        // mediaUrl válido nem base64 inline, o /message/download dela costuma
        // responder 404 (a mensagem expirou do cache). Persistimos a mensagem
        // assim mesmo pro atendente saber que o cliente mandou áudio/imagem,
        // mas o player não vai conseguir tocar até a uazapi ser configurada pra
        // entregar a mídia inline no webhook.
        logger.warn(
          { mediaType: parsed.mediaType, externalId: parsed.externalId, contactPhone: parsed.contactPhone },
          '[process-inbound] mídia não recuperada — webhook sem base64 e /message/download falhou'
        );
      }
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : err, mediaType: parsed.mediaType }, '[process-inbound] falha mídia');
    }
  }

  // Tipo da mensagem (compartilhado entre inbound e owner-outbound)
  const messageType = parsed.mediaType === 'unknown' ? 'system' : (parsed.mediaType as 'text' | 'image' | 'audio' | 'video' | 'document' | 'sticker' | 'location');

  // ── Branch: mensagem enviada PELO CELULAR DO DONO (fromMe) ─────────
  // Grava como outbound/sender=owner mas NÃO dispara triggers/IA/cancelamentos.
  // Idempotente: se a mesma msg já foi enviada via CRM, externalId existe e
  // recordOwnerOutbound retorna isNew=false sem duplicar.
  if (parsed.fromMe) {
    // Guarda: reactions/protocolo da uazapi chegam como `messages` com
    // fromMe=true mas sem texto e sem mídia. Antes da guarda, o branch
    // criava registro outbound vazio E renovava aiPausedUntil por 20 min —
    // pausando a IA por engano (sem atendente humano envolvido).
    // Incidente: 30/05/2026 21:44 BRT, lead João (21f71006…), 2 webhooks
    // vazios mataram o teste do cliente no meio da conversa.
    const hasContent = (parsed.content && parsed.content.trim().length > 0) || !!mediaUrl;
    if (!hasContent) {
      logger.debug(
        { externalId: parsed.externalId, mediaType: parsed.mediaType, leadId: lead.id },
        '[process-inbound] fromMe sem conteúdo ignorado (reaction/protocolo)'
      );
      return { ok: true, leadId: lead.id, skipped: 'fromme-empty' };
    }
    const { isNew: ownerIsNew } = await recordOwnerOutbound({
      leadId: lead.id,
      externalId: parsed.externalId,
      type: messageType,
      body: parsed.content,
      mediaUrl,
      mediaCaption: messageType !== 'text' ? parsed.content : null,
      mimeType: mediaMimeType,
      fileName,
      senderName: parsed.senderName,
      timestamp: new Date(parsed.timestamp),
      quotedMessageId: parsed.quoted?.id ?? null,
      quotedContent: parsed.quoted?.content ?? null,
    });
    if (!ownerIsNew) {
      logger.debug({ externalId: parsed.externalId }, '[process-inbound] echo de mensagem do CRM ignorado');
      return { ok: true, leadId: lead.id, skipped: 'duplicate-owner-echo' };
    }
    // Atendente respondeu PELO CELULAR → renova a pausa renovável da IA igual
    // ao POST /api/leads/[id]/messages faz quando ele responde pelo CRM.
    // Sem isso, IA continuava livre e respondia JUNTO com o atendente (bug
    // relatado pelo cliente em 30/05 — lead "Lu": owner em 22:22 BRT, IA em
    // 22:25 BRT na mesma conversa).
    //
    // Também cancela QUALQUER job da IA pendente pro lead — se a IA estava
    // aguardando a janela de handoff (idleSecondsBeforeAi) pra assumir, e o
    // atendente humano respondeu antes, o reset zera o timer: a IA só assume
    // se o silêncio do humano persistir na próxima rodada de mensagens.
    void (async () => {
      try {
        const minutes = aiCfg?.aiPauseMinutesAfterHuman ?? 20;
        const { renewAiPause } = await import('@/modules/leads/service');
        await renewAiPause(lead.id, minutes, 'human_message');
        await cancelPendingReplyForLead(lead.id);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, leadId: lead.id },
          '[process-inbound] renovar aiPausedUntil / cancelar IA em fromMe falhou'
        );
      }
    })();
    return { ok: true, leadId: lead.id };
  }

  // ── Inbound normal (mensagem recebida do lead) ─────────────────────
  // body usa messageBody (que pode ser transcrição de áudio); mediaCaption
  // mantém o caption original do payload (sem mistura com transcrição).
  const { isNew: msgIsNew } = await recordInboundMessage({
    leadId: lead.id,
    externalId: parsed.externalId,
    type: messageType,
    body: messageBody,
    mediaUrl,
    mediaCaption: messageType !== 'text' ? parsed.content : null,
    mimeType: mediaMimeType,
    fileName,
    senderName: parsed.senderName,
    timestamp: new Date(parsed.timestamp),
    quotedMessageId: parsed.quoted?.id ?? null,
    quotedContent: parsed.quoted?.content ?? null,
  });

  if (!msgIsNew) {
    logger.debug({ externalId: parsed.externalId }, '[process-inbound] mensagem duplicada ignorada');
    return { ok: true, skipped: 'duplicate' };
  }

  // Atribuição de canal por palavra-chave — TODA mensagem é candidata. Sem
  // match: mantém a atribuição anterior. Match em canal diferente: sobrescreve.
  // (Usa messageBody pra cobrir transcrição de áudio também.)
  await reevaluateChannelAttribution({
    leadId: lead.id,
    text: messageBody,
    currentAttribution: lead.attributedChannel,
    rules: aiCfg?.channelKeywords ?? [],
    source: 'inbound',
  });

  await Promise.all([cancelScheduled(lead.id), cancelFollowup(lead.id)]);

  // Lead voltou a engajar → limpa o estado "Resolvido" manual (se havia).
  // Sem isso o atendente teria que re-clicar Resolvido toda vez que o lead
  // sumisse de novo. A regra UX: clicar Resolvido = "tô em paz por enquanto";
  // engajamento novo = "OK, ciclo de follow-up volta normal".
  void (async () => {
    try {
      const { clearLeadResolved } = await import('@/modules/leads/service');
      await clearLeadResolved(lead.id);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, leadId: lead.id },
        '[process-inbound] clear resolvedAt em inbound falhou'
      );
    }
  })();

  if (isNew) await fireTrigger('first_message', lead.id);

  // AI: enfileira com delay = idleSecondsBeforeAi da unidade do lead.
  // Lê config da MESMA unidade já carregada (aiCfg acima).
  // messageBody pode ser transcrição de áudio — aí a IA responde ao áudio
  // como se fosse texto.
  const currentLead = await leadReads.getById(lead.id);
  const aiActive = currentLead?.aiAgentActive ?? false;
  const hasText = !!messageBody && messageBody.trim().length > 0;
  const blockedForAi = ['attending', 'converted', 'lost'];
  if (aiActive && hasText && currentLead && !blockedForAi.includes(currentLead.status)) {
    const idleSec = aiCfg?.idleSecondsBeforeAi ?? 0;
    try {
      if (opts?.enqueueAi) {
        // Override de testes — passa direto sem delay.
        await opts.enqueueAi(lead.id, messageBody!, parsed.externalId ?? lead.id);
      } else {
        await enqueueReplyForLead(lead.id, messageBody!, idleSec);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, leadId: lead.id, idleSec },
        '[process-inbound] enqueue IA falhou'
      );
    }
  }

  return { ok: true, leadId: lead.id, isNewLead: isNew };
}
