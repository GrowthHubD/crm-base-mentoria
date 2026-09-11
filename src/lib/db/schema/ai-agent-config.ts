import { pgTable, text, integer, timestamp, boolean, jsonb } from 'drizzle-orm/pg-core';

/**
 * Item de regra de transferência (configurável pelo admin).
 * `key` identifica regra default conhecida pelo backend; `label` é o texto pra UI.
 * Quando a IA detecta o gatilho, ela para de responder e passa pro humano.
 */
export interface TransferRule {
  key: string;
  label: string;
  description?: string;
  enabled: boolean;
}

/**
 * Item de follow-up automático (até 4 entries).
 *
 * `instruction` é uma DIRETRIZ que o LLM usa pra escrever a mensagem do
 * follow-up baseado no histórico do lead. Não é texto literal — a mensagem é
 * gerada na hora do disparo via generateFollowupForLead().
 *
 * `message` mantido por compat — se preenchido em rounds antigos, vira
 * fallback caso o LLM falhe.
 */
export interface FollowupRule {
  enabled: boolean;
  afterMinutes: number;
  /** Diretriz pra IA escrever o follow-up (ex: "Lembrete leve, pergunte se há
   *  interesse ainda"). */
  instruction?: string;
  /** @deprecated Use `instruction`. Mantido como fallback se LLM falhar. */
  message?: string;
}

/**
 * Mapeamento "palavra-chave detectada no chat → canal de atribuição na dashboard".
 * Quando o lead manda uma mensagem contendo `keyword` (case-insensitive, match
 * substring), o lead recebe `attributedChannel = channel` se ainda não tiver
 * canal atribuído manualmente. Fonte de marketing (ex: "vim pelo insta").
 */
export interface ChannelKeywordRule {
  keyword: string;
  channel: 'whatsapp' | 'instagram' | 'google';
}

/**
 * Configuração do Agente IA (single-tenant: uma única row).
 *
 * Este é um SCAFFOLD genérico de auto-reply: a IA responde o lead com um LLM
 * (OpenRouter) usando o systemPrompt + personalidade, respeita horário de
 * operação, faz follow-ups e transfere pro humano por regra/keyword. Sem
 * nenhuma regra de negócio de nicho — pra plugar catálogo/pagamento/booking,
 * adicione tools em modules/ai-agent/tools.ts.
 */
export const aiAgentConfig = pgTable(
  'ai_agent_config',
  {
    id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),

    // ── Core ──────────────────────────────────────────────────────
    enabled: boolean('enabled').notNull().default(false),
    // Custom prompt opcional. Se nulo/curto, service usa template com personality+tone.
    systemPrompt: text('system_prompt'),
    // Prompt do "Suporte IA" — assistente DOS ATENDENTES (dentro do CRM).
    // Orienta o atendente humano, diferente do systemPrompt (que fala com o cliente).
    // Se nulo, usa template embutido em modules/ai-agent/support-prompts.ts.
    supportSystemPrompt: text('support_system_prompt'),
    // Temperatura armazenada * 100 (0–100). Service divide por 100.
    // 30 = 0,3 na chamada do modelo (o service divide por 100). Atendimento
    // quer consistencia, nao criatividade: acima de ~0,4 o mesmo cliente
    // recebe respostas diferentes pra mesma pergunta e as regras do prompt
    // comecam a ser "interpretadas". Ajustavel por unidade na tela do agente.
    temperature: integer('temperature').notNull().default(30),
    // Após N respostas consecutivas da IA sem resposta do cliente → transfere.
    maxMessagesBeforeHandoff: integer('max_messages_before_handoff').notNull().default(10),

    // ── Personalidade ─────────────────────────────────────────────
    agentName: text('agent_name').notNull().default('Assistente'),
    personality: text('personality'),
    tone: text('tone').notNull().default('friendly'), // formal | friendly | casual
    useEmojis: boolean('use_emojis').notNull().default(true),

    // ── Mensagens prontas ─────────────────────────────────────────
    welcomeMessage: text('welcome_message'),
    transferMessage: text('transfer_message')
      .notNull()
      .default('Deixa eu chamar um colega aqui pra continuar com você, um instante!'),

    // ── Timing ────────────────────────────────────────────────────
    // Segundos que a IA aguarda SEM RESPOSTA HUMANA antes de assumir o
    // atendimento. 0 = IA responde direto. Quando >0: o job de resposta fica
    // delayed X segundos; o timer reseta a cada nova mensagem do lead (debounce)
    // E é CANCELADO se um atendente humano responder antes.
    idleSecondsBeforeAi: integer('idle_seconds_before_ai').notNull().default(0),
    idleMinutesUser: integer('idle_minutes_user').notNull().default(20),

    // Velocidade do presence "digitando..." em ms POR CARACTERE. A uazapi exibe
    // "digitando..." por esse tempo antes de entregar o balão (simula humano).
    typingMsPerChar: integer('typing_ms_per_char').notNull().default(35),

    // ── Envio em blocos ───────────────────────────────────────────
    blockSendEnabled: boolean('block_send_enabled').notNull().default(true),
    blockSendDelaySec: integer('block_send_delay_sec').notNull().default(1),

    // ── Follow-ups automáticos (até 4) ────────────────────────────
    followups: jsonb('followups').$type<FollowupRule[]>().notNull().default([]),

    // ── Atribuição de canal via palavra-chave ─────────────────────
    channelKeywords: jsonb('channel_keywords').$type<ChannelKeywordRule[]>().notNull().default([]),

    // ── Regras de transferência ───────────────────────────────────
    transferRules: jsonb('transfer_rules').$type<TransferRule[]>().notNull().default([]),

    // ── Horário de operação ───────────────────────────────────────
    operationHoursText: text('operation_hours_text'),
    operationHours: jsonb('operation_hours').$type<{
      start: string;
      end: string;
      days: number[];
    }>(),

    // ── Pausa de emergência (global) ──────────────────────────────
    // Quando setado e > now, NENHUMA mensagem da IA sai (nem resposta a inbound,
    // nem follow-up). Botão "PARAR A IA" no /agente-ia preenche esta coluna.
    pausedUntil: timestamp('paused_until'),

    // ── Bloqueio temporário renovável por humano ──────────────────
    // Minutos que a IA cala após o atendente humano enviar mensagem pro lead.
    // Cada msg renova o timer. Cliente nunca pega IA e humano falando junto.
    aiPauseMinutesAfterHuman: integer('ai_pause_minutes_after_human').notNull().default(20),
    // Minutos que a IA cala quando detecta trigger de desengajamento/cancelamento.
    aiPauseMinutesAfterCancellation: integer('ai_pause_minutes_after_cancellation').notNull().default(20),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  }
);

export type AiAgentConfigRow = typeof aiAgentConfig.$inferSelect;
