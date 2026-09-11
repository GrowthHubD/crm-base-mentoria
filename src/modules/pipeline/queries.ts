/**
 * Queries dedicadas pra views do CRM (kanban, dashboard).
 * Fica separado do `service.ts` (que tem regras de negócio) pra simplificar.
 */
import { db } from '@/lib/db/client';
import { filtroUnidade } from '@/modules/units/service';
import { filtroDono } from '@/lib/escopo-dono';
import { leads } from '@/lib/db/schema/leads';
import { messages } from '@/lib/db/schema/messages';
import { connections } from '@/lib/db/schema/connections';
import { users } from '@/lib/db/schema/users';
import { asc, desc, eq, sql, inArray, and, or, ilike } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { LeadStatus, LeadChannel } from '@/modules/leads/types';

/** `users` visto como "o dono do lead" — ver o join em `getKanbanData`. */
const donos = alias(users, 'donos');

export interface KanbanAttendant {
  id: string | null;
  name: string;
  role: 'admin' | 'attendant' | null;
  lastInteractionAt: Date;
}

export interface KanbanLead {
  id: string;
  name: string | null;
  phone: string | null;
  /** Coluna personalizada onde o card está; `null` = coluna de fábrica do status. */
  stageId: string | null;
  channel: LeadChannel;
  connectionId: string | null;
  connectionName: string | null;
  status: LeadStatus;
  assignedToId: string | null;
  assignedToName: string | null;
  /** BDR dono da conversa. `null` = lead da casa (só o admin enxerga). */
  ownerId: string | null;
  ownerName: string | null;
  aiAgentActive: boolean;
  /**
   * Pausa renovável da IA. Quando > now(), IA fica em silêncio mesmo com
   * aiAgentActive=true. UI usa pra mostrar "IA PAUSADA até HH:MM" em vez
   * do simples "IA ON" mentiroso.
   */
  aiPausedUntil: Date | null;
  lastMessage: string | null;
  /** Quem mandou a última mensagem — pra UI prefixar "Você:" / "IA:" / etc.
   * 'lead' = mensagem do cliente (sem prefix). null = sem mensagens. */
  lastMessageSender: 'lead' | 'human' | 'ai' | 'owner' | null;
  lastMessageAt: Date | null;
  unread: boolean;
  /**
   * Minutos desde a última msg INBOUND não respondida ainda
   * (lastInboundAt > lastOutboundAt). Null quando a última msg foi nossa —
   * UI mostra "Respondido" e some o relógio. Esse é o "tempo sem resposta"
   * que o card exibe.
   */
  awaitingMinutes: number | null;
  /** Segundos da mesma métrica — usado pra "Xs" quando < 60s. Null quando respondido. */
  awaitingSeconds: number | null;
  /** @deprecated Use awaitingMinutes — mantido temporariamente até remover do client. */
  ageMinutes: number;
  /** @deprecated Use awaitingSeconds. */
  ageSeconds: number;
  /**
   * Atendentes HUMANOS que já interagiram no lead, ordenados pela última
   * interação desc. Derivado de DISTINCT sentById em messages — sem schema
   * próprio de co-assignment.
   */
  attendants: KanbanAttendant[];
  /**
   * @deprecated Use `attendants[0]`. Mantido por compatibilidade com componentes
   * antigos enquanto a transição não conclui.
   */
  lastAttendantId: string | null;
  lastAttendantName: string | null;
  lastAttendantRole: 'admin' | 'attendant' | null;
  createdAt: Date;
  /**
   * Setado quando o lead foi arquivado pelo botão "Resolvido". Combinado com
   * `awaitingMinutes !== null`, distingue o lead RESOLVIDO SEM NUNCA responder
   * o cliente — o descarte silencioso, que se escondia na coluna Respondidos —
   * do respondido de verdade.
   */
  resolvedAt: Date | null;
}

/**
 * Retorna todos os leads agrupados em fila (kanban).
 *
 * Status `converted`/`lost` ficam de fora do kanban — eles voltam pro pipeline
 * automaticamente quando o lead manda mensagem nova depois da janela de 48h
 * (ver `reopenIfStale` em `recordInboundMessage`). Antes disso, ficam invisíveis.
 */
export async function getKanbanData(filter: {
  connectionId?: string;
  unitId?: string | null;
  /** Recorte por dono — ver `lib/escopo-dono.ts`. `null` = vê tudo. */
  ownerId?: string | null;
} = {}): Promise<{
  novos: KanbanLead[];
  prioridade: KanbanLead[];
  urgencia: KanbanLead[];
  respondidos: KanbanLead[];
  convertidos: KanbanLead[];
}> {
  // Escopo comum (unidade/conexão). O status NÃO entra aqui: as filas
  // acionáveis e o arquivo "Respondidos" são buscados em queries separadas
  // pra que o volume de attending (centenas de leads) NÃO consuma o LIMIT e
  // zere Novos/Prioridade/Urgência. Bug observado: Atenas com 986 leads não-
  // terminais — o LIMIT 500 ASC pegava só os attending mais antigos e cortava
  // as 274 urgências (kanban mostrava Urgência 0).
  const scope: SQL[] = [];
  if (filter.connectionId) scope.push(eq(leads.connectionId, filter.connectionId));
  // Recorte por unidade. O `or(..., isNull)` é deliberado: filtrar por uma
  // filial também traz o que ainda não foi atribuído a nenhuma. Sem isso,
  // ligar o módulo num cliente que já opera deixaria o board VAZIO no primeiro
  // acesso, porque todo lead histórico está com unit_id nulo.
  const porUnidade = filtroUnidade(leads.unitId, filter.unitId);
  if (porUnidade) scope.push(porUnidade);
  // Recorte por dono. Ao contrário do de unidade, este NÃO traz o que está sem
  // dono junto: lead sem dono é da casa e só o admin vê. Ver `escopo-dono.ts`.
  const porDono = filtroDono(leads.ownerId, filter.ownerId);
  if (porDono) scope.push(porDono);

  const KANBAN_COLS = {
    id: leads.id,
    name: leads.name,
    phone: leads.phone,
    // Coluna personalizada em que o card está, quando há uma. As filas por
    // status continuam idênticas — quem separa os cards das colunas criadas
    // pelo cliente é a tela, com este campo.
    stageId: leads.stageId,
    channel: leads.channel,
    connectionId: leads.connectionId,
    connectionName: connections.displayName,
    status: leads.status,
    assignedToId: leads.assignedToId,
    assignedToName: users.name,
    /** De quem é este lead. O admin usa para saber de qual BDR é a conversa. */
    ownerId: leads.ownerId,
    ownerName: donos.name,
    aiAgentActive: leads.aiAgentActive,
    aiPausedUntil: leads.aiPausedUntil,
    lastMessageAt: leads.lastMessageAt,
    lastInboundAt: leads.lastInboundAt,
    lastOutboundAt: leads.lastOutboundAt,
    statusChangedAt: leads.statusChangedAt,
    createdAt: leads.createdAt,
    resolvedAt: leads.resolvedAt,
  } as const;

  const baseQuery = () =>
    db
      .select(KANBAN_COLS)
      .from(leads)
      .leftJoin(connections, eq(leads.connectionId, connections.id))
      .leftJoin(users, eq(leads.assignedToId, users.id))
      // Segundo join na MESMA tabela, por isso o alias: `users` já está preso
      // a quem está atendendo, e dono é outra pessoa (ver o comentário de
      // `leads.ownerId` no schema).
      .leftJoin(donos, eq(leads.ownerId, donos.id));

  const [activeRows, respondidosRows, convertidosRows] = await Promise.all([
    // Filas acionáveis (Novos/Prioridade/Urgência): SEM corte real — o
    // atendente precisa ver TODAS. Cap alto só como salvaguarda. FIFO de
    // espera: inbound mais antigo não respondido no topo.
    baseQuery()
      .where(and(inArray(leads.status, ['new', 'priority', 'urgency'] as LeadStatus[]), ...scope))
      .orderBy(sql`COALESCE(${leads.lastInboundAt}, ${leads.statusChangedAt}) ASC NULLS LAST`)
      .limit(2000),
    // Respondidos: arquivo grande de conversas já respondidas — mostra só as
    // mais recentes (DESC), suficiente pra UI; o resto é histórico.
    baseQuery()
      .where(and(eq(leads.status, 'attending'), ...scope))
      .orderBy(sql`${leads.lastMessageAt} DESC NULLS LAST`)
      .limit(500),
    // Convertidos: lista de leitura (abaixo de "Respondidos" no CRM). Só status
    // 'converted' — leads reabertos (auto por inbound, ou por mensagem nossa)
    // já saíram desse status e somem daqui sozinhos. Mais recente convertido no
    // topo. A ordem da query é preservada pelo filter() estável lá embaixo.
    baseQuery()
      .where(and(eq(leads.status, 'converted'), ...scope))
      .orderBy(sql`${leads.convertedAt} DESC NULLS LAST`)
      .limit(300),
  ]);

  const rows = [...activeRows, ...respondidosRows, ...convertidosRows];

  if (rows.length === 0) {
    return { novos: [], prioridade: [], urgencia: [], respondidos: [], convertidos: [] };
  }

  // Última mensagem de cada lead — UMA LINHA POR LEAD, resolvida no banco.
  //
  // A versão anterior usava `row_number() over (partition by lead_id)` sem
  // corte e filtrava `rn = 1` no Node. Isso significa trazer TODAS as mensagens
  // de todos os leads do board — os limites acima somam 2.800 leads — só para
  // descartar quase tudo depois. Numa conversa com 300 mensagens são 300 linhas
  // transferidas para usar 1.
  //
  // Não é teoria: no Sistema Motel, que tem o mesmo desenho, isso estourou o
  // `statement_timeout` do Postgres com o board cheio e derrubou o CRM duas
  // vezes (incidentes de 25 e 26/08). Com vários atendentes e polling de 10s,
  // as varreduras concorrentes afogam o compute do Supabase, e aí até
  // `count(*)` passa a dar timeout e conexão nova passa a falhar.
  //
  // `DISTINCT ON (lead_id) ORDER BY lead_id, timestamp DESC` devolve
  // exatamente uma linha por lead, e o índice composto
  // `idx_messages_lead_id_timestamp` faz o banco resolver por índice em vez de
  // varrer. SQL cru porque o Drizzle não expõe DISTINCT ON.
  const leadIds = rows.map(r => r.id);
  const lastMsgs = leadIds.length
    ? ((await db.execute(sql`
        select distinct on (${messages.leadId})
               ${messages.leadId}   as "leadId",
               ${messages.body}     as "body",
               ${messages.type}     as "type",
               ${messages.direction} as "direction",
               ${messages.sender}   as "sender",
               ${messages.timestamp} as "timestamp"
        from ${messages}
        where ${inArray(messages.leadId, leadIds)}
        order by ${messages.leadId}, ${messages.timestamp} desc
      `)) as unknown as Array<{
        leadId: string;
        body: string | null;
        type: string;
        direction: string;
        sender: string;
        timestamp: Date;
      }>)
    : [];

  // Atendentes HUMANOS distintos que já interagiram no lead — usado pra
  // stack de avatars no card da kanban (vários atendentes podem assumir a
  // mesma conversa). Filtra sender='human' pra não confundir com IA/owner;
  // senderName foi persistido na hora do envio em /api/leads/[id]/messages.
  // DISTINCT por (lead_id, sentById) com timestamp mais recente — query no
  // app code porque Drizzle não tem helper limpo pra DISTINCT ON multi-coluna.
  const humanRows = await db
    .select({
      leadId: messages.leadId,
      sentById: messages.sentById,
      senderName: messages.senderName,
      timestamp: messages.timestamp,
      userName: users.name,
      userRole: users.role,
    })
    .from(messages)
    .leftJoin(users, eq(messages.sentById, users.id))
    .where(and(inArray(messages.leadId, leadIds), eq(messages.sender, 'human')))
    .orderBy(desc(messages.timestamp))
    .limit(5000); // acme-cap: 500 leads × 10 mensagens humanas recentes/lead

  // Mapa leadId → mapa userKey → último timestamp + nome/role.
  // userKey: sentById quando existe (canônico), senão nome (fallback p/ msgs antigas).
  const attendantsByLead = new Map<string, Map<string, KanbanAttendant>>();
  for (const row of humanRows) {
    const userKey = row.sentById ?? `name:${row.senderName ?? row.userName ?? ''}`;
    if (!userKey || userKey === 'name:') continue;
    let bucket = attendantsByLead.get(row.leadId);
    if (!bucket) {
      bucket = new Map();
      attendantsByLead.set(row.leadId, bucket);
    }
    if (bucket.has(userKey)) continue; // já temos o mais recente desse atendente (orderBy desc)
    const name = row.senderName ?? row.userName ?? null;
    if (!name) continue;
    const role = (row.userRole as 'admin' | 'attendant' | null) ?? null;
    bucket.set(userKey, {
      id: row.sentById,
      name,
      role,
      lastInteractionAt: row.timestamp,
    });
  }

  // O DISTINCT ON já devolve uma linha por lead, então não há mais o filtro
  // `rn === 1` — que, além de desperdiçar a transferência, já tinha falhado em
  // silêncio: o Postgres devolve bigint e o driver entrega string, então
  // `=== 1` era sempre falso e o kanban mostrava "(sem mensagens)" em todo
  // lead. Sem o row_number, a classe de bug some junto.
  const lastByLead = new Map<string, { body: string | null; type: string; direction: string; sender: string; timestamp: Date }>();
  {
    for (const m of lastMsgs) {
      lastByLead.set(m.leadId, {
        body: m.body,
        type: m.type as string,
        direction: m.direction as string,
        sender: m.sender as string,
        timestamp: m.timestamp,
      });
    }
  }

  // Pré-computa o array ordenado de atendentes por lead — evita repetir o sort
  // dentro do map abaixo.
  const sortedAttendantsByLead = new Map<string, KanbanAttendant[]>();
  for (const [leadId, bucket] of attendantsByLead.entries()) {
    sortedAttendantsByLead.set(
      leadId,
      Array.from(bucket.values()).sort(
        (a, b) => b.lastInteractionAt.getTime() - a.lastInteractionAt.getTime()
      )
    );
  }

  const now = Date.now();
  const enriched: KanbanLead[] = rows.map(r => {
    const last = lastByLead.get(r.id);
    // "Tempo sem resposta" = agora − última msg do cliente, SE a última msg
    // foi do cliente (inbound depois do nosso outbound). Se a última foi
    // nossa, devolvemos null e a UI esconde o relógio (mostra "Respondido").
    const inbound = r.lastInboundAt?.getTime() ?? 0;
    const outbound = r.lastOutboundAt?.getTime() ?? 0;
    const awaiting = inbound > outbound && inbound > 0;
    const awaitingMs = awaiting ? Math.max(0, now - inbound) : null;
    const awaitingMinutes = awaitingMs !== null ? Math.floor(awaitingMs / 60_000) : null;
    const awaitingSeconds = awaitingMs !== null ? Math.floor(awaitingMs / 1_000) : null;
    // Preview: usa body quando há texto; senão deriva uma label legível pelo type
    // (ex: imagem → "📷 Imagem"). Sem mensagem nenhuma → null e a UI mostra "(sem mensagens)".
    let preview = last?.body?.trim() || null;
    if (!preview && last?.type) {
      const t = last.type;
      if (t === 'image') preview = '📷 Imagem';
      else if (t === 'audio') preview = '🎤 Áudio';
      else if (t === 'video') preview = '🎬 Vídeo';
      else if (t === 'document') preview = '📄 Documento';
      else if (t === 'sticker') preview = '✨ Sticker';
      else if (t === 'text') preview = null; // texto sem body é mensagem vazia, ignora
      else preview = `[${t}]`;
    }
    return {
      id: r.id,
      name: r.name,
      phone: r.phone,
      stageId: r.stageId,
      channel: r.channel as LeadChannel,
      connectionId: r.connectionId,
      connectionName: r.connectionName,
      status: r.status as LeadStatus,
      assignedToId: r.assignedToId,
      assignedToName: r.assignedToName,
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      aiAgentActive: r.aiAgentActive === 1,
      aiPausedUntil: r.aiPausedUntil,
      lastMessage: preview,
      lastMessageSender: (last?.sender as KanbanLead['lastMessageSender']) ?? null,
      lastMessageAt: r.lastMessageAt,
      // unread = última mensagem é inbound (lead mandou e atendente ainda não viu/respondeu)
      unread: last?.direction === 'inbound',
      awaitingMinutes,
      awaitingSeconds,
      // Compat: alguns clients antigos ainda lêem ageMinutes/ageSeconds.
      // Mantém valor coerente (= awaiting* quando não respondido, 0 quando respondido).
      ageMinutes: awaitingMinutes ?? 0,
      ageSeconds: awaitingSeconds ?? 0,
      attendants: sortedAttendantsByLead.get(r.id) ?? [],
      lastAttendantId: sortedAttendantsByLead.get(r.id)?.[0]?.id ?? null,
      lastAttendantName: sortedAttendantsByLead.get(r.id)?.[0]?.name ?? null,
      lastAttendantRole: sortedAttendantsByLead.get(r.id)?.[0]?.role ?? null,
      createdAt: r.createdAt,
      resolvedAt: r.resolvedAt,
    };
  });

  // Um lead "respondido" (última msg foi NOSSA → awaitingMinutes === null) não
  // pertence a uma fila de espera, mesmo que o status persistido ainda seja
  // new/priority/urgency. O rebaixamento pra 'attending' em bumpActivity tem
  // furos (resposta via follow-up, race de timestamp) que deixam o status
  // travado — então a COLUNA segue a verdade dos timestamps, não o status cru.
  // (Bug relatado: card com badge verde "Respondido" preso na coluna Urgência.)
  // NÃO mexemos no status no banco: assim a IA continua respondendo se o cliente
  // voltar a falar (status=attending bloquearia a IA).
  const isWaiting = (l: KanbanLead) => l.awaitingMinutes !== null;
  const respondedButQueued = (l: KanbanLead) =>
    (l.status === 'new' || l.status === 'priority' || l.status === 'urgency') && !isWaiting(l);

  return {
    // novos/prioridade/urgencia: FIFO de espera (mais antigo sem resposta no
    // topo) — a ordenação ASC da query já entrega assim. Só leads AGUARDANDO.
    novos: enriched.filter(l => l.status === 'new' && isWaiting(l)),
    prioridade: enriched.filter(l => l.status === 'priority' && isWaiting(l)),
    urgencia: enriched.filter(l => l.status === 'urgency' && isWaiting(l)),
    // respondidos: status 'attending' OU qualquer lead de fila que já foi
    // respondido. Sem "tempo de espera" → ordem cronológica reversa (atendido
    // mais recente no topo).
    respondidos: enriched
      .filter(l => l.status === 'attending' || respondedButQueued(l))
      .sort((a, b) => (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0)),
    // convertidos: status 'converted' — ordem já vem por convertedAt DESC da
    // query (filter estável preserva). Lista de leitura; o card não tem botões
    // de mover (quickMoveTargets devolve [] pra converted).
    convertidos: enriched.filter(l => l.status === 'converted'),
  };
}

export interface ConversationSearchResult {
  id: string;
  name: string | null;
  phone: string | null;
  channel: LeadChannel;
  connectionName: string | null;
  status: LeadStatus;
  assignedToName: string | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  /** Trecho da mensagem que casou com a busca. null = casou só por nome/telefone. */
  snippet: string | null;
  /** Onde casou: 'message' (conteúdo do chat) ou 'contact' (nome/telefone). */
  matchedIn: 'message' | 'contact';
}

/**
 * Busca conversas por termo — casa nome, telefone E o CONTEÚDO das mensagens
 * (body / legenda de mídia / texto citado). Diferente do filtro client-side do
 * kanban (que só vê os cards carregados e só name/phone), esta varre o banco e
 * cobre TODOS os status, inclusive convertidos/perdidos — pra achar "aquela
 * conversa onde o cliente falou 'pix'" mesmo que já tenha saído das filas.
 *
 * Retorna no máximo `limit` leads, com o trecho que bateu, ordenados pela última
 * mensagem (mais recente primeiro).
 */
export async function searchConversations(
  filter: {
    connectionId?: string;
    ownerId?: string | null;
    unitId?: string | null;
    channel?: LeadChannel;
  },
  rawTerm: string,
  limit = 60,
): Promise<ConversationSearchResult[]> {
  const term = rawTerm.trim();
  if (term.length < 2) return [];
  // Escapa curingas do LIKE pra "100%" não virar "qualquer coisa".
  const like = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

  const scope: SQL[] = [];
  if (filter.connectionId) scope.push(eq(leads.connectionId, filter.connectionId));
  if (filter.channel) scope.push(eq(leads.channel, filter.channel));
  const porUnidade = filtroUnidade(leads.unitId, filter.unitId);
  if (porUnidade) scope.push(porUnidade);
  // A busca varre TODOS os status, inclusive convertidos e perdidos — sem
  // este recorte ela seria a porta dos fundos do isolamento por dono, e a
  // mais fácil de achar: dá para procurar pelo conteúdo da conversa alheia.
  const porDono = filtroDono(leads.ownerId, filter.ownerId);
  if (porDono) scope.push(porDono);

  // 1) Conteúdo: mensagem mais recente, por lead, cujo texto bate com o termo.
  //    DISTINCT ON (lead_id) + ORDER timestamp DESC → 1 trecho por conversa.
  const contentRows = await db
    .selectDistinctOn([messages.leadId], {
      leadId: messages.leadId,
      snippet: sql<string>`coalesce(${messages.body}, ${messages.mediaCaption}, ${messages.quotedContent})`,
    })
    .from(messages)
    .innerJoin(leads, eq(messages.leadId, leads.id))
    .where(
      and(
        ...scope,
        or(
          ilike(messages.body, like),
          ilike(messages.mediaCaption, like),
          ilike(messages.quotedContent, like),
        ),
      ),
    )
    .orderBy(messages.leadId, desc(messages.timestamp))
    .limit(limit * 4);

  // 2) Contato: leads cujo nome/telefone batem (independe de mensagens).
  const contactRows = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(...scope, or(ilike(leads.name, like), ilike(leads.phone, like))))
    .limit(limit * 4);

  const snippetByLead = new Map<string, string>();
  for (const r of contentRows) if (r.snippet) snippetByLead.set(r.leadId, r.snippet);

  const ids = new Set<string>([...snippetByLead.keys(), ...contactRows.map((r) => r.id)]);
  if (ids.size === 0) return [];

  const rows = await db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      channel: leads.channel,
      connectionName: connections.displayName,
      status: leads.status,
      assignedToName: users.name,
      lastMessageAt: leads.lastMessageAt,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .leftJoin(connections, eq(leads.connectionId, connections.id))
    .leftJoin(users, eq(leads.assignedToId, users.id))
    .where(inArray(leads.id, Array.from(ids)));

  const results: ConversationSearchResult[] = rows.map((r) => {
    const snippet = snippetByLead.get(r.id) ?? null;
    return {
      id: r.id,
      name: r.name,
      phone: r.phone,
      channel: r.channel as LeadChannel,
      connectionName: r.connectionName,
      status: r.status as LeadStatus,
      assignedToName: r.assignedToName,
      lastMessageAt: r.lastMessageAt,
      createdAt: r.createdAt,
      snippet,
      matchedIn: snippet ? 'message' : 'contact',
    };
  });

  results.sort(
    (a, b) =>
      (b.lastMessageAt?.getTime() ?? b.createdAt.getTime()) -
      (a.lastMessageAt?.getTime() ?? a.createdAt.getTime()),
  );
  return results.slice(0, limit);
}

/**
 * Lista de connections ativas para filtros do CRM.
 */
export async function listActiveConnections(
  filter: { ownerId?: string | null; unitId?: string | null } = {}
): Promise<Array<{ id: string; name: string | null; type: string; unitId: string | null }>> {
  // As abas de conexão no topo do CRM. Sem o recorte, o BDR veria o nome e o
  // número dos colegas na própria tela — e a aba dele filtraria leads que o
  // kanban já não devolve, dando a impressão de que o CRM está quebrado.
  const porDono = filtroDono(connections.ownerId, filter.ownerId);
  const porUnidade = filtroUnidade(connections.unitId, filter.unitId);
  const q = db
    .select({
      id: connections.id,
      name: connections.displayName,
      type: connections.type,
      unitId: connections.unitId,
    })
    .from(connections);
  const conditions = [porDono, porUnidade].filter((condition): condition is SQL => Boolean(condition));
  return conditions.length ? q.where(and(...conditions)) : q;
}
