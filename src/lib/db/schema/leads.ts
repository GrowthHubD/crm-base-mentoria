import { pgTable, text, timestamp, jsonb, pgEnum, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './users';
import { units } from './units';
import { connections } from './connections';

export const leadStatusEnum = pgEnum('lead_status', [
  'new',
  'priority',
  'urgency',
  'attending',
  'converted',
  'lost',
]);

/**
 * Enum compartilhado por DOIS campos com significados diferentes:
 *   - `channel`           = canal de CONVERSA. Só 'whatsapp' | 'manual' são
 *                           válidos aqui (não existe adapter de conversa por
 *                           Instagram ou Google). Ver `LeadChannel` em
 *                           modules/leads/types.
 *   - `attributedChannel` = ORIGEM comercial do lead. Aceita o enum inteiro:
 *                           anúncio no Instagram ou no Google que desagua no
 *                           WhatsApp é atribuído à origem, não ao canal.
 * O enum segue completo de propósito — restringi-lo quebraria a atribuição.
 */
export const leadChannelEnum = pgEnum('lead_channel', [
  'whatsapp',
  'instagram',
  'google',
  // Canal de CONVERSA de verdade, não só origem comercial: um lead de e-mail
  // troca mensagens por e-mail, e o composer do chat manda por lá. Entrou junto
  // com a integração do Gmail.
  'email',
  'manual',
]);

export const leads = pgTable('leads', {
  id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
  // Identificador do contato no canal (ex: 5511999999999 no WhatsApp)
  externalContactId: text('external_contact_id').notNull(),
  channel: leadChannelEnum('channel').notNull(),
  /** Filial dona deste lead. NULO = cliente que não usa unidades, ou lead que
   *  entrou antes de o módulo ser ligado — as consultas sem filtro continuam
   *  devolvendo esses, então ligar unidades não exige migrar dado. */
  unitId: text('unit_id').references(() => units.id),
  connectionId: text('connection_id').references(() => connections.id),
  // Dados do contato
  name: text('name'),
  phone: text('phone'),
  avatarUrl: text('avatar_url'),
  /** Anotações internas do time sobre o lead — combinados, contexto, histórico
   *  que não cabe na conversa. NUNCA sai pro cliente: não entra em prompt de
   *  IA nem em mensagem. É o bloco de notas do atendimento. */
  notes: text('notes'),
  /**
   * E-mail do contato — é por ele que a resposta dele encontra este lead.
   *
   * Não é um canal separado: o lead continua sendo o mesmo (do WhatsApp, na
   * maioria das vezes) e ganha um endereço. É o que permite conversar com a
   * mesma pessoa nos dois lugares sem rachar o histórico em dois cards.
   *
   * Preenchido quando alguém envia um e-mail para o contato pelo CRM, ou à mão
   * na ficha. Sem ele, um e-mail que chega não tem em qual lead cair — foi
   * exatamente o que aconteceu no primeiro teste de recebimento.
   */
  email: text('email'),
  /**
   * A QUEM este lead pertence — o BDR que conversa com ele.
   *
   * Herdado na criação: do dono da conexão por onde a mensagem entrou, ou do
   * dono da conta de e-mail que a recebeu. Coluna própria e não join com
   * `connections.owner_id` porque este filtro entra em TODA consulta do CRM —
   * kanban, busca, chat, dashboard. Um join a mais em cada uma custaria caro e,
   * pior, seria fácil esquecer em uma delas: a coluna aqui deixa o filtro
   * uniforme e auditável num `grep`.
   *
   * Distinto de `assignedToId`: atribuição é fluxo de trabalho (quem está
   * cuidando agora, muda o dia inteiro); dono é VISIBILIDADE (de quem é este
   * lead, quase nunca muda). Confundir os dois faria um lead sumir da tela do
   * BDR no instante em que alguém o atribuísse a outra pessoa.
   *
   * NULO = lead da casa, que só o admin enxerga. Fechado por omissão de novo:
   * um caminho de criação que esqueça de marcar o dono some da tela de um BDR,
   * o que é ruim — mas não vaza a conversa dele para os outros, o que é pior.
   */
  ownerId: text('owner_id'),
  // Pipeline
  status: leadStatusEnum('status').notNull().default('new'),
  /**
   * Coluna customizada em que o card está, quando há uma.
   *
   * `null` = o lead vive na coluna de fábrica do `status` dele, que é o
   * comportamento de todo lead antes desta funcionalidade e continua sendo o
   * de quem nunca criou coluna.
   *
   * Complementa o `status`, não o substitui: o status segue mandando na regra
   * (escalação por tempo, SLA, conversão) e o `stage_id` manda só em ONDE o
   * card aparece.
   *
   * SEM foreign key de propósito: `pipeline_stages` importa `leadStatusEnum`
   * daqui, e declarar a referência no sentido inverso fecharia um ciclo de
   * imports. A limpeza ao apagar uma coluna é feita explicitamente em
   * `modules/pipeline/stages.ts` — que zera o `stage_id` dos leads afetados
   * ANTES de remover a linha, para nenhum card ficar apontando para o vazio.
   */
  stageId: text('stage_id'),
  assignedToId: text('assigned_to_id').references(() => users.id),
  // Canal "atribuído" — fonte de marketing real do lead (Meta Ads vira Instagram,
  // anúncio Google vira Google etc.). Quando null, dashboard usa `channel` técnico.
  // Setado por keyword da IA (ai_agent_config.channelKeywords) ou manualmente.
  attributedChannel: leadChannelEnum('attributed_channel'),
  // Escalação automática
  escalationLevel: integer('escalation_level').notNull().default(0),
  lastMessageAt: timestamp('last_message_at'),
  // Última mensagem DO CLIENTE (direction=inbound). Alimenta o "tempo sem
  // resposta" no kanban — separado do lastMessageAt (que mistura inbound/outbound).
  lastInboundAt: timestamp('last_inbound_at'),
  // Última mensagem NOSSA (direction=outbound, humana ou IA). Quando
  // lastOutboundAt > lastInboundAt, o lead foi respondido — timer some/zera.
  lastOutboundAt: timestamp('last_outbound_at'),
  lastEscalationAt: timestamp('last_escalation_at'),
  // Quando o lead mudou pra coluna atual (FIFO): a ordenação no kanban usa esse
  // timestamp pra "lead com mais tempo de espera fica em cima". Sem ele, o lead
  // recém-movido pra cá ainda apareceria no topo por causa do lastMessageAt.
  statusChangedAt: timestamp('status_changed_at').notNull().defaultNow(),
  // Atribuição IA
  aiAgentActive: integer('ai_agent_active').notNull().default(0), // 0=off 1=on
  // Camada extra de bloqueio da IA, independente de aiAgentActive. Setada
  // pra `now + 24h` quando o lead é convertido — atendente humano responde
  // qualquer inbound nessa janela. Null = sem bloqueio.
  aiBlockedUntil: timestamp('ai_blocked_until'),
  // Pausa RENOVÁVEL da IA — setada quando atendente humano manda mensagem
  // (now + ai_pause_minutes_after_human) ou quando IA detecta trigger de
  // cancelamento/troca (now + ai_pause_minutes_after_cancellation). A cada
  // msg humana, o timer renova. Distinto de aiBlockedUntil que é fixo 24h
  // pós-conversão. Null = sem pausa ativa.
  aiPausedUntil: timestamp('ai_paused_until'),
  // "Resolvido" manualmente pelo atendente: clicar o botão Resolvido no
  // LeadModal move o lead pra `attending` E seta resolvedAt = now. Enquanto
  // resolvedAt está setado, NENHUM follow-up dispara — atendente sinalizou
  // "tô em paz aqui, não me lembre". Limpa AUTOMATICAMENTE quando o lead
  // manda nova msg inbound (volta a engajar = volta o ciclo normal). NÃO
  // afeta nada além de follow-ups: IA continua respondendo normalmente.
  resolvedAt: timestamp('resolved_at'),
  // Metadados extras (UTM, campanha, etc.)
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  convertedAt: timestamp('converted_at'),
  // Quem clicou em "Converti!". Null = conversão automática.
  convertedById: text('converted_by_id').references(() => users.id),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
}, (table) => [
  // Dedup do lead por (canal, contato). UNIQUE fecha a race do upsertLead
  // (rajada de inbound criava 2 leads pro mesmo contato). upsertLead trata a
  // violação 23505 re-buscando o lead concorrente.
  uniqueIndex('leads_channel_ext_uidx').on(table.channel, table.externalContactId),
]);
