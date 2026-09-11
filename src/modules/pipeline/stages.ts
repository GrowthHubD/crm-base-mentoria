/**
 * Colunas do kanban: as cinco de fábrica e as que o cliente cria.
 *
 * O desenho em uma frase: **a coluna customizada é uma vista, o status continua
 * sendo a regra**. Uma coluna "Proposta enviada" ancorada em `attending` mostra
 * cards que, para o sistema, seguem sendo leads respondidos — escalam igual,
 * contam igual no dashboard, obedecem o mesmo SLA. O que muda é só onde o card
 * aparece no quadro.
 *
 * É isso que permite criar coluna sem responder as perguntas que um estado novo
 * exigiria (quando entra? escala para onde? conta como convertido?), e sem
 * migrar o enum `lead_status` nas sete instalações.
 *
 * Regra que atravessa o arquivo: **tabela vazia = comportamento de hoje**. Uma
 * instalação que nunca abriu a configuração precisa ver o quadro de sempre, por
 * isso toda leitura cai nos padrões em vez de devolver lista vazia — que
 * apareceria como kanban sem colunas e leads "sumidos".
 */
import { db } from '@/lib/db/client';
import {
  pipelineStages,
  PIPELINE_STAGES_PADRAO,
  STATUS_COM_COLUNA,
} from '@/lib/db/schema/pipeline-stages';
import { leads } from '@/lib/db/schema/leads';
import { asc, eq, and } from 'drizzle-orm';
import { logger } from '@/lib/logger';

/** Só os estados que o kanban sabe desenhar — ver `STATUS_COM_COLUNA`. */
export type LeadStatus = (typeof STATUS_COM_COLUNA)[number];

/**
 * Em qual coluna um lead recém-criado entra.
 *
 * A primeira coluna VISÍVEL e personalizada ancorada em `new`. Existe porque um
 * lead nasce com `stage_id` nulo e, nesse caso, o quadro o desenha na coluna de
 * FÁBRICA do status dele — que numa instalação com funil próprio está
 * escondida. O lead ficaria no banco com o status certo e invisível para quem
 * atende.
 *
 * `null` é resposta legítima e comum: instalação que usa as colunas de fábrica
 * não precisa de stage nenhum, e elas estão à vista.
 */
export async function colunaDeEntrada(): Promise<string | null> {
  try {
    const [coluna] = await db
      .select({ id: pipelineStages.id })
      .from(pipelineStages)
      .where(
        and(
          eq(pipelineStages.status, 'new'),
          eq(pipelineStages.visible, true),
          eq(pipelineStages.isCustom, true)
        )
      )
      .orderBy(asc(pipelineStages.position))
      .limit(1);
    return coluna?.id ?? null;
  } catch (err) {
    // Falhar aqui não pode impedir o lead de existir: sem stage ele ainda
    // aparece pelo desempate do quadro, e um card no lugar errado é melhor que
    // um lead que não entra.
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[stages] não consegui ler a coluna de entrada'
    );
    return null;
  }
}

export interface StageView {
  id: string;
  status: LeadStatus;
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

/** Hex de 6 dígitos. Cor inválida viraria estilo quebrado na tela do cliente. */
const HEX = /^#[0-9a-fA-F]{6}$/;

const STATUS_VALIDOS: readonly LeadStatus[] = STATUS_COM_COLUNA;

export class StageValidationError extends Error {}

/**
 * Padrões com id sintético.
 *
 * Só aparecem quando a tabela está vazia ou a consulta falhou. O id `padrao:`
 * não existe no banco de propósito: se a tela tentar salvar em cima dele, o
 * update não encontra linha e nada é corrompido — melhor que inventar um uuid
 * que passaria a existir sem seed.
 */
function padroes(): StageView[] {
  return PIPELINE_STAGES_PADRAO.map((s) => ({
    ...s,
    id: `padrao:${s.status}`,
    isCustom: false,
    escalateAfterMinutes: null,
    escalateToStageId: null,
  }));
}

const COLUNAS = {
  id: pipelineStages.id,
  status: pipelineStages.status,
  isCustom: pipelineStages.isCustom,
  label: pipelineStages.label,
  color: pipelineStages.color,
  position: pipelineStages.position,
  visible: pipelineStages.visible,
  escalateAfterMinutes: pipelineStages.escalateAfterMinutes,
  escalateToStageId: pipelineStages.escalateToStageId,
} as const;

export async function listStages(): Promise<StageView[]> {
  try {
    const rows = (await db
      .select(COLUNAS)
      .from(pipelineStages)
      .orderBy(asc(pipelineStages.position))) as StageView[];

    if (rows.length === 0) return padroes();

    // Estado de fábrica sem linha (schema novo, config antiga) entra com o
    // padrão, invisível: aparecer sozinho no quadro de alguém seria pior que
    // faltar.
    const comPadrao = new Set(rows.filter((r) => !r.isCustom).map((r) => r.status));
    const faltantes = padroes()
      .filter((p) => !comPadrao.has(p.status))
      .map((p) => ({ ...p, visible: false }));

    return [...rows, ...faltantes].sort((a, b) => a.position - b.position);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err },
      '[pipeline] não consegui ler pipeline_stages — usando os padrões'
    );
    return padroes();
  }
}

/** Só as visíveis, que é o que o quadro desenha. */
export async function listVisibleStages(): Promise<StageView[]> {
  return (await listStages()).filter((s) => s.visible);
}

export interface StageInput {
  id: string;
  label: string;
  color: string;
  position: number;
  visible: boolean;
  /** `null`/ausente = não escala. */
  escalateAfterMinutes?: number | null;
  escalateToStageId?: string | null;
}

/**
 * Valida e normaliza o que veio da tela. Pura de propósito: é onde mora a regra
 * que protege o cliente de salvar uma configuração que quebraria o quadro, e
 * regra assim precisa de teste — o que exigiria banco se estivesse embutida no
 * `replaceStages`.
 *
 * Recebe também o estado atual (`existentes`) porque parte da validação é
 * relacional: não dá para saber se sobrou coluna visível olhando só o patch.
 */
export function validarStages(input: StageInput[], existentes: StageView[]): StageInput[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new StageValidationError('Envie a lista completa de colunas.');
  }

  const porId = new Map(existentes.map((s) => [s.id, s]));
  const vistos = new Set<string>();

  const limpo = input.map((s, i) => {
    if (!porId.has(s.id)) {
      throw new StageValidationError(`Coluna desconhecida: "${s.id}".`);
    }
    if (vistos.has(s.id)) {
      throw new StageValidationError('A mesma coluna apareceu duas vezes.');
    }
    vistos.add(s.id);

    const label = String(s.label ?? '').trim();
    if (!label) throw new StageValidationError('Toda coluna precisa de um nome.');
    if (label.length > 40) throw new StageValidationError(`Nome muito longo: "${label}".`);

    const color = String(s.color ?? '').trim();
    if (!HEX.test(color)) {
      throw new StageValidationError(`Cor inválida em "${label}" — use #RRGGBB.`);
    }

    // Escalação: tempo E destino andam juntos. Um sem o outro é configuração
    // pela metade — tempo sem destino não teria para onde mover, e destino sem
    // tempo nunca dispararia. Nos dois casos guardamos `null` nos dois campos,
    // que é o mesmo que "esta coluna não escala".
    const min = s.escalateAfterMinutes;
    const temTempo = typeof min === 'number' && Number.isFinite(min) && min > 0;
    const destino = typeof s.escalateToStageId === 'string' ? s.escalateToStageId : null;

    if (temTempo && !destino) {
      throw new StageValidationError(`"${label}" tem tempo de escalação mas não diz para onde vai.`);
    }
    if (temTempo && destino === s.id) {
      throw new StageValidationError(`"${label}" não pode escalar para ela mesma.`);
    }
    if (temTempo && destino && !porId.has(destino)) {
      throw new StageValidationError(`Destino de escalação de "${label}" não existe.`);
    }
    if (temTempo && (min as number) > 60 * 24 * 30) {
      throw new StageValidationError(`Tempo de escalação de "${label}" é longo demais.`);
    }

    return {
      id: s.id,
      label,
      color,
      position: Number.isFinite(s.position) ? Number(s.position) : i,
      visible: Boolean(s.visible),
      escalateAfterMinutes: temTempo ? Math.round(min as number) : null,
      escalateToStageId: temTempo ? destino : null,
    };
  });

  // Um quadro sem nenhuma coluna visível é uma tela em branco sem explicação.
  if (!limpo.some((s) => s.visible)) {
    throw new StageValidationError('Pelo menos uma coluna precisa ficar visível.');
  }

  return limpo;
}

/**
 * Salva o quadro inteiro de uma vez.
 *
 * Recebe a lista completa e não um patch por coluna porque posição é relativa:
 * gravar uma por uma produziria estados intermediários com duas na mesma
 * posição. Como é tudo ou nada, roda em transação.
 */
export async function replaceStages(input: StageInput[]): Promise<StageView[]> {
  // Instalação que nunca abriu a configuração tem a tabela vazia, e aí
  // `listStages` devolve os padrões com id sintético `padrao:`. A validação
  // passa (os ids "existem" na lista), mas o UPDATE não casa linha nenhuma e o
  // salvamento falha em silêncio — a tela mostra a ordem nova e o próximo F5
  // volta tudo. Materializar as cinco antes resolve na origem.
  await seedStagesIfEmpty();
  const atuais = await listStages();

  // A tela que carregou ANTES do seed guardou os ids sintéticos. Agora eles têm
  // linha de verdade, e traduzir aqui é a diferença entre a pessoa reordenar o
  // quadro e receber "Coluna desconhecida" por um detalhe que não é dela.
  const traduzido = input.map((s) => {
    if (typeof s?.id !== 'string' || !s.id.startsWith('padrao:')) return s;
    const status = s.id.slice('padrao:'.length);
    const real = atuais.find((a) => !a.isCustom && a.status === status);
    return real ? { ...s, id: real.id } : s;
  });

  const limpo = validarStages(traduzido, atuais);

  await db.transaction(async (tx) => {
    for (const s of limpo) {
      await tx
        .update(pipelineStages)
        .set({
          label: s.label,
          color: s.color,
          position: s.position,
          visible: s.visible,
          escalateAfterMinutes: s.escalateAfterMinutes ?? null,
          escalateToStageId: s.escalateToStageId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(pipelineStages.id, s.id));
    }
  });

  return listStages();
}

export interface NewStageInput {
  label: string;
  color: string;
  /** Estado âncora — de qual fila os cards desta coluna saem. */
  baseStatus: string;
}

/**
 * Teto de colunas personalizadas.
 *
 * Era 10 e subiu para 24: funil de prospecção real passa de 15 etapas
 * (prospect, cadências, reunião, repescagem...). O teto existe para o quadro
 * não virar uma faixa infinita de rolagem, não para limitar o funil de ninguém.
 */
const MAX_CUSTOM = 24;

export async function createCustomStage(input: NewStageInput): Promise<StageView> {
  const label = String(input.label ?? '').trim();
  if (!label) throw new StageValidationError('Dê um nome para a coluna.');
  if (label.length > 40) throw new StageValidationError('Nome muito longo (máx. 40).');

  const color = String(input.color ?? '').trim();
  if (!HEX.test(color)) throw new StageValidationError('Escolha uma cor válida.');

  if (!STATUS_VALIDOS.includes(input.baseStatus as LeadStatus)) {
    throw new StageValidationError(
      `Etapa base inválida: "${input.baseStatus}". Use uma das cinco de fábrica.`
    );
  }

  // Com a tabela vazia, esta linha seria a ÚNICA — e `listStages` passaria a
  // devolver as cinco de fábrica pelo bloco `faltantes`, todas invisíveis.
  // Criar a primeira coluna sumiria com Novos, Prioridade e Urgência do quadro
  // de quem nunca abriu a configuração. Semear antes é idempotente e barato.
  await seedStagesIfEmpty();

  const atuais = await listStages();
  if (atuais.filter((s) => s.isCustom).length >= MAX_CUSTOM) {
    throw new StageValidationError(`Limite de ${MAX_CUSTOM} colunas personalizadas atingido.`);
  }

  const [row] = await db
    .insert(pipelineStages)
    .values({
      status: input.baseStatus as LeadStatus,
      isCustom: true,
      label,
      color,
      // Entra no fim do quadro; o cliente reordena com as setas se quiser.
      position: Math.max(0, ...atuais.map((s) => s.position)) + 1,
      visible: true,
    })
    .returning(COLUNAS);

  logger.info({ id: row.id, label, base: input.baseStatus }, '[pipeline] coluna criada');
  return row as StageView;
}

/**
 * Remove uma coluna criada pelo cliente.
 *
 * Os cards NÃO são apagados: o `stage_id` deles é zerado ANTES da remoção, e
 * eles voltam para a coluna de fábrica do status em que já estavam. Fazer na
 * ordem inversa deixaria cards apontando para uma coluna inexistente, que é
 * lead invisível no quadro — o pior sintoma possível num CRM.
 */
export async function deleteCustomStage(id: string): Promise<{ leadsMovidos: number }> {
  const [alvo] = await db
    .select(COLUNAS)
    .from(pipelineStages)
    .where(eq(pipelineStages.id, id))
    .limit(1);

  if (!alvo) throw new StageValidationError('Coluna não encontrada.');
  if (!alvo.isCustom) {
    throw new StageValidationError(
      'As cinco colunas de fábrica não podem ser apagadas — use o olho para escondê-las.'
    );
  }

  let leadsMovidos = 0;
  await db.transaction(async (tx) => {
    const devolvidos = await tx
      .update(leads)
      .set({ stageId: null })
      .where(eq(leads.stageId, id))
      .returning({ id: leads.id });
    leadsMovidos = devolvidos.length;

    await tx.delete(pipelineStages).where(eq(pipelineStages.id, id));
  });

  logger.info({ id, label: alvo.label, leadsMovidos }, '[pipeline] coluna removida');
  return { leadsMovidos };
}

/**
 * Volta as colunas de fábrica ao original.
 *
 * NÃO apaga as customizadas: quem clica em "restaurar padrão" quer desfazer o
 * que mexeu nas cinco, não perder as colunas que criou — e perder trabalho por
 * causa de um botão de restaurar é o tipo de surpresa que não se desfaz.
 */
export async function resetStages(): Promise<StageView[]> {
  await db.transaction(async (tx) => {
    for (const s of PIPELINE_STAGES_PADRAO) {
      await tx
        .update(pipelineStages)
        .set({ label: s.label, color: s.color, position: s.position, visible: s.visible, updatedAt: new Date() })
        .where(and(eq(pipelineStages.status, s.status), eq(pipelineStages.isCustom, false)));
    }
  });
  return listStages();
}

/** Semeia os padrões só se ainda não houver nada (idempotente). */
export async function seedStagesIfEmpty(): Promise<void> {
  const [row] = await db.select({ id: pipelineStages.id }).from(pipelineStages).limit(1);
  if (row) return;
  await db
    .insert(pipelineStages)
    .values(PIPELINE_STAGES_PADRAO.map((s) => ({ ...s, isCustom: false })))
    .onConflictDoNothing();
}
