/**
 * Service do Agente IA — scaffold GENÉRICO de auto-reply.
 *
 * Pipeline (worker):
 *   1. Lead manda mensagem → worker `ai-agent` consome job
 *   2. Service carrega a config (singleton) + histórico (últimas ~20)
 *   3. Monta o prompt (personalidade + tom + horário + regras de transferência)
 *   4. Chama OpenRouter (chat completions, API compatível com OpenAI)
 *   5. Detecta transferência ([TRANSFERIR] ou keyword) → marca handoff, não responde
 *   6. Caso contrário, registra outbound + enfileira envio (em balões)
 *
 * Sem OPENROUTER_API_KEY: transfere pro humano com fallback respeitoso.
 * Sem catálogo, PIX, reserva, cortesias, RAG ou tools de domínio.
 */
import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { logger } from '@/lib/logger';
import { reads as messagesReads, recordPendingOutbound } from '@/modules/messages/service';
import { reads as leadReads, patchLead } from '@/modules/leads/service';
import { buildAgentPrompt, sanitizeForPrompt, shouldTransfer, forgetStaleHistory } from './prompts';
import { getOrInitConfig, getConfigRow } from './queries';
import { upsertConfig } from './mutations';
import type {
  AgentConfig,
  AgentResponse,
  AiAgentConfigInput,
  AiAgentConfigPublic,
  AiAgentTone,
  TransferRule,
} from './types';
import type { AiAgentConfigRow } from '@/lib/db/schema/ai-agent-config';
import { QUEUES_ENABLED } from '@/lib/queue';
import { dispatchOutbound } from '@/lib/dispatch';
import { emitToEmpresa } from '@/lib/socket';

const CRM_ROOM = 'crm';

const MODEL_ID = process.env.AI_MODEL_ID ?? 'google/gemini-3-flash-preview';
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
// Teto baixo pra forçar respostas curtas no WhatsApp.
const MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS ?? '350', 10);
const BUSINESS_NAME = process.env.BUSINESS_NAME?.trim() || undefined;

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!API_KEY) return null;
  if (!_client) {
    _client = new OpenAI({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXTAUTH_URL ?? 'http://localhost:3000',
        'X-Title': 'CRM Auto-Reply',
      },
    });
  }
  return _client;
}

// ── Config (UI admin) ────────────────────────────────────────────────────────

function rowToPublic(row: AiAgentConfigRow): AiAgentConfigPublic {
  return {
    id: row.id,
    enabled: row.enabled,
    systemPrompt: row.systemPrompt,
    supportSystemPrompt: row.supportSystemPrompt,
    temperature: row.temperature,
    maxMessagesBeforeHandoff: row.maxMessagesBeforeHandoff,
    agentName: row.agentName,
    personality: row.personality,
    tone: row.tone as AiAgentTone,
    useEmojis: row.useEmojis,
    welcomeMessage: row.welcomeMessage,
    transferMessage: row.transferMessage,
    idleSecondsBeforeAi: row.idleSecondsBeforeAi,
    idleMinutesUser: row.idleMinutesUser,
    typingMsPerChar: row.typingMsPerChar,
    blockSendEnabled: row.blockSendEnabled,
    blockSendDelaySec: row.blockSendDelaySec,
    followups: row.followups ?? [],
    channelKeywords: row.channelKeywords ?? [],
    transferRules: row.transferRules ?? [],
    operationHoursText: row.operationHoursText,
    operationHours: row.operationHours ?? null,
    pausedUntil: row.pausedUntil,
    aiPauseMinutesAfterHuman: row.aiPauseMinutesAfterHuman,
    aiPauseMinutesAfterCancellation: row.aiPauseMinutesAfterCancellation,
    updatedAt: row.updatedAt,
  };
}

/** Lê a config atual em formato público pra UI. Cria row default se vazia. */
export async function getPublicConfig(): Promise<AiAgentConfigPublic> {
  const row = await getOrInitConfig();
  return rowToPublic(row);
}

/**
 * Compila o prompt efetivo do agente pra preview na UI — mostra o template
 * exato que vai pro LLM, com dados-amostra (lead "João", mensagem placeholder).
 * Reflete a config PERSISTIDA no banco.
 */
export async function buildPreviewPrompt(): Promise<{ system: string; user: string }> {
  const row = await getOrInitConfig();
  const config = rowToAgentConfig(row);
  const { system, user } = buildAgentPrompt({
    config,
    history: [],
    userMessage: '[mensagem do cliente aparece aqui]',
    leadName: 'João',
    businessName: BUSINESS_NAME,
    todayContext: todayContextSaoPaulo(),
  });
  return { system, user };
}

/** Persiste patch parcial. Valida ranges básicos. */
export async function saveConfig(input: AiAgentConfigInput): Promise<AiAgentConfigPublic> {
  if (input.temperature !== undefined && (input.temperature < 0 || input.temperature > 100)) {
    throw new Error('temperature deve estar entre 0 e 100');
  }
  if (input.maxMessagesBeforeHandoff !== undefined &&
      (input.maxMessagesBeforeHandoff < 1 || input.maxMessagesBeforeHandoff > 50)) {
    throw new Error('maxMessagesBeforeHandoff deve estar entre 1 e 50');
  }
  if (input.tone !== undefined && !['formal', 'friendly', 'casual'].includes(input.tone)) {
    throw new Error('tone inválido');
  }
  if (input.followups !== undefined) {
    if (!Array.isArray(input.followups)) throw new Error('followups deve ser array');
    if (input.followups.length > 10) throw new Error('máximo 10 follow-ups');
  }
  if (input.aiPauseMinutesAfterHuman !== undefined &&
      (input.aiPauseMinutesAfterHuman < 0 || input.aiPauseMinutesAfterHuman > 1440)) {
    throw new Error('aiPauseMinutesAfterHuman deve estar entre 0 e 1440');
  }
  if (input.aiPauseMinutesAfterCancellation !== undefined &&
      (input.aiPauseMinutesAfterCancellation < 0 || input.aiPauseMinutesAfterCancellation > 1440)) {
    throw new Error('aiPauseMinutesAfterCancellation deve estar entre 0 e 1440');
  }
  if (input.typingMsPerChar !== undefined &&
      (input.typingMsPerChar < 0 || input.typingMsPerChar > 200)) {
    throw new Error('typingMsPerChar deve estar entre 0 e 200');
  }
  if (input.idleSecondsBeforeAi !== undefined &&
      (input.idleSecondsBeforeAi < 0 || input.idleSecondsBeforeAi > 3600)) {
    throw new Error('idleSecondsBeforeAi deve estar entre 0 e 3600');
  }

  await upsertConfig(input);
  return getPublicConfig();
}

// ── Pipeline da IA (worker) ─────────────────────────────────────────────────

/** Adapta a row do schema pro shape enxuto que o prompt consome. */
function rowToAgentConfig(row: AiAgentConfigRow): AgentConfig {
  return {
    systemPrompt: row.systemPrompt,
    agentName: row.agentName,
    personality: row.personality,
    tone: row.tone as AiAgentTone,
    useEmojis: row.useEmojis,
    transferRules: (row.transferRules ?? []).filter(r => r.enabled).map(r => r.label),
    operationHoursText: row.operationHoursText,
    operationHours: row.operationHours ?? null,
  };
}

interface RuntimeConfig {
  config: AgentConfig;
  /** Regras completas (com keywords, se houver) pra shouldTransfer. */
  transferRules: TransferRule[];
  enabled: boolean;
  temperature: number;
  maxMessages: number;
  blockSendEnabled: boolean;
  blockSendDelaySec: number;
  transferMessage: string;
  agentName: string;
  pausedUntil: Date | null;
  aiPauseMinutesAfterCancellation: number;
}

async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const row = await getConfigRow();
  if (!row) {
    return {
      config: { systemPrompt: null, agentName: 'Assistente', personality: null, tone: 'friendly', useEmojis: true, transferRules: [] },
      transferRules: [],
      enabled: false,
      temperature: 0.3,
      maxMessages: 10,
      blockSendEnabled: false,
      blockSendDelaySec: 0,
      transferMessage: 'Deixa eu chamar um colega aqui pra continuar com você, um instante.',
      agentName: 'Assistente',
      pausedUntil: null,
      aiPauseMinutesAfterCancellation: 20,
    };
  }
  return {
    config: rowToAgentConfig(row),
    transferRules: row.transferRules ?? [],
    enabled: row.enabled,
    temperature: row.temperature / 100,
    maxMessages: row.maxMessagesBeforeHandoff,
    blockSendEnabled: row.blockSendEnabled,
    blockSendDelaySec: row.blockSendDelaySec,
    transferMessage: row.transferMessage,
    agentName: row.agentName,
    pausedUntil: row.pausedUntil,
    aiPauseMinutesAfterCancellation: row.aiPauseMinutesAfterCancellation,
  };
}

/**
 * Contexto de data pro robô, no fuso de Brasília. Ex:
 * "hoje é segunda-feira, 27/07/2026 (fuso de Brasília)".
 */
function todayContextSaoPaulo(): string {
  const now = new Date();
  const tz = 'America/Sao_Paulo';
  const weekday = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, weekday: 'long' }).format(now);
  const date = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(now);
  return `hoje é ${weekday}, ${date} (fuso de Brasília).`;
}

/**
 * Gera a resposta da IA pra uma mensagem do lead. O caller (worker) é
 * responsável por persistir e enfileirar o envio. NÃO envia nada aqui.
 */
export async function generateReplyForLead(
  leadId: string,
  userMessageRaw: string
): Promise<AgentResponse> {
  const lead = await leadReads.getById(leadId);
  if (!lead) throw new Error(`Lead ${leadId} não encontrado`);

  // Bloqueio pós-conversão (janela em que o humano assume): transfere sem responder.
  if (lead.aiBlockedUntil && lead.aiBlockedUntil.getTime() > Date.now()) {
    logger.info({ leadId, aiBlockedUntil: lead.aiBlockedUntil }, '[ai-agent] IA bloqueada — transferindo');
    return { reply: '', transferred: true, fallback: false };
  }

  // Pausa renovável: atendente humano falou recente / trigger de cancelamento.
  // IA cala silenciosamente (não é transfer — é só "não fala junto do humano").
  if (lead.aiPausedUntil && lead.aiPausedUntil.getTime() > Date.now()) {
    logger.info({ leadId, aiPausedUntil: lead.aiPausedUntil }, '[ai-agent] IA em pausa renovável');
    return { reply: '', transferred: false, fallback: false };
  }

  const rt = await loadRuntimeConfig();
  if (!rt.enabled) {
    return { reply: 'Em alguns instantes um colega vai responder. Obrigado!', transferred: true, fallback: true };
  }

  // Pausa de EMERGÊNCIA global (botão "Parar IA"). Cala sem mover o lead.
  if (rt.pausedUntil && rt.pausedUntil.getTime() > Date.now()) {
    logger.info({ leadId, pausedUntil: rt.pausedUntil }, '[ai-agent] IA pausada (emergência)');
    return { reply: '', transferred: false, fallback: false };
  }

  const userMessage = sanitizeForPrompt(userMessageRaw);
  // Esquecimento de 7 dias: se o cliente volta após +7 dias em silêncio, o
  // histórico antigo é descartado e ele é atendido do zero (sem retomar
  // combinado/contexto de semanas atrás).
  const history = forgetStaleHistory(await messagesReads.conversation(leadId, 20));

  // Anti-loop: se a IA já respondeu N vezes seguidas, transfere.
  const recentAi = history.slice(-5).filter(m => m.sender === 'ai').length;
  if (recentAi >= rt.maxMessages) {
    return { reply: rt.transferMessage, transferred: true, fallback: false };
  }

  // Transferência por keyword na MENSAGEM DO CLIENTE (regras com keywords).
  if (shouldTransfer(userMessage, rt.transferRules)) {
    await renewCancellationPause(leadId, rt.aiPauseMinutesAfterCancellation);
    return { reply: rt.transferMessage, transferred: true, fallback: false };
  }

  const client = getClient();
  if (!client) {
    return { reply: 'Deixa só um momento, vou pedir pra um colega continuar com você.', transferred: true, fallback: true };
  }

  const { system, user } = buildAgentPrompt({
    config: rt.config,
    history,
    userMessage,
    leadName: lead.name,
    businessName: BUSINESS_NAME,
    todayContext: todayContextSaoPaulo(),
  });

  try {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const completion = await client.chat.completions.create({
      model: MODEL_ID,
      messages,
      temperature: rt.temperature,
      max_tokens: MAX_TOKENS,
    });

    let finalText = completion.choices[0]?.message?.content?.trim() ?? '';

    // Salvaguarda anti-filler: o modelo às vezes devolve content vazio. Sem
    // isto o cliente recebe "Deixa só um instante..." mesmo com a conversa
    // toda na mão. Uma tentativa explícita de síntese antes de desistir.
    if (!finalText) {
      try {
        const recovery = await client.chat.completions.create({
          model: MODEL_ID,
          messages: [
            ...messages,
            {
              role: 'user',
              content:
                'Escreva AGORA, em português, a resposta ao cliente com base no que já foi dito acima. Texto puro, sem devolver vazio.',
            },
          ],
          temperature: rt.temperature,
          max_tokens: MAX_TOKENS,
        });
        finalText = recovery.choices[0]?.message?.content?.trim() ?? '';
        logger.info(
          { leadId, finalTextLen: finalText.length },
          '[ai-agent] síntese de recuperação após texto vazio'
        );
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, leadId },
          '[ai-agent] síntese de recuperação falhou (segue pro fallback)'
        );
      }
    }

    const willTransfer = shouldTransfer(finalText, rt.transferRules);

    logger.info(
      { leadId, finalTextLen: finalText.length, willTransfer },
      '[ai-agent] LLM gerou resposta final'
    );

    if (willTransfer) {
      await renewCancellationPause(leadId, rt.aiPauseMinutesAfterCancellation);
      return { reply: rt.transferMessage, transferred: true, fallback: false };
    }

    return {
      reply: finalText || 'Deixa só um instante, já te respondo aqui.',
      transferred: false,
      fallback: false,
    };
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, leadId }, '[ai-agent] geração falhou');
    return {
      reply: 'Tive um problema aqui agora. Vou pedir pra um colega continuar com você, um instante.',
      transferred: true,
      fallback: true,
    };
  }
}

/** Pausa renovável após transferência (dá espaço pro atendente assumir). */
async function renewCancellationPause(leadId: string, minutes: number): Promise<void> {
  try {
    const { renewAiPause } = await import('@/modules/leads/service');
    await renewAiPause(leadId, minutes, 'cancellation_trigger');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, leadId }, '[ai-agent] renovar aiPausedUntil falhou');
  }
}

/**
 * Gera mensagem de follow-up contextualizada via LLM. Não há mensagem do
 * cliente — a IA retoma o contato após N minutos de silêncio. O conteúdo é
 * decidido pela `instruction` configurada no /agente-ia.
 *
 * Retorna `null` quando a IA está desabilitada/pausada, o lead está com IA off,
 * ou o LLM falhou. O caller (worker) aplica fallback.
 */
export async function generateFollowupForLead(
  leadId: string,
  instruction: string
): Promise<string | null> {
  const lead = await leadReads.getById(leadId);
  if (!lead) return null;
  if (lead.aiBlockedUntil && lead.aiBlockedUntil.getTime() > Date.now()) return null;
  if (lead.aiPausedUntil && lead.aiPausedUntil.getTime() > Date.now()) return null;
  // Toggle por-lead: atendente desativou a IA pra esse cliente específico.
  if (!lead.aiAgentActive) return null;

  const rt = await loadRuntimeConfig();
  if (!rt.enabled) return null;
  if (rt.pausedUntil && rt.pausedUntil.getTime() > Date.now()) return null;

  const client = getClient();
  if (!client) return null;

  const history = forgetStaleHistory(await messagesReads.conversation(leadId, 20));

  // Reaproveita o system prompt do agente (personalidade/tom/regras).
  const { system: baseSystem } = buildAgentPrompt({
    config: rt.config,
    history,
    userMessage: '',
    leadName: lead.name,
    businessName: BUSINESS_NAME,
    todayContext: todayContextSaoPaulo(),
  });

  const minutesSinceLastOutbound = lead.lastOutboundAt
    ? Math.max(0, Math.floor((Date.now() - lead.lastOutboundAt.getTime()) / 60_000))
    : null;
  const silentSince = minutesSinceLastOutbound !== null
    ? minutesSinceLastOutbound < 60
      ? `${minutesSinceLastOutbound} minutos`
      : `${Math.floor(minutesSinceLastOutbound / 60)} horas`
    : 'um tempo';

  const followupSystem = `${baseSystem}

CONTEXTO DESTA INTERAÇÃO — FOLLOW-UP:
Você está RETOMANDO contato com o cliente. Ele não respondeu há ${silentSince}.

DIRETRIZ DESTA RODADA: ${instruction}

REGRAS:
- Escreva 1 ou 2 frases curtas, no máximo. Direto ao ponto.
- NÃO repita literalmente o que você já disse no histórico — releia e seja diferente.
- NÃO comece com "Oi de novo" / "Voltei aqui" — soa robotizado.
- Não force nada. Se a diretriz não pedir oferta, NÃO ofereça nada.
- Sem assinaturas, sem nome do agente, sem "tudo bem?".

Responda APENAS com o texto da mensagem que vai pro WhatsApp. Sem aspas, sem prefixos.`;

  try {
    const completion = await client.chat.completions.create({
      model: MODEL_ID,
      messages: [
        { role: 'system', content: followupSystem },
        { role: 'user', content: 'Escreva a mensagem de follow-up agora.' },
      ],
      temperature: rt.temperature,
      max_tokens: 180,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    return text || null;
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, leadId }, '[ai-agent] generateFollowupForLead falhou');
    return null;
  }
}

/**
 * Quebra a resposta em "balões" no estilo humano. Divide por parágrafos e, se
 * um pedaço ainda passar de ~220 chars, por frases. Teto de `maxBubbles` (2):
 * excedentes são concatenados no último balão.
 */
function splitIntoBubbles(reply: string, maxLen = 220, maxBubbles = 2): string[] {
  const raw = reply.trim();
  if (!raw) return [];

  const paragraphs = raw.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxLen) { out.push(p); continue; }
    const sentences = p.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
    let buf = '';
    for (const s of sentences) {
      if ((buf + ' ' + s).trim().length > maxLen && buf) { out.push(buf.trim()); buf = s; }
      else { buf = buf ? `${buf} ${s}` : s; }
    }
    if (buf.trim()) out.push(buf.trim());
  }

  if (out.length === 0) return [raw];
  if (out.length > maxBubbles) {
    const kept = out.slice(0, maxBubbles - 1);
    kept.push(out.slice(maxBubbles - 1).join(' '));
    return kept;
  }
  return out;
}

/**
 * Dispara o fluxo completo de resposta: gera → persiste → enfileira envio.
 * Chamado pelo worker `ai-agent`. Em transferência, marca o handoff e envia a
 * `transferMessage` pro cliente (exceto em fallback estrutural, onde fica mudo).
 */
/**
 * Wrapper de observabilidade do turno da IA.
 *
 * Uma resposta ruim de agente quase nunca aparece numa chamada isolada — ela
 * aparece na cadeia (quantas iteracoes de tool, quanto tempo, se terminou em
 * transferencia). Esta linha unica por turno e o minimo pra conseguir
 * responder "o que aconteceu com o lead X as 14h" sem reproduzir o caso.
 */
export async function handleLeadMessage(
  leadId: string,
  userMessage: string
): Promise<{ replied: boolean; transferred: boolean }> {
  const startedAt = Date.now();
  try {
    const outcome = await runLeadMessageTurn(leadId, userMessage);
    logger.info(
      { leadId, ms: Date.now() - startedAt, model: MODEL_ID, ...outcome },
      '[ai-agent:turn] turno concluido'
    );
    return outcome;
  } catch (err) {
    logger.error(
      {
        leadId,
        ms: Date.now() - startedAt,
        model: MODEL_ID,
        err: err instanceof Error ? err.message : err,
      },
      '[ai-agent:turn] turno falhou'
    );
    throw err;
  }
}

async function runLeadMessageTurn(
  leadId: string,
  userMessage: string
): Promise<{ replied: boolean; transferred: boolean }> {
  const result = await generateReplyForLead(leadId, userMessage);
  const lead = await leadReads.getById(leadId);

  if (result.transferred) {
    // fallback=true = erro estrutural (sem credenciais): desliga a IA pro lead
    // pra evitar loop. Caso normal: a pausa renovável (aiPausedUntil) já foi
    // setada em generateReplyForLead — a IA volta sozinha quando expirar.
    if (result.fallback) {
      await patchLead(leadId, { aiAgentActive: false });
    }

    emitToEmpresa(CRM_ROOM, 'lead:transferRequested', {
      leadId,
      reason: result.fallback ? 'no_credentials' : 'ai_decision',
    });
    emitToEmpresa(CRM_ROOM, 'lead:notify', {
      leadId,
      message: 'IA passou pra atendimento humano. Lead aguardando.',
    });

    // Envia a transferMessage pro cliente (não em fallback — sem atendente real
    // do outro lado, a mensagem genérica só piora a percepção).
    if (!result.fallback && lead && result.reply.trim().length > 0) {
      try {
        const cfgRow = await getConfigRow();
        const aiSenderName = cfgRow?.agentName?.trim() || 'Assistente';
        const transferBody = cfgRow?.transferMessage?.trim() || result.reply.trim();
        const msg = await recordPendingOutbound({
          leadId,
          type: 'text',
          sender: 'ai',
          senderName: aiSenderName,
          body: transferBody,
          metadata: { source: 'ai-agent', kind: 'transfer-handoff' },
        });
        await dispatchOutbound(
          { messageId: msg.id, leadId, type: 'text', body: transferBody },
          { jobId: `out-${msg.id}` }
        );
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : err, leadId }, '[ai-agent] enfileirar msg de transferência falhou');
      }
    }
    return { replied: !result.fallback, transferred: true };
  }

  // Pausa silenciosa (sem reply, sem transfer).
  if (!result.reply || result.reply.trim().length === 0) {
    return { replied: false, transferred: false };
  }

  // Auto-vincula connection se o lead estiver órfão (senão o outbound falha).
  if (lead && !lead.connectionId) {
    try {
      const { ensureLeadHasConnection } = await import('@/modules/scheduler/service');
      await ensureLeadHasConnection(leadId);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, leadId }, '[ai-agent] auto-vincular connection falhou');
    }
  }

  const rt = await loadRuntimeConfig();
  const blockEnabled = rt.blockSendEnabled;
  const delayBetweenSec = rt.blockSendDelaySec || 1;
  const aiSenderName = rt.agentName?.trim() || 'Assistente';

  const bubbles = blockEnabled ? splitIntoBubbles(result.reply) : [result.reply.trim()];
  if (bubbles.length === 0) {
    return { replied: false, transferred: false };
  }

  logger.info(
    { leadId, bubbles: bubbles.length, blockEnabled, delayBetweenSec },
    '[ai-agent] enfileirando resposta em balões'
  );

  for (let i = 0; i < bubbles.length; i++) {
    const body = bubbles[i];
    const msg = await recordPendingOutbound({
      leadId,
      type: 'text',
      sender: 'ai',
      senderName: aiSenderName,
      body,
      metadata: { source: 'ai-agent', bubbleIndex: i, bubbleTotal: bubbles.length },
    });
    // Sem fila, `delay` não existe: o envio é inline e imediato. Para os balões
    // não saírem todos no mesmo segundo (o que denuncia o robô e atropela a
    // leitura), a pausa acontece aqui — estamos dentro do `waitUntil`, depois
    // da resposta HTTP, então esperar aqui não custa latência a ninguém.
    if (!QUEUES_ENABLED && i > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayBetweenSec * 1000));
    }
    await dispatchOutbound(
      { messageId: msg.id, leadId, type: 'text', body },
      { jobId: `out-${msg.id}`, delayMs: i === 0 ? 0 : i * delayBetweenSec * 1000 }
    );
  }

  // Reagenda a sequência de follow-ups — o relógio "X min sem resposta" reinicia
  // a cada vez que a IA fala. Inbound futuro do lead cancela tudo.
  if (lead) {
    try {
      const { rescheduleSequenceForLead } = await import('@/modules/followup/service');
      await rescheduleSequenceForLead(leadId);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err, leadId }, '[ai-agent] reagendar follow-ups falhou');
    }
  }

  return { replied: true, transferred: false };
}
