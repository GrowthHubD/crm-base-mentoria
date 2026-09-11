/**
 * Types públicos do módulo ai-agent (scaffold genérico de auto-reply).
 *
 * `AgentConfig`         — shape enxuto que o prompt/service consomem em runtime.
 * `BuildPromptInput`    — entrada de `buildAgentPrompt`.
 * `AgentResponse`       — saída de `generateReplyForLead`.
 * `AiAgentConfigPublic` — shape que a API admin retorna pra UI.
 * `AiAgentConfigInput`  — shape aceito pelo PUT (patch parcial — tudo opcional).
 *
 * Single-tenant: a config é uma única row (sem unitId). Nenhum campo de
 * domínio (catálogo, PIX, reserva, cortesia, RAG) — isto é um scaffold.
 */
import type {
  TransferRule,
  FollowupRule,
  ChannelKeywordRule,
} from '@/lib/db/schema/ai-agent-config';
import type { Message } from '@/modules/messages/types';

export type { TransferRule, FollowupRule, ChannelKeywordRule };

export type AiAgentTone = 'formal' | 'friendly' | 'casual';

/** Janela de horário de operação (informativo no prompt). */
export interface OperationHours {
  start: string;
  end: string;
  /** Dias da semana (0=domingo … 6=sábado). */
  days: number[];
}

/**
 * Config reduzida ao que o construtor de prompt precisa. O service adapta a
 * `AiAgentConfigRow` pra este shape antes de montar o prompt.
 */
export interface AgentConfig {
  /** System prompt custom. Se vazio/curto, o service monta um template. */
  systemPrompt?: string | null;
  agentName?: string | null;
  personality?: string | null;
  tone?: AiAgentTone | string | null;
  useEmojis?: boolean;
  /** Apenas as regras de transferência habilitadas, já reduzidas a labels. */
  transferRules?: string[];
  operationHoursText?: string | null;
  operationHours?: OperationHours | null;
}

export interface BuildPromptInput {
  config: AgentConfig;
  /** Histórico recente do lead (mais antiga primeiro). */
  history: Message[];
  /** Mensagem atual do lead (já sanitizada pelo caller). */
  userMessage: string;
  /** Nome do negócio (default genérico se omitido). */
  businessName?: string;
  /** Nome do lead, se conhecido — pra abertura personalizada. */
  leadName?: string | null;
  /** Contexto de data, ex: "hoje é segunda-feira, 27/07/2026". */
  todayContext?: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

/** Resposta gerada pelo agente pra uma mensagem do lead. */
export interface AgentResponse {
  /** Texto pra enviar ao cliente ('' quando calado ou só transferência). */
  reply: string;
  /** True quando a IA decidiu passar pro atendente humano. */
  transferred: boolean;
  /** True em erro estrutural (sem credenciais LLM, etc). */
  fallback: boolean;
}

/** Shape exposto à UI (cliente). Só campos genéricos. */
export interface AiAgentConfigPublic {
  id: string;
  enabled: boolean;

  systemPrompt: string | null;
  /** Prompt do Suporte IA (assistente dos atendentes). Null = template default. */
  supportSystemPrompt: string | null;
  temperature: number; // 0–100 (representa 0.0–1.0)
  maxMessagesBeforeHandoff: number;

  agentName: string;
  personality: string | null;
  tone: AiAgentTone;
  useEmojis: boolean;

  welcomeMessage: string | null;
  transferMessage: string;

  /** Segundos que a IA aguarda SEM resposta humana antes de assumir. */
  idleSecondsBeforeAi: number;
  idleMinutesUser: number;

  /** Velocidade do presence "digitando..." em ms por caractere (default 35). */
  typingMsPerChar: number;

  blockSendEnabled: boolean;
  blockSendDelaySec: number;

  followups: FollowupRule[];
  channelKeywords: ChannelKeywordRule[];
  transferRules: TransferRule[];

  operationHoursText: string | null;
  operationHours: OperationHours | null;

  /** Quando setado e > now, IA fica em pausa de emergência. */
  pausedUntil: Date | null;
  /** Minutos que a IA cala após msg humana. Cada msg renova o timer. */
  aiPauseMinutesAfterHuman: number;
  /** Minutos que a IA cala após trigger de cancelamento/desengajamento. */
  aiPauseMinutesAfterCancellation: number;

  updatedAt: Date;
}

/** Shape aceito pelo PUT da API admin. Patch parcial — tudo opcional. */
export interface AiAgentConfigInput {
  enabled?: boolean;
  systemPrompt?: string | null;
  supportSystemPrompt?: string | null;
  temperature?: number;
  maxMessagesBeforeHandoff?: number;

  agentName?: string;
  personality?: string | null;
  tone?: AiAgentTone;
  useEmojis?: boolean;

  welcomeMessage?: string | null;
  transferMessage?: string;

  idleSecondsBeforeAi?: number;
  idleMinutesUser?: number;

  typingMsPerChar?: number;

  blockSendEnabled?: boolean;
  blockSendDelaySec?: number;

  followups?: FollowupRule[];
  channelKeywords?: ChannelKeywordRule[];
  transferRules?: TransferRule[];

  operationHoursText?: string | null;
  operationHours?: OperationHours | null;

  /** Passa Date pra ativar pausa de emergência, null pra desativar. */
  pausedUntil?: Date | null;
  aiPauseMinutesAfterHuman?: number;
  aiPauseMinutesAfterCancellation?: number;
}
