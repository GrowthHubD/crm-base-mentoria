/**
 * Mutations (writes) do módulo leads.
 */
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { connections } from '@/lib/db/schema/connections';
import { attendantCloseLog } from '@/lib/db/schema/attendant-close-log';
import { eq, and } from 'drizzle-orm';
import type { CreateLeadInput, UpdateLeadInput, LeadStatus } from './types';
import { cardsSoPorArraste } from '@/modules/pipeline/modo';
import { colunaDeEntrada } from '@/modules/pipeline/stages';
import { escopoPorDonoAtivo } from '@/lib/escopo-dono';

/**
 * Grava o tempo de atendimento na hora que o lead é fechado (converted manual
 * ou deleted) — fonte de verdade do ranking, sobrevive ao delete do lead.
 * Best-effort: erros são swallowed pra não derrubar a mutation principal.
 *
 * Conversões automáticas (IA/Asaas) entram com userId=null → ficam de fora
 * do ranking de atendentes. Idempotência via UNIQUE (lead_id_text, action).
 */
export async function logAttendantClose(args: {
  userId: string | null;
  leadId: string;
  action: 'converted' | 'deleted';
  durationMs: number;
}): Promise<void> {
  try {
    await db
      .insert(attendantCloseLog)
      .values({
        userId: args.userId,
        leadIdText: args.leadId,
        action: args.action,
        durationMs: Math.max(0, Math.floor(args.durationMs)),
      })
      .onConflictDoNothing();
  } catch {
    // sem rethrow — métrica não pode quebrar a mutation
  }
}

/** De quem é o número por onde a mensagem entrou. `null` = número da casa. */
async function donoDaConexao(connectionId?: string | null): Promise<string | null> {
  if (!connectionId) return null;
  const [con] = await db
    .select({ ownerId: connections.ownerId })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);
  return con?.ownerId ?? null;
}

/**
 * Cria lead novo. Não checa duplicata — caller deve usar
 * `findLeadByContact` primeiro pra decidir create vs update.
 */
export async function createLead(input: CreateLeadInput): Promise<{ id: string }> {
  // No modo ARRASTE o lead já nasce numa coluna do funil. Sem isso ele nasceria
  // com `stage_id` nulo e o quadro o desenharia na coluna de fábrica de `new` —
  // escondida em quem montou funil próprio. Pior: como o desempate segue o
  // STATUS, o card andaria sozinho na primeira mudança, que é justamente o que
  // este modo existe para impedir.
  const stageId = input.stageId !== undefined
    ? input.stageId
    : cardsSoPorArraste() ? await colunaDeEntrada() : null;

  // O lead HERDA o dono do número por onde a conversa entrou. É este passo
  // que faz o isolamento funcionar de ponta a ponta: os filtros por
  // `leads.owner_id` só valem alguma coisa se alguém preencher a coluna, e o
  // webhook de inbound é por onde entra a esmagadora maioria dos leads.
  const ownerId = input.ownerId !== undefined ? input.ownerId : await donoDaConexao(input.connectionId);

  const [created] = await db
    .insert(leads)
    .values({
      externalContactId: input.externalContactId,
      channel: input.channel,
      connectionId: input.connectionId,
      unitId: input.unitId ?? null,
      name: input.name,
      phone: input.phone,
      email: input.email,
      avatarUrl: input.avatarUrl,
      notes: input.notes,
      ownerId,
      status: input.status ?? 'new',
      stageId,
      assignedToId: input.assignedToId,
      attributedChannel: input.attributedChannel,
      escalationLevel: 0,
      aiAgentActive: input.aiAgentActive ? 1 : 0,
      lastMessageAt: new Date(),
    })
    .returning({ id: leads.id });

  return created;
}

/**
 * Cria OU atualiza (upsert) lead pelo PAR (channel, externalContactId).
 * Retorna o lead existente sem recriar quando já existe — útil pro webhook
 * de inbound que sempre tenta criar mas não deve duplicar.
 */
export async function upsertLead(input: CreateLeadInput): Promise<{ id: string; isNew: boolean }> {
  // 1. Fast path: já existe?
  const existingId = await findAndTouchLead(input);
  if (existingId) return { id: existingId, isNew: false };

  // 2. Não existe → cria. RACE: quando o WhatsApp entrega uma RAJADA de
  //    mensagens do mesmo contato, dois workers passam pelo passo 1 sem achar
  //    nada (nenhum commitou ainda) e caem aqui juntos → dois INSERTs → dois
  //    leads pra mesma pessoa (a conversa "racha" entre os cards). Com a
  //    UNIQUE(channel, external_contact_id) no banco, o segundo INSERT
  //    viola (23505); em vez de estourar o processamento do inbound,
  //    re-buscamos e devolvemos o lead que o concorrente acabou de criar.
  //    Sem a constraint, o catch nunca dispara — comportamento idêntico ao
  //    anterior. (fix do bug de 92 leads duplicados por race — 2026-07-11)
  try {
    const created = await createLead(input);
    return { id: created.id, isNew: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await findAndTouchLead(input);
      if (raced) return { id: raced, isNew: false };
    }
    throw err;
  }
}

/** Acha o lead do par (channel, externalContactId) e, se existir,
 *  atualiza os campos "quentes" (lastMessageAt/nome/telefone/avatar/connection).
 *  Retorna o id ou null. Extraído pra ser reusado no fast-path e no retry
 *  pós-conflito do upsertLead. */
async function findAndTouchLead(input: CreateLeadInput): Promise<string | null> {
  const [existing] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(
      and(
        eq(leads.channel, input.channel),
        eq(leads.externalContactId, input.externalContactId)
      )
    )
    .limit(1);
  if (!existing) return null;

  const patch: Record<string, unknown> = { lastMessageAt: new Date(), updatedAt: new Date() };
  if (input.name) patch.name = input.name;
  if (input.phone) patch.phone = input.phone;
  if (input.avatarUrl) patch.avatarUrl = input.avatarUrl;
  // Atualiza a connection corrente (pode ter trocado de número/instância).
  if (input.connectionId) patch.connectionId = input.connectionId;

  // O DONO acompanha a conexão que passou a atender o lead.
  //
  // Só no modo carteira-por-dono (`FEATURE_LEAD_OWNERSHIP`, ligado na Acme;
  // desligado nos clientes de atendimento, onde a fila é compartilhada e isto
  // seria ruído). Sem isto, o `owner_id` fica congelado em quem CRIOU o lead:
  // se o número de outro BDR passa a conversar com o mesmo contato, ele atende
  // pela conexão dele mas o lead continua invisível para ele e preso ao dono
  // antigo (bug real: lead 5511999999999 criado pelo um BDR e atendido pela
  // conexão da outro BDR — só o admin via).
  //
  // A regra é "o lead é de quem está com a conexão dele nele agora". Reatribui
  // apenas quando a conexão nova tem dono E é diferente do atual — assim uma
  // conexão da casa (sem dono) não rouba o lead de um BDR.
  if (input.connectionId && escopoPorDonoAtivo()) {
    const [conexao] = await db
      .select({ ownerId: connections.ownerId })
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .limit(1);
    if (conexao?.ownerId) patch.ownerId = conexao.ownerId;
  }

  await db.update(leads).set(patch).where(eq(leads.id, existing.id));
  return existing.id;
}

/** Violação de unicidade do Postgres (23505). O erro pode vir cru ou embrulhado
 *  pelo DrizzleQueryError (código na `.cause`). */
function isUniqueViolation(err: unknown): boolean {
  const codes: Array<string | undefined> = [];
  if (err && typeof err === 'object') {
    codes.push((err as { code?: string }).code);
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') codes.push((cause as { code?: string }).code);
  }
  return codes.includes('23505');
}

export async function updateLead(id: string, patch: UpdateLeadInput): Promise<void> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.phone !== undefined) update.phone = patch.phone;
  if (patch.avatarUrl !== undefined) update.avatarUrl = patch.avatarUrl;
  if (patch.notes !== undefined) update.notes = patch.notes;
  // Coluna personalizada do kanban. Acompanha o `status` quando o card é
  // movido; sozinha só para devolver o card à coluna de fábrica (`null`).
  if (patch.stageId !== undefined) update.stageId = patch.stageId;
  if (patch.status !== undefined) {
    update.status = patch.status;
    // Toda mudança de status reseta o cronômetro FIFO da kanban — quem acabou
    // de chegar na coluna vai pro fim da fila.
    update.statusChangedAt = new Date();
    // converted: marca timestamp, registra quem converteu (null=automática),
    // bloqueia IA por 24h.
    // Sair de converted via PATCH MANUAL: limpa tudo (atendente arrastando card
    // ou trocando dropdown = "vamos voltar a falar normal com esse lead").
    // Reabertura AUTOMÁTICA por inbound (em bumpActivity) NÃO passa por aqui;
    // usa setLeadStatus direto, que preserva aiBlockedUntil.
    if (patch.status === 'converted') {
      update.convertedAt = new Date();
      update.convertedById = patch.convertedById ?? null;
      update.aiBlockedUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    } else {
      update.convertedAt = null;
      update.convertedById = null;
      update.aiBlockedUntil = null;
    }
  }
  // Log de fechamento — quando atendente HUMANO marca convertido. Conversões
  // automáticas (convertedById=null) entram no DB mas não populam o ranking.
  // Lemos createdAt do lead pra calcular duração — buscamos por dentro pra
  // não exigir do caller. Hook só pra `converted` (delete fica em deleteLead).
  if (patch.status === 'converted' && patch.convertedById) {
    const [row] = await db
      .select({ createdAt: leads.createdAt })
      .from(leads)
      .where(eq(leads.id, id))
      .limit(1);
    if (row) {
      const now = Date.now();
      await logAttendantClose({
        userId: patch.convertedById,
        leadId: id,
        action: 'converted',
        durationMs: now - row.createdAt.getTime(),
      });
    }
  }
  if (patch.assignedToId !== undefined) update.assignedToId = patch.assignedToId;
  if (patch.aiAgentActive !== undefined) update.aiAgentActive = patch.aiAgentActive ? 1 : 0;
  if (patch.metadata !== undefined) update.metadata = patch.metadata;
  if (patch.attributedChannel !== undefined) update.attributedChannel = patch.attributedChannel;
  if (patch.aiPausedUntil !== undefined) update.aiPausedUntil = patch.aiPausedUntil;
  if (patch.resolvedAt !== undefined) update.resolvedAt = patch.resolvedAt;

  await db.update(leads).set(update).where(eq(leads.id, id));
}

/**
 * Atualiza `lastMessageAt` + o campo direcional (`lastInboundAt` ou
 * `lastOutboundAt`). Caller passa `direction` pra alimentar o relógio de
 * espera do kanban: timer só conta tempo desde lastInboundAt > lastOutboundAt.
 */
export async function touchLastMessage(
  leadId: string,
  when: Date = new Date(),
  direction?: 'inbound' | 'outbound'
): Promise<void> {
  const update: Record<string, unknown> = { lastMessageAt: when, updatedAt: new Date() };
  if (direction === 'inbound') update.lastInboundAt = when;
  else if (direction === 'outbound') update.lastOutboundAt = when;
  await db.update(leads).set(update).where(eq(leads.id, leadId));
}

/**
 * Marca status + escalation level + lastEscalationAt em UMA query atômica.
 * Usado pelo escalation worker.
 */
export async function escalateLead(
  id: string,
  toStatus: LeadStatus,
  level: number
): Promise<void> {
  await db
    .update(leads)
    .set({
      status: toStatus,
      escalationLevel: level,
      lastEscalationAt: new Date(),
      statusChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
}

/**
 * Atualiza status + (opcionalmente) assignedToId, convertedById, aiBlockedUntil.
 *
 * Regras:
 *   - status='converted' SEM `convertedById` no options: conversão automática
 *     (IA via criar_reserva ou webhook Asaas). Sem `aiBlockedUntil` no
 *     options: default = now+24h.
 *   - status='converted' COM convertedById: conversão manual (atendente clicou
 *     "Converti!"). Mesmo default de 24h se não passar aiBlockedUntil.
 *   - status != 'converted': NÃO mexe em convertedAt/convertedById/aiBlockedUntil.
 *     Quem precisa limpar usa `updateLead({ status: ... })` (intervenção
 *     manual via PATCH) ou seta esses campos explicitamente.
 *
 * Esse contrato preserva aiBlockedUntil em reaberturas AUTOMÁTICAS (lead
 * convertido recebe inbound → volta pra `new` mas continua bloqueado).
 */
export async function setLeadStatus(
  id: string,
  status: LeadStatus,
  options: {
    assignedToId?: string | null;
    convertedById?: string | null;
    aiBlockedUntil?: Date | null;
    /**
     * Manter o card na coluna personalizada em que ele está.
     *
     * Só quem MOVE o card de propósito passa isto (a rota PATCH, quando o
     * atendente arrasta para uma coluna criada). Todo o resto — mensagem que
     * chega, resposta que sai, escalação por tempo — deixa o padrão e devolve o
     * card ao fluxo.
     */
    manterStage?: boolean;
  } = {}
): Promise<void> {
  const update: Record<string, unknown> = {
    status,
    statusChangedAt: new Date(),
    updatedAt: new Date(),
    // O card VOLTA AO FLUXO quando o status muda por conta própria.
    //
    // É o que faz uma coluna como "Proposta enviada" se comportar como se
    // espera NO MODO FILA: o card fica lá parado até alguém falar — o cliente
    // responde e ele vai para Novos, o SDR responde e ele vai para Respondidos.
    // Sem isto, o card ficaria preso na coluna personalizada para sempre, com o
    // status mudando por baixo e ninguém vendo: a fila de Novos não mostraria
    // um lead que acabou de responder.
    //
    // No modo ARRASTE isso se inverte — ver `pipeline/modo.ts`. Lá a coluna é a
    // etapa do funil que o SDR registrou à mão, e devolver o card ao fluxo
    // apagaria exatamente o que ele acabou de registrar.
    ...(options.manterStage || cardsSoPorArraste() ? {} : { stageId: null }),
  };
  if (status === 'converted') {
    update.convertedAt = new Date();
    update.convertedById = options.convertedById ?? null;
    update.aiBlockedUntil = options.aiBlockedUntil ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
  }
  if (options.assignedToId !== undefined) update.assignedToId = options.assignedToId;
  await db.update(leads).set(update).where(eq(leads.id, id));
}

/**
 * Tira um lead do status terminal `converted` por causa de uma mensagem NOSSA
 * (outbound) e o coloca de volta em `attending` (coluna "Respondidos" do CRM).
 *
 * Limpa o bloqueio TEMPORÁRIO da IA (`aiBlockedUntil`, setado em +24h na
 * conversão) mas PRESERVA `convertedAt`/`convertedById`: a conversão é fato
 * histórico e continua no relatório de convertidos do dashboard (com badge
 * "reaberto"). Só o estado terminal "ativo" some — o lead volta a ser tratável.
 *
 * Distinto de `setLeadStatus(id, 'attending')` (que NÃO mexe em aiBlockedUntil)
 * e de `updateLead({ status: 'attending' })` (que ZERA convertedAt junto).
 */
export async function reopenConvertedToAttending(id: string): Promise<void> {
  await db
    .update(leads)
    .set({
      status: 'attending',
      statusChangedAt: new Date(),
      aiBlockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(leads.id, id));
}
