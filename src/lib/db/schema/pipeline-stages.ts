/**
 * Aparência e ordem das colunas do kanban, por instalação.
 *
 * Por que uma tabela e não constantes no código: cada cliente chama as etapas
 * do funil pelo nome que usa na operação. Obrigar todo mundo a viver com
 * "Novos / Prioridade / Urgência" é impor o vocabulário de um cliente aos
 * outros — e trocar isso no código significaria um fork por cliente, que é
 * exatamente o que o isolamento por deploy existe para evitar.
 *
 * O que esta tabela NÃO faz, e é importante entender: ela não cria estados
 * novos de lead. O `status` continua sendo o enum `lead_status` do Postgres,
 * porque é dele que dependem a escalação por tempo, os índices e toda a regra
 * de negócio. O que muda é como cada estado se APRESENTA: nome, cor, posição e
 * se aparece no quadro.
 *
 * Na prática o cliente pode: renomear "Novos" para "Entrada", pintar cada
 * coluna, reordenar o quadro e esconder as colunas que não usa — o que dá de 1
 * a 6 colunas visíveis. O que ele não pode é inventar um sétimo estado, porque
 * um estado novo precisa de regra nova (quando entra, quando sai, o que escala
 * para onde) e isso não é aparência.
 */
import { pgTable, text, integer, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { leadStatusEnum } from './leads';

export const pipelineStages = pgTable(
  'pipeline_stages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),

    /**
     * O estado real do lead — a ponte com a regra de negócio.
     *
     * Nas colunas customizadas ele vira o estado ÂNCORA: um lead em "Proposta
     * enviada" ancorada em `attending` continua sendo, para o sistema, um lead
     * respondido. É o que permite criar coluna sem inventar regra de escalação,
     * de SLA e de conversão para ela.
     */
    status: leadStatusEnum('status').notNull(),

    /**
     * Coluna criada pelo cliente?
     *
     * As cinco de fábrica são `false` e não podem ser apagadas — apagá-las
     * deixaria leads sem lugar no quadro, já que todo lead tem um `status` e
     * nem todo lead tem `stage_id`.
     */
    isCustom: boolean('is_custom').notNull().default(false),

    /** Nome exibido na coluna. */
    label: text('label').notNull(),

    /** Cor da coluna em hex (`#RRGGBB`). */
    color: text('color').notNull().default('#8B8B94'),

    /** Ordem no quadro, da esquerda para a direita. */
    position: integer('position').notNull().default(0),

    /**
     * Minutos sem movimento até o card sair sozinho desta coluna.
     *
     * `null` = a coluna NÃO escala — o card fica até alguém mexer ou até o
     * cliente/atendente falar. É o comportamento de uma coluna como "Proposta
     * enviada", e é o padrão de toda coluna criada: escalar por tempo é decisão
     * de quem monta o funil, não efeito colateral de criar uma coluna.
     *
     * Antes disto, escalar por tempo era privilégio de duas transições fixas no
     * código (`new→priority`, `priority→urgency`). Agora é propriedade de
     * qualquer coluna — as de fábrica nasceram com os tempos que já estavam em
     * `pipeline_config`, então nada mudou para quem já usava.
     */
    escalateAfterMinutes: integer('escalate_after_minutes'),

    /**
     * Para qual coluna o card vai quando o tempo estoura.
     *
     * `null` com `escalateAfterMinutes` preenchido é configuração incompleta e
     * a escalação a ignora — melhor não mover do que mover para lugar nenhum.
     */
    escalateToStageId: text('escalate_to_stage_id'),

    /**
     * Coluna aparece no kanban?
     *
     * Esconder NÃO apaga nem move lead nenhum: o lead continua no status dele e
     * volta a aparecer quando a coluna for reativada. Some da vista, não do
     * banco — é o que evita "sumiram meus leads" depois de mexer na config.
     */
    visible: boolean('visible').notNull().default(true),

    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => ({
    // UMA coluna de fábrica por estado — mas quantas customizadas o cliente
    // quiser ancoradas no mesmo estado. Sem o `where`, criar a segunda coluna
    // ancorada em `attending` esbarraria no índice; sem o índice, dois
    // registros de fábrica para `new` fariam o lead aparecer duas vezes.
    statusPadraoUnico: uniqueIndex('pipeline_stages_status_uq')
      .on(t.status)
      .where(sql`${t.isCustom} = false`),
  })
);

/**
 * Como o quadro nasce: exatamente igual ao que está no ar hoje.
 *
 * Isto é o que permite ligar a personalização sem ninguém perceber diferença.
 *
 * `lost` fica DE FORA de propósito, embora exista no enum: o kanban não tem
 * consulta para ele — as colunas são montadas por queries específicas, e não
 * há uma de perdidos. Oferecê-lo na configuração entregaria uma coluna que
 * nunca mostra nada, e o cliente passaria a tarde procurando o erro dele.
 * Para o `lost` virar coluna de verdade é preciso primeiro dar uma query a ele.
 */
export const PIPELINE_STAGES_PADRAO = [
  { status: 'new' as const, label: 'Novos', color: '#9154FF', position: 0, visible: true },
  { status: 'priority' as const, label: 'Prioridade', color: '#F59E0B', position: 1, visible: true },
  { status: 'urgency' as const, label: 'Urgência', color: '#EF4444', position: 2, visible: true },
  { status: 'attending' as const, label: 'Respondidos', color: '#8B5CF6', position: 3, visible: true },
  { status: 'converted' as const, label: 'Convertidos', color: '#22C55E', position: 4, visible: true },
];

/** Os estados que o quadro sabe desenhar. É o que a configuração aceita. */
export const STATUS_COM_COLUNA = [
  'new',
  'priority',
  'urgency',
  'attending',
  'converted',
] as const;
