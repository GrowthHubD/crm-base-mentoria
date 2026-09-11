/**
 * Como os cards andam pelo quadro NESTA instalação.
 *
 * Há dois modelos, e eles são incompatíveis:
 *
 *   FILA (padrão) — o quadro é uma fila de atendimento. O card se move sozinho
 *     conforme a conversa: cliente escreve e o card vai para Novos, o atendente
 *     responde e ele vai para Respondidos, o tempo passa sem resposta e ele
 *     escala para Prioridade. Quem atende nunca arrasta nada; o quadro mostra
 *     quem está esperando há mais tempo. É o que os clientes de atendimento
 *     usam, e mexer nisso quebraria a operação deles.
 *
 *   ARRASTE — o quadro é um funil de vendas. A coluna diz em que ETAPA a
 *     negociação está ("Reunião agendada", "Decisor identificado"), e isso é
 *     julgamento do SDR, não consequência de quem falou por último. Aqui o card
 *     só muda de coluna quando alguém o arrasta. Um SDR que arrasta o card para
 *     "Reunião agendada" e em seguida manda um WhatsApp não pode ver o card
 *     voltar para "Respondidos" — a informação que ele acabou de registrar
 *     sumiria.
 *
 * Flag de ambiente e não coluna no banco porque um mesmo build atende todos os
 * Workers: é `vars` do environment no wrangler.jsonc, um deploy por cliente.
 * O status do lead continua mudando por baixo nos dois modos — ele alimenta
 * SLA, dashboard e relatório. O que o modo ARRASTE preserva é a COLUNA.
 */

/** Só o arraste move o card? Lido no servidor; no browser volta `false`. */
export function cardsSoPorArraste(): boolean {
  const v = process.env.FEATURE_KANBAN_MANUAL?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
