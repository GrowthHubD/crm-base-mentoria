/**
 * Escalação por tempo — genérica, dirigida pela configuração das colunas.
 *
 * Antes, escalar era privilégio de duas transições escritas no código:
 * `new → priority` e `priority → urgency`, com os minutos vindo de
 * `pipeline_config`. Funil de três colunas cabia; dez colunas, sete delas com
 * tempo, não cabiam de jeito nenhum.
 *
 * Agora cada coluna diz por si: "depois de N minutos parado, mande o card para
 * a coluna X". Quem não diz nada não escala — que é o padrão e é o que faz uma
 * coluna como "Proposta enviada" ficar quieta esperando alguém falar.
 *
 * O relógio é o `lastMessageAt`, o mesmo de antes: conta desde a última
 * mensagem, não desde a entrada na coluna. É o que o produto sempre mediu —
 * "tempo sem contato" — e mudar isso alteraria silenciosamente o SLA de sete
 * instalações.
 */
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { pipelineStages } from '@/lib/db/schema/pipeline-stages';
import { and, eq, lt, isNull, isNotNull, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';

export interface RegraEscalacao {
  deStageId: string;
  deLabel: string;
  deStatus: string;
  /** `true` quando é coluna de fábrica: o card lá está com `stage_id` nulo. */
  deEhPadrao: boolean;
  minutos: number;
  paraStageId: string;
  paraLabel: string;
  paraStatus: string;
  paraEhPadrao: boolean;
}

/**
 * As regras válidas, já resolvidas.
 *
 * Descarta configuração incompleta (tempo sem destino, destino que não existe)
 * e a auto-escalação (coluna que aponta para si mesma), que criaria um card
 * "escalando" para o mesmo lugar a cada passada do cron, para sempre.
 */
export async function listarRegras(): Promise<RegraEscalacao[]> {
  const cols = await db
    .select({
      id: pipelineStages.id,
      label: pipelineStages.label,
      status: pipelineStages.status,
      isCustom: pipelineStages.isCustom,
      minutos: pipelineStages.escalateAfterMinutes,
      para: pipelineStages.escalateToStageId,
    })
    .from(pipelineStages);

  const porId = new Map(cols.map((c) => [c.id, c]));

  const regras: RegraEscalacao[] = [];
  for (const c of cols) {
    if (!c.minutos || c.minutos <= 0 || !c.para) continue;
    if (c.para === c.id) {
      logger.warn({ coluna: c.label }, '[escalação] coluna aponta para si mesma — ignorada');
      continue;
    }
    const destino = porId.get(c.para);
    if (!destino) {
      logger.warn(
        { coluna: c.label, destino: c.para },
        '[escalação] destino não existe mais — regra ignorada'
      );
      continue;
    }
    regras.push({
      deStageId: c.id,
      deLabel: c.label,
      deStatus: c.status,
      deEhPadrao: !c.isCustom,
      minutos: c.minutos,
      paraStageId: destino.id,
      paraLabel: destino.label,
      paraStatus: destino.status,
      paraEhPadrao: !destino.isCustom,
    });
  }
  return regras;
}

export interface ResultadoEscalacao {
  regras: number;
  movidos: number;
  detalhes: Array<{ de: string; para: string; leads: number }>;
}

/**
 * Aplica todas as regras. Devolve o que moveu, para o log do cron.
 *
 * Cada regra é um UPDATE só — não há laço por lead. Com o cron rodando de
 * minuto em minuto e o funil podendo ter dez colunas, buscar e atualizar um a
 * um seria uma rajada de consultas por passada.
 */
export async function escalarPorTempo(): Promise<ResultadoEscalacao> {
  const regras = await listarRegras();
  const r: ResultadoEscalacao = { regras: regras.length, movidos: 0, detalhes: [] };
  if (regras.length === 0) return r;

  const agora = Date.now();

  for (const regra of regras) {
    const corte = new Date(agora - regra.minutos * 60_000);

    // Quem está na coluna de ORIGEM. Coluna de fábrica = status batendo e
    // `stage_id` nulo (o card não foi levado para nenhuma personalizada);
    // coluna personalizada = `stage_id` apontando para ela.
    const naOrigem = regra.deEhPadrao
      ? and(eq(leads.status, regra.deStatus as 'new'), isNull(leads.stageId))
      : eq(leads.stageId, regra.deStageId);

    const movidos = await db
      .update(leads)
      .set({
        status: regra.paraStatus as 'new',
        // Coluna de fábrica não usa `stage_id`; personalizada, sim.
        stageId: regra.paraEhPadrao ? null : regra.paraStageId,
        statusChangedAt: new Date(),
        updatedAt: new Date(),
        // Mantém o contador histórico de escalações do lead.
        escalationLevel: sql`${leads.escalationLevel} + 1`,
      })
      .where(and(naOrigem, isNotNull(leads.lastMessageAt), lt(leads.lastMessageAt, corte)))
      .returning({ id: leads.id });

    if (movidos.length > 0) {
      r.movidos += movidos.length;
      r.detalhes.push({ de: regra.deLabel, para: regra.paraLabel, leads: movidos.length });
    }
  }

  if (r.movidos > 0) {
    logger.info({ ...r }, '[escalação] cards movidos por tempo');
  }
  return r;
}
