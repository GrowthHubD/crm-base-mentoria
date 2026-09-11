/**
 * Escopo por DONO — quem enxerga a conversa de quem.
 *
 * Nasceu de um vazamento real: um BDR recém-criado abriu o CRM e estava vendo
 * as conversas do número do admin. O CRM veio de um sistema de atendimento, em
 * que a fila é compartilhada de propósito — todo mundo vê tudo porque qualquer
 * um pode pegar o próximo da fila. Num time de prospecção o desenho é o
 * oposto: cada BDR tem o número dele, e o que ele conversa não é assunto dos
 * colegas.
 *
 * Três regras, e a ordem entre elas é a segurança do módulo:
 *
 *  1. Módulo desligado (`FEATURE_LEAD_OWNERSHIP` off) → ninguém filtra nada.
 *     O cliente de atendimento continua com a fila compartilhada, que é o que
 *     ele contratou.
 *  2. Admin → vê tudo. É ele quem acompanha o time.
 *  3. Qualquer outro papel → só o que é dele, e ponto. Não escolhe, não recebe
 *     seletor, e o que o navegador mandar não muda isso.
 *
 * A regra 3 não aceita parâmetro de propósito. O recorte sai do registro do
 * usuário no banco, nunca de cabeçalho, query string ou corpo da requisição —
 * confiar no que o cliente pede aqui seria repetir o erro clássico de esconder
 * o menu e deixar a URL aberta.
 *
 * **Fail-closed**: dono nulo pertence à casa e só o admin vê. Um caminho de
 * criação que esqueça de marcar o dono faz o lead sumir da tela de um BDR — o
 * que é um bug visível e reclamável — em vez de exibi-lo para o time inteiro,
 * que é um vazamento silencioso.
 */
import { NextResponse } from 'next/server';
import { eq, isNull, type SQL } from 'drizzle-orm';
import type { AuthedRequestUser } from './auth-helpers';
import { unidadesAtivas } from './units';

/** Módulo vendido/ligado à parte — desligado a menos que explicitamente ligado. */
export function escopoPorDonoAtivo(): boolean {
  const v = process.env.FEATURE_LEAD_OWNERSHIP?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface EscopoDono {
  /** `null` = sem recorte (vê tudo). Caso contrário, filtrar por este id. */
  ownerId: string | null;
  /** True quando esta pessoa enxerga o trabalho do time inteiro. */
  veTudo: boolean;
}

/**
 * Resolve o recorte desta requisição a partir de QUEM está logado.
 *
 * Não recebe nada do cliente — ver o comentário do topo.
 */
export function escopoDono(
  usuario: Pick<AuthedRequestUser, 'id' | 'role'>
): EscopoDono {
  if (!escopoPorDonoAtivo()) return { ownerId: null, veTudo: true };
  if (usuario.role === 'admin') return { ownerId: null, veTudo: true };
  return { ownerId: usuario.id, veTudo: false };
}

/**
 * Condição de recorte para uma coluna `owner_id`.
 *
 * Devolve `undefined` quando não há recorte, para quem chama passar direto ao
 * `and(...)` sem `if`.
 *
 * **Não tem `or(isNull(...))`** — e é aqui que este filtro difere do de
 * unidades, que traz o não-atribuído junto para permitir migração incremental.
 * Fazer o mesmo aqui entregaria ao BDR todo lead sem dono, incluindo os do
 * admin, que é exatamente o vazamento que o módulo existe para fechar. O preço
 * é que o dono precisa ser preenchido na criação e no backfill; a alternativa
 * é vazar em silêncio.
 */
export function filtroDono(
  coluna: Parameters<typeof isNull>[0],
  ownerId: string | null | undefined
): SQL | undefined {
  if (!ownerId) return undefined;
  return eq(coluna as never, ownerId);
}

/**
 * Este usuário pode abrir ESTE lead?
 *
 * O recorte nas listagens esconde o card, mas não fecha a porta: o id do lead
 * anda pela URL (`/api/leads/<id>/messages`) e adivinhar ou reaproveitar um id
 * é trivial. Sem esta checagem, o isolamento seria só a tela — o erro clássico
 * de esconder o menu e deixar a rota aberta.
 *
 * Responde 404 e não 403 de propósito: um 403 confirmaria que o lead existe,
 * o que já é informação sobre a carteira do colega.
 */
export async function garantirAcessoAoLead(
  usuario: Pick<AuthedRequestUser, 'id' | 'role' | 'unitId'>,
  leadId: string
): Promise<{ ok: true } | { response: NextResponse }> {
  const escopo = escopoDono(usuario);
  const unidadeRestrita = unidadesAtivas() ? usuario.unitId : null;
  if (escopo.veTudo && !unidadeRestrita) return { ok: true };

  const { db } = await import('./db/client');
  const { leads } = await import('./db/schema/leads');
  const [lead] = await db
    .select({ ownerId: leads.ownerId, unitId: leads.unitId })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  const donoPermitido = escopo.veTudo || lead?.ownerId === escopo.ownerId;
  const unidadePermitida = !unidadeRestrita || !lead?.unitId || lead.unitId === unidadeRestrita;
  if (lead && donoPermitido && unidadePermitida) return { ok: true };
  return {
    response: NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 }),
  };
}

/**
 * Fecha uma rota que só faz sentido para quem enxerga o time inteiro.
 *
 * Dashboard e ranking somam TODOS os leads. Escopá-los por dono daria números
 * certos, mas seria um monte de consulta reescrita para entregar uma tela que
 * o BDR nem deveria abrir; e cada consulta esquecida vira vazamento. Recusar a
 * rota inteira é a decisão fechada — a tela some do menu e a URL responde 403.
 *
 * Quando o módulo está desligado (todo cliente de atendimento), não muda nada.
 */
export function exigirVisaoDeTime(
  usuario: Pick<AuthedRequestUser, 'id' | 'role'>
): { ok: true } | { response: NextResponse } {
  if (escopoDono(usuario).veTudo) return { ok: true };
  return {
    response: NextResponse.json(
      { error: 'Esta tela mostra os números do time inteiro' },
      { status: 403 }
    ),
  };
}

/**
 * Este usuário pode mexer NESTA conexão?
 *
 * Vale para ler o QR code, checar status e desconectar. O QR é o caso grave:
 * quem o lê passa a receber as mensagens daquele número, então deixar a rota
 * aberta seria pior do que mostrar a conexão na lista.
 */
export async function garantirAcessoAConexao(
  usuario: Pick<AuthedRequestUser, 'id' | 'role' | 'unitId'>,
  connectionId: string
): Promise<{ ok: true } | { response: NextResponse }> {
  const escopo = escopoDono(usuario);
  const unidadeRestrita = unidadesAtivas() ? usuario.unitId : null;
  if (escopo.veTudo && !unidadeRestrita) return { ok: true };

  const { db } = await import('./db/client');
  const { connections } = await import('./db/schema/connections');
  const [con] = await db
    .select({ ownerId: connections.ownerId, unitId: connections.unitId })
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  const donoPermitido = escopo.veTudo || con?.ownerId === escopo.ownerId;
  const unidadePermitida = !unidadeRestrita || !con?.unitId || con.unitId === unidadeRestrita;
  if (con && donoPermitido && unidadePermitida) return { ok: true };
  return {
    response: NextResponse.json({ error: 'Conexão não encontrada' }, { status: 404 }),
  };
}

/**
 * Este usuário pode mexer NESTA mensagem?
 *
 * Mesma porta do lead, um salto atrás: a mensagem sabe a qual lead pertence, e
 * é o dono do lead que manda. Sem isto, apagar ou editar mensagem de uma
 * conversa alheia seria uma chamada com um id na URL.
 */
export async function garantirAcessoAMensagem(
  usuario: Pick<AuthedRequestUser, 'id' | 'role' | 'unitId'>,
  messageId: string
): Promise<{ ok: true } | { response: NextResponse }> {
  const escopo = escopoDono(usuario);
  const unidadeRestrita = unidadesAtivas() ? usuario.unitId : null;
  if (escopo.veTudo && !unidadeRestrita) return { ok: true };

  const { db } = await import('./db/client');
  const { messages } = await import('./db/schema/messages');
  const [msg] = await db
    .select({ leadId: messages.leadId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);

  if (!msg) {
    return { response: NextResponse.json({ error: 'Mensagem não encontrada' }, { status: 404 }) };
  }
  return garantirAcessoAoLead(usuario, msg.leadId);
}

/**
 * Como o papel se chama NESTA instalação.
 *
 * O papel no banco continua sendo `attendant` nas sete instalações — renomear
 * o enum exigiria migração em todas e quebraria os clientes de atendimento,
 * para quem "atendente" é a palavra certa. O que muda é só a etiqueta.
 */
export function rotuloDoPapel(role: string): string {
  if (role === 'admin') return 'Administrador';
  return process.env.ROLE_ATTENDANT_LABEL?.trim() || 'Atendente';
}
