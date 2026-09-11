/**
 * Ordem das colunas do quadro — as contas, sem tela e sem banco.
 *
 * Existe separado porque reordenar pelo board não é "trocar dois itens de uma
 * lista": a faixa mostra um RECORTE do que está no banco (as três filas de
 * fábrica mais as personalizadas, só as visíveis), enquanto `position` vale
 * para o quadro inteiro — Respondidos, Convertidos e as colunas ocultas também
 * têm posição, e não aparecem ali.
 *
 * A propriedade que faz isso funcionar: a ordem da faixa é uma PROJEÇÃO da
 * ordem completa. Então mover A para o índice de B na lista completa produz,
 * na faixa, exatamente o movimento que o usuário viu — e preserva a posição
 * relativa de tudo que ele não está enxergando.
 *
 * Puro de propósito: é a regra que o arraste dispara a cada gesto, e regra
 * assim precisa de teste.
 */
import type { StageColumn } from './types';

/** O que o PUT de `/api/admin/pipeline-stages` aceita por coluna. */
export interface StagePutItem {
  id: string;
  label: string;
  color: string;
  position: number;
  visible: boolean;
  escalateAfterMinutes: number | null;
  escalateToStageId: string | null;
}

/**
 * As colunas que a faixa horizontal desenha, na ordem.
 *
 * As personalizadas entram qualquer que seja o status âncora — são colunas de
 * trabalho, onde o atendente larga o card. As de fábrica `attending` e
 * `converted` ficam de fora porque são listas de leitura, desenhadas embaixo do
 * quadro.
 */
export function colunasDaFaixa(todas: StageColumn[]): StageColumn[] {
  return todas
    .filter((s) => s.visible && (s.isCustom || s.status === 'new' || s.status === 'priority' || s.status === 'urgency'))
    .sort((a, b) => a.position - b.position);
}

/**
 * Põe a coluna `arrastadaId` no lugar da coluna `alvoId` e renumera o quadro.
 *
 * Renumera de 0 a n-1 em vez de tentar preservar os números antigos: posição
 * com buraco ou repetida é o que faz duas colunas empatarem e trocarem de lugar
 * sozinhas no próximo carregamento, e a ordenação do servidor é por `position`.
 *
 * Devolve a lista original quando não há o que fazer (id desconhecido, ou
 * soltar a coluna sobre ela mesma), para quem chama poder comparar por
 * referência e não salvar à toa.
 */
export function moverColuna(
  todas: StageColumn[],
  arrastadaId: string,
  alvoId: string
): StageColumn[] {
  const ordenadas = [...todas].sort((a, b) => a.position - b.position);
  const de = ordenadas.findIndex((s) => s.id === arrastadaId);
  const para = ordenadas.findIndex((s) => s.id === alvoId);
  if (de < 0 || para < 0 || de === para) return todas;

  const copia = [...ordenadas];
  const [movida] = copia.splice(de, 1);
  // Depois da remoção os índices à direita andaram um para trás, e é por isso
  // que inserir em `para` cai no lugar do alvo nos dois sentidos: arrastando
  // para a direita a coluna assume a posição do alvo e ele recua; para a
  // esquerda, o alvo avança. É o que o gesto promete.
  copia.splice(para, 0, movida);

  return copia.map((s, i) => ({ ...s, position: i }));
}

/**
 * Anda uma casa na FAIXA, não na lista completa.
 *
 * É o que as setas do menu usam. O vizinho é o vizinho visível do quadro: se
 * houver uma coluna oculta no meio, ela é pulada — do contrário a seta pareceria
 * não fazer nada, porque o movimento aconteceria num lugar que ninguém vê.
 */
export function moverVizinho(
  todas: StageColumn[],
  id: string,
  direcao: -1 | 1
): StageColumn[] {
  const faixa = colunasDaFaixa(todas);
  const i = faixa.findIndex((s) => s.id === id);
  if (i < 0) return todas;
  const alvo = faixa[i + direcao];
  if (!alvo) return todas;
  return moverColuna(todas, id, alvo.id);
}

/** Liga ou desliga uma coluna do quadro. Não move nem apaga lead nenhum. */
export function definirVisibilidade(
  todas: StageColumn[],
  id: string,
  visible: boolean
): StageColumn[] {
  return todas.map((s) => (s.id === id ? { ...s, visible } : s));
}

/**
 * Monta o corpo do PUT.
 *
 * Repassa `escalateAfterMinutes` e `escalateToStageId` como estão. Sem isso,
 * salvar a ORDEM apagaria a ESCALAÇÃO de todas as colunas — o PUT grava a lista
 * inteira e o que não vem no corpo vira `null`.
 */
export function paraPut(todas: StageColumn[]): StagePutItem[] {
  return todas.map((s) => ({
    id: s.id,
    label: s.label,
    color: s.color,
    position: s.position,
    visible: s.visible,
    escalateAfterMinutes: s.escalateAfterMinutes,
    escalateToStageId: s.escalateToStageId,
  }));
}
