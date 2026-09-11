/**
 * Queries do módulo ai-agent — single-tenant (uma única row de config).
 *
 * `getConfigRow()`     lê a única row (ou null).
 * `getOrInitConfig()`  lê ou cria a row com defaults sensatos.
 * `getAgentName()`     nome configurado pra IA (default 'Assistente').
 */
import { db } from '@/lib/db/client';
import {
  aiAgentConfig,
  type AiAgentConfigRow,
  type TransferRule,
  type FollowupRule,
} from '@/lib/db/schema/ai-agent-config';
import { logger } from '@/lib/logger';

/** Regras de transferência default (genéricas). */
const DEFAULT_TRANSFER_RULES: TransferRule[] = [
  { key: 'insatisfacao', label: 'Cliente demonstra insatisfação ou irritação', description: 'Detecta tom frustrado, reclamação ou pedido de cancelamento.', enabled: true },
  { key: 'atendente', label: 'Cliente pede pra falar com uma pessoa/atendente', description: 'Palavras como "atendente", "humano", "pessoa real", "falar com alguém".', enabled: true },
  { key: 'complexa', label: 'Pergunta que você não consegue responder com segurança', description: 'Quando falta informação pra responder sem inventar.', enabled: true },
];

/** Follow-ups default (diretrizes — a IA escreve o texto na hora). */
const DEFAULT_FOLLOWUPS: FollowupRule[] = [
  { enabled: true, afterMinutes: 5, instruction: 'Lembrete leve — pergunte se ainda posso ajudar em algo.' },
  { enabled: true, afterMinutes: 15, instruction: 'Ofereça ajuda pra tirar dúvidas que possam estar travando a decisão.' },
  { enabled: false, afterMinutes: 30, instruction: 'Último contato — deixe claro que ficamos à disposição quando precisar.' },
  { enabled: false, afterMinutes: 60, instruction: 'Encerramento cordial — a conversa fica aberta pra quando quiser voltar.' },
];

/**
 * Lê a única row de config. Retorna null se ainda não existir.
 */
export async function getConfigRow(): Promise<AiAgentConfigRow | null> {
  const [row] = await db.select().from(aiAgentConfig).limit(1);
  return row ?? null;
}

/**
 * Nome da IA configurado — usado pra assinar mensagens enviadas pelo agente.
 * Cai em 'Assistente' se não existe config ou agentName não foi customizado.
 */
export async function getAgentName(): Promise<string> {
  const row = await getConfigRow();
  const name = row?.agentName?.trim();
  return name && name.length > 0 ? name : 'Assistente';
}

/**
 * Como `getConfigRow`, mas se vazia INSERE a row default e retorna ela.
 */
export async function getOrInitConfig(): Promise<AiAgentConfigRow> {
  const existing = await getConfigRow();
  if (existing) return existing;

  logger.info({}, '[ai-agent] inicializando ai_agent_config com defaults');
  const [created] = await db
    .insert(aiAgentConfig)
    .values({
      enabled: false,
      transferRules: DEFAULT_TRANSFER_RULES,
      followups: DEFAULT_FOLLOWUPS,
    })
    .returning();
  if (created) return created;

  // Fallback defensivo (não deveria acontecer sem conflito de chave).
  const winner = await getConfigRow();
  if (!winner) {
    throw new Error('[ai-agent] getOrInitConfig: insert sem retorno e SELECT vazio');
  }
  return winner;
}
