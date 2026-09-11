import type { LeadStatus } from '../leads/types';

export interface PipelineConfig {
  id: string;
  newToPriorityMinutes: number;
  priorityToUrgencyMinutes: number;
  notifyOnEscalation: boolean;
}

export interface EscalationJob {
  leadId: string;
  fromStatus: LeadStatus;
  toStatus: LeadStatus;
  triggeredAt: Date;
}

export interface PipelineColumn {
  status: LeadStatus;
  label: string;
  count: number;
}

/** Os cinco estados que o quadro sabe desenhar (`lost` não tem coluna). */
export type StageStatus = 'new' | 'priority' | 'urgency' | 'attending' | 'converted';

/**
 * Uma coluna do quadro, exatamente como a API devolve.
 *
 * Vive aqui, e não em `modules/pipeline/stages.ts`, porque a tela do CRM é
 * client component e não pode importar do módulo que fala com o banco.
 *
 * **Os nove campos importam.** O PUT de `/api/admin/pipeline-stages` grava a
 * lista INTEIRA, e `replaceStages` faz `escalateAfterMinutes: s.… ?? null`.
 * Quem devolver a coluna sem esses dois campos apaga a escalação de todo mundo
 * ao salvar — foi o que aconteceria ao reordenar pelo board com o tipo antigo,
 * que só tinha sete.
 */
export interface StageColumn {
  id: string;
  status: StageStatus;
  /** Criada pelo cliente? Define de onde vêm os cards dela, e se pode ser apagada. */
  isCustom: boolean;
  label: string;
  color: string;
  position: number;
  visible: boolean;
  /** Minutos parado até sair sozinho. `null` = a coluna não escala. */
  escalateAfterMinutes: number | null;
  /** Para onde o card vai quando o tempo estoura. */
  escalateToStageId: string | null;
}

/**
 * Como o quadro se desenha antes de a configuração chegar (e se ela falhar).
 *
 * As cores são as do `TONE` do board, não as do schema: este é o fallback
 * VISUAL da tela, e piscar numa paleta para trocar por outra um instante
 * depois seria pior que manter a de sempre. O id `padrao:` não existe no banco
 * de propósito — ver o comentário em `stages.ts`.
 */
export const STAGES_PADRAO: StageColumn[] = [
  { id: 'padrao:new', status: 'new', isCustom: false, label: 'Novos', color: '#00d492', position: 0, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
  { id: 'padrao:priority', status: 'priority', isCustom: false, label: 'Prioridade', color: '#d99d00', position: 1, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
  { id: 'padrao:urgency', status: 'urgency', isCustom: false, label: 'Urgência', color: '#ff6060', position: 2, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
  { id: 'padrao:attending', status: 'attending', isCustom: false, label: 'Respondidos', color: '#94A3B8', position: 3, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
  { id: 'padrao:converted', status: 'converted', isCustom: false, label: 'Convertidos', color: '#22D3EE', position: 4, visible: true, escalateAfterMinutes: null, escalateToStageId: null },
];

/** As etapas base que uma coluna nova pode ancorar, com o nome de fábrica. */
export const ETAPAS_BASE: Array<{ status: StageStatus; label: string }> = [
  { status: 'new', label: 'Novos' },
  { status: 'priority', label: 'Prioridade' },
  { status: 'urgency', label: 'Urgência' },
  { status: 'attending', label: 'Respondidos' },
  { status: 'converted', label: 'Convertidos' },
];
