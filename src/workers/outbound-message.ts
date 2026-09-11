/**
 * Worker: processa envios OUTBOUND (texto/mídia) via uazapi.
 *
 * Job shape (`outbound-send` em sendQueue):
 *   { messageId, leadId, type, body?, mediaUrl?, mediaCaption?, fileName? }
 *
 * Pipeline:
 *   1. Resolve adapter da connection do lead
 *   2. Roteia send por tipo de mensagem
 *   3. Atualiza message status='sent' + externalId em sucesso
 *   4. Em falha permanente, marca 'failed' e notifica admin
 *
 * Rate-limit já configurado em sendQueue (limiter no PRD: 30 msg/min).
 */
import { Worker } from 'bullmq';
import { sendQueue } from '@/lib/queue';
import { getRedis } from '@/lib/redis';
import { logger } from '@/lib/logger';
import { getAdapterForLead } from '@/modules/channels/service';
import { markSent, markFailed, reads as messageReads } from '@/modules/messages/service';
import { reads as leadReads } from '@/modules/leads/service';
import { getConfigRow as getAiConfigRow } from '@/modules/ai-agent/queries';
import { notifyAPIFailure } from '@/lib/notifications/api-failure';
import { UazapiError } from '@/modules/channels/whatsapp/client';
import { markSent as markScheduledSent, markFailed as markScheduledFailed } from '@/modules/scheduler/service';
import { markSent as markFollowupSent, markFailed as markFollowupFailed } from '@/modules/followup/service';
import type { UserRole } from '@/lib/auth-helpers';

const DEFAULT_TYPING_MS_PER_CHAR = 35;
const TYPING_DELAY_MIN_MS = 1200;
const TYPING_DELAY_MAX_MS = 6000;

/**
 * Prefixa o body com a assinatura "*Nome*\n\n" pras mensagens que saem
 * pelo WhatsApp. Cliente pediu pra REMOVER o cargo da assinatura (antes ia
 * "*Atendente João*" / "*Gerente Carlos*"; agora vai só "*João*" /
 * "*Carlos*"). Vale pra humano + IA — a IA se passa por atendente, mas
 * agora sem revelar o rótulo "Atendente" no cabeçalho.
 *
 * Eco do dono (sender='owner') passa SEM assinar — esse já saiu pelo celular do
 * dono diretamente, sem nossa assinatura.
 *
 * `previous` é a outbound IMEDIATAMENTE anterior do mesmo lead (qualquer
 * sender humano/IA/owner): se ela tinha o MESMO sender+senderName que a atual,
 * pulamos a assinatura — é uma sequência consecutiva do mesmo ator (ex:
 * 2 balões da IA seguidos). Só assina na TROCA: IA→humano, humano→IA, ou
 * humano A→humano B. Primeira mensagem da conversa (`previous=null`) também
 * assina.
 */
function maybeSignBody(
  body: string | null | undefined,
  msg: {
    sender: 'lead' | 'human' | 'ai' | 'owner';
    senderName: string | null;
    senderRole: UserRole | null;
  },
  previous: { sender: 'lead' | 'human' | 'ai' | 'owner'; senderName: string | null } | null
): string {
  if (!body) return '';
  // Assinatura desligável por deploy. Num CRM de PROSPECÇÃO cada BDR tem o
  // próprio número, então o `*Nome*` no topo da mensagem é redundante e
  // esquisito para o lead — a Acme desliga com FEATURE_MSG_SIGNATURE=false.
  // Opt-out: ausente/qualquer outro valor = assina (comportamento dos clientes
  // de atendimento, onde vários dividem um número e a assinatura diz quem falou).
  const assinaturaFlag = process.env.FEATURE_MSG_SIGNATURE?.trim().toLowerCase();
  if (assinaturaFlag === 'false' || assinaturaFlag === '0' || assinaturaFlag === 'off') return body;
  if (msg.sender !== 'human' && msg.sender !== 'ai') return body;
  if (!msg.senderName) return body;
  // Mesma sequência consecutiva: previous existe e bate sender+senderName.
  // Comparação por trim() pra tolerar espaços extras no nome.
  if (
    previous &&
    previous.sender === msg.sender &&
    (previous.senderName ?? '').trim() === (msg.senderName ?? '').trim()
  ) {
    return body;
  }
  return `*${msg.senderName}*\n\n${body}`;
}

/**
 * Calcula um delay "humano" pro presence "digitando..." da uazapi. O valor é
 * proporcional ao tamanho do texto (simula velocidade de digitação) com piso
 * (1.2s) e teto (6s) pra não ficar nem instantâneo nem absurdo. Usado pra
 * texto e captions de mídia.
 *
 * `msPerChar` é configurável por unidade via `ai_agent_config.typing_ms_per_char`.
 * Default 35ms/char cobre o range típico:
 *   - "ok" → piso 1.2s
 *   - parágrafo de ~150 char → 5.25s
 *   - texto longo → teto 6s
 *
 * msPerChar=0 ainda respeita o piso de 1.2s — pra eliminar totalmente o
 * delay de digitação, configure msPerChar=0 e blockSendEnabled=false (mídia
 * sem caption não passa por aqui, usa MEDIA_PRESENCE_DELAY_MS).
 */
function humanTypingDelay(
  text: string | null | undefined,
  msPerChar: number = DEFAULT_TYPING_MS_PER_CHAR
): number {
  const len = text?.length ?? 0;
  if (len === 0) return 0;
  const safeMsPerChar = Number.isFinite(msPerChar) && msPerChar >= 0 ? msPerChar : DEFAULT_TYPING_MS_PER_CHAR;
  return Math.min(Math.max(len * safeMsPerChar, TYPING_DELAY_MIN_MS), TYPING_DELAY_MAX_MS);
}

/**
 * Delay fixo curto pra mídia sem caption — só pra renderizar o "enviando
 * foto/áudio..." brevemente sem segurar a entrega.
 */
const MEDIA_PRESENCE_DELAY_MS = 1500;

export interface OutboundJobData {
  messageId: string;
  leadId: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'document';
  body?: string | null;
  mediaUrl?: string | null;
  mediaCaption?: string | null;
  fileName?: string | null;
  /** Se vier de scheduled-message, atualizar status no scheduled */
  scheduledMessageId?: string;
  /** Se vier de followup, atualizar status no followup */
  followupId?: string;
}


/**
 * Executa UM envio outbound. É o mesmo corpo que o worker BullMQ roda — e é
 * exatamente por isso que vive fora dele: sem Redis (Cloudflare Worker) não há
 * consumidor de fila, e a rota precisa chamar isto direto, inline. Duplicar a
 * lógica nos dois caminhos seria garantir que eles divergissem.
 *
 * `retry` só existe quando quem chama sabe retentar (o BullMQ). Inline, uma
 * falha transitória vira falha definitiva na hora — não há a quem re-throw.
 */
export async function processOutboundJob(
  data: OutboundJobData,
  retry?: { attempt: number; maxAttempts: number }
): Promise<{ ok: boolean; externalId?: string | null; reason?: string }> {
      const lead = await leadReads.getById(data.leadId);
      // Identificador externo do contato: pra WhatsApp é o número (mesmo
      // valor de lead.phone); pra Instagram é o IG-scoped user ID (sender.id
      // do webhook). Adapter recebe sempre via `externalContactId`.
      const contactId = lead?.externalContactId;
      if (!lead || !contactId) {
        await markFailed(data.messageId, 'lead sem identificador externo');
        if (data.scheduledMessageId) await markScheduledFailed(data.scheduledMessageId, 'lead sem identificador externo');
        if (data.followupId) await markFollowupFailed(data.followupId, 'lead sem identificador externo');
        return { ok: false, reason: 'no_contact_id' };
      }

      try {
        // Carrega a message do banco pra saber sender + senderName + senderRole
        // e decidir se a saída precisa de assinatura. O `data.body` do job é o
        // body limpo (sem assinatura) — passamos a "versão assinada" só pro adapter.
        // senderRole é resolvido via JOIN com users em messageReads.getById.
        const persisted = await messageReads.getById(data.messageId);
        const sender = persisted?.sender ?? 'ai';
        const senderName = persisted?.senderName ?? null;
        const senderRole = persisted?.senderRole ?? null;
        const signCtx = { sender, senderName, senderRole };

        // Álbum: quando metadata.albumOrder existe, pular o presence delay
        // ("digitando..."/"enviando foto...") pra fotos chegarem em sequência
        // rápida e o WhatsApp mobile agrupar visualmente como álbum.
        const meta = (persisted?.metadata ?? null) as { albumOrder?: number; albumTotal?: number } | null;
        const isAlbumPhoto = typeof meta?.albumOrder === 'number';
        const mediaPresence = isAlbumPhoto ? 0 : MEDIA_PRESENCE_DELAY_MS;

        // Outbound anterior do mesmo lead — define se essa msg ABRE uma nova
        // sequência (assina) ou continua a do mesmo ator (não assina).
        // Funciona em sequências da IA (múltiplos balões enfileirados) porque
        // cada job roda com delay entre balões: o 2º job consegue ver o 1º já
        // persistido no DB.
        const previous = await messageReads.previousOutboundForSignature(data.leadId, data.messageId);

        const adapter = await getAdapterForLead(data.leadId);

        // Velocidade de digitação é configurável. Best-effort: se a config
        // sumir, cai no default 35ms/char (comportamento legado).
        const aiCfg = await getAiConfigRow().catch(() => null);
        const msPerChar = aiCfg?.typingMsPerChar ?? DEFAULT_TYPING_MS_PER_CHAR;

        // Reply/quote: quando a outbound foi criada citando outra msg (interno
        // ou inbound), o messages row guarda `quotedMessageId` como o INTERNAL
        // id da msg citada. Pra mandar pra uazapi precisamos do EXTERNAL id
        // (msgid do WhatsApp). Resolve aqui (uma query simples).
        let quotedExternalId: string | null = null;
        if (persisted?.quotedMessageId) {
          const quoted = await messageReads.getById(persisted.quotedMessageId);
          quotedExternalId = quoted?.externalId ?? null;
          // Se a msg citada é INBOUND, o id interno na verdade nasceu do
          // próprio externalId (parse-inbound sempre seta external_id) — uso
          // direto se o lookup falhou.
          if (!quotedExternalId) quotedExternalId = persisted.quotedMessageId;
        }

        switch (data.type) {
          case 'text': {
            const signed = maybeSignBody(data.body, signCtx, previous);
            await adapter.sendText(contactId, signed, humanTypingDelay(signed, msPerChar), quotedExternalId);
            break;
          }
          case 'image': {
            if (!data.mediaUrl) throw new Error('mediaUrl ausente para image');
            const caption = maybeSignBody(data.mediaCaption ?? '', signCtx, previous);
            // Álbum: foto sem caption não-1ª passa direto (mediaPresence=0).
            // Caption (1ª do álbum ou foto avulsa): usa humanTypingDelay.
            const delay = caption ? humanTypingDelay(caption, msPerChar) : mediaPresence;
            await adapter.sendImage(contactId, data.mediaUrl, caption || undefined, delay, quotedExternalId);
            break;
          }
          case 'audio':
            if (!data.mediaUrl) throw new Error('mediaUrl ausente para audio');
            await adapter.sendAudio(contactId, data.mediaUrl, mediaPresence, quotedExternalId);
            break;
          case 'video': {
            if (!data.mediaUrl) throw new Error('mediaUrl ausente para video');
            const caption = maybeSignBody(data.mediaCaption ?? '', signCtx, previous);
            const delay = caption ? humanTypingDelay(caption, msPerChar) : mediaPresence;
            await adapter.sendVideo(contactId, data.mediaUrl, caption || undefined, delay, quotedExternalId);
            break;
          }
          case 'document':
            if (!data.mediaUrl) throw new Error('mediaUrl ausente para document');
            await adapter.sendDocument(contactId, data.mediaUrl, data.fileName ?? 'documento', mediaPresence, quotedExternalId);
            break;
        }

        const externalId = adapter.lastResult?.message_id ?? null;
        await markSent(data.messageId, externalId);
        if (data.scheduledMessageId) await markScheduledSent(data.scheduledMessageId);
        if (data.followupId) await markFollowupSent(data.followupId);

        return { ok: true, externalId };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const transient = err instanceof UazapiError && err.isTransient();

        if (transient && retry && retry.attempt < retry.maxAttempts - 1) {
          // Re-throw pra BullMQ retentar com backoff
          logger.warn(
            { messageId: data.messageId, attempt: retry.attempt + 1, err: errMsg },
            '[worker:outbound] transient, retrying'
          );
          throw err;
        }

        // Falha definitiva
        await markFailed(data.messageId, errMsg);
        if (data.scheduledMessageId) await markScheduledFailed(data.scheduledMessageId, errMsg);
        if (data.followupId) await markFollowupFailed(data.followupId, errMsg);

        // Notifica admin (best-effort, não bloqueia)
        notifyAPIFailure({
          service: 'whatsapp',
          operation: `outbound-send (${data.type})`,
          errorMessage: errMsg,
          statusCode: err instanceof UazapiError ? err.status : undefined,
          leadId: data.leadId,
        }).catch(() => {});

        return { ok: false, reason: errMsg };
      }
}

export function startOutboundMessageWorker() {
  const worker = new Worker(
    sendQueue.name,
    async (job) =>
      processOutboundJob(job.data as OutboundJobData, {
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 3,
      }),
    {
      connection: getRedis()!,
      concurrency: 3,
      // Rate limit já vem do sendQueue config (30/min) — ver lib/queue.ts
    }
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, err: err instanceof Error ? err.message : String(err) },
      '[worker:outbound] job falhou (após retries)'
    );
  });

  return worker;
}
