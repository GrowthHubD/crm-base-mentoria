/**
 * Traz para o CRM os e-mails que chegaram nas caixas conectadas.
 *
 * Remetente que já tem lead cai no lead dele. Remetente novo **vira um lead**,
 * com canal `email` — do contrário um contato que responde por e-mail sumia
 * sem deixar rastro na tela, e quem mandou não recebia sinal nenhum.
 *
 * A regra anterior era só anexar ao que já existia, para o funil não encher de
 * newsletter e nota fiscal. Essa preocupação continua de pé e é resolvida por
 * `pareceRobo`, não por descartar tudo: promoções e redes sociais já ficam de
 * fora pela consulta ao Gmail, e o que sobra é filtrado pelos cabeçalhos de
 * envio em massa e pelos endereços que existem só para não receber resposta.
 */
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { emailAccounts } from '@/lib/db/schema/email-accounts';
import { colunaDeEntrada } from '@/modules/pipeline/stages';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { logger } from '@/lib/logger';
import { inboxFromAccount } from './service';

/**
 * Caixas que não são de gente: notificação, cobrança, robô de sistema.
 *
 * Só a parte antes do `@`, e como palavra inteira delimitada por `.`, `-` ou
 * `_`. Casar por substring solta transformaria `bruno@` em robô por causa do
 * "no" e `marcos.alerta@` por causa de "alerta".
 */
const ROBO = [
  'no-reply', 'noreply', 'do-not-reply', 'donotreply', 'nao-responda', 'naoresponda',
  'mailer-daemon', 'postmaster', 'bounce', 'bounces', 'notification', 'notifications',
  'notificacao', 'notificacoes', 'alerts', 'automated', 'automatico', 'newsletter',
  'news', 'mailer', 'daemon', 'robot', 'bot',
  // Furo real em produção: `welcome@supabase.com` virou lead no funil do Acme
  // (e-mail transacional SEM os cabeçalhos de massa — o sinal forte falhou e a
  // lista era a única defesa). Endereços que existem só para onboarding e
  // cobrança; nenhum humano prospectável escreve DE um destes.
  'welcome', 'onboarding', 'billing', 'invoice', 'invoices', 'receipt', 'receipts',
  'updates', 'digest', 'verify', 'verification', 'accounts', 'account',
];

/** O endereço é de robô? Olha só o local-part, em pedaços. */
export function pareceRobo(endereco: string): boolean {
  const local = endereco.split('@')[0]?.toLowerCase() ?? '';
  if (ROBO.includes(local)) return true;
  // `no-reply.suporte@`, `empresa_notificacoes@`: quebra nos separadores e
  // remonta pares, para pegar tanto "noreply" quanto "no" + "reply".
  const partes = local.split(/[._-]+/).filter(Boolean);
  for (let i = 0; i < partes.length; i++) {
    if (ROBO.includes(partes[i])) return true;
    if (i + 1 < partes.length && ROBO.includes(partes[i] + partes[i + 1])) return true;
    if (i + 1 < partes.length && ROBO.includes(`${partes[i]}-${partes[i + 1]}`)) return true;
  }
  return false;
}

/** Nome de exibição do remetente: `"Fulano <a@b.com>"` → `Fulano`. */
export function extrairNome(header: string): string | null {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(header);
  const nome = m?.[1]?.trim();
  return nome && nome.length > 0 ? nome : null;
}

/** `"Fulano <a@b.com>"` → `a@b.com`. O Gmail devolve o cabeçalho cru. */
export function extrairEndereco(header: string): string | null {
  const comNome = /<([^>]+)>/.exec(header);
  const bruto = (comNome ? comNome[1] : header).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bruto) ? bruto : null;
}

export interface ResultadoSync {
  contas: number;
  mensagens: number;
  anexadas: number;
  /** Leads abertos agora, por remetente que ainda não estava no CRM. */
  criados: number;
  /** Mensagens de máquina (newsletter, no-reply, bounce) que não viraram lead. */
  robos: number;
  erros: number;
}


/**
 * Varre as contas ativas e anexa aos leads o que chegou.
 *
 * Chamado pelo `/api/cron/tick`. Uma conta que falha não interrompe as outras:
 * é comum uma pessoa revogar o acesso e as demais seguirem funcionando.
 */
export async function syncTodasAsContas(opts: { maxPorConta?: number } = {}): Promise<ResultadoSync> {
  const r: ResultadoSync = { contas: 0, mensagens: 0, anexadas: 0, criados: 0, robos: 0, erros: 0 };

  // Uma consulta por passada, não uma por mensagem: o funil não muda no meio
  // de um tick.
  const stageEntrada = await colunaDeEntrada();

  const contas = await db
    .select({ id: emailAccounts.id, userId: emailAccounts.userId, email: emailAccounts.email })
    .from(emailAccounts)
    .where(eq(emailAccounts.active, true));

  for (const conta of contas) {
    r.contas += 1;
    try {
      const msgs = await inboxFromAccount(conta.userId, conta.id, {
        max: opts.maxPorConta ?? 15,
        // `newer_than:1d` evita reprocessar a caixa inteira a cada tick — a
        // deduplicação por `external_id` já protegeria, mas custaria uma
        // chamada por mensagem antiga, toda vez, para sempre.
        query: 'in:inbox -category:promotions -category:social newer_than:1d',
      });

      for (const m of msgs) {
        r.mensagens += 1;
        const remetente = extrairEndereco(m.from);
        if (!remetente) continue;

        // A própria conta se escrevendo (cópia, encaminhamento) não é lead.
        if (remetente === conta.email.toLowerCase()) continue;

        const [lead] = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(isNotNull(leads.email), sql`lower(${leads.email}) = ${remetente}`))
          .limit(1);

        let leadId: string | null = lead?.id ?? null;

        if (!leadId) {
          // Só aqui o filtro de robô importa. Se o endereço JÁ é um lead, é
          // porque alguém do time o pôs lá — não cabe ao filtro discordar.
          if (m.bulk || pareceRobo(remetente)) {
            r.robos += 1;
            continue;
          }
          leadId = await criarLeadDeEmail(remetente, extrairNome(m.from), stageEntrada, conta.userId);
          if (!leadId) continue;
          r.criados += 1;
        }

        const novo = await anexarAoLead(leadId, m, conta.email);
        if (novo) r.anexadas += 1;
      }

      // 2º passo: a pasta ENVIADOS.
      //
      // O gerente precisa ver o que o BDR mandou, mesmo quando o BDR responde
      // DIRETO pelo Gmail (é o hábito real, não pelo card do CRM). É o
      // equivalente ao `fromMe` do WhatsApp, que já é capturado. Sem isto, todo
      // e-mail escrito no Gmail some do CRM.
      //
      // O que vale aqui é o DESTINATÁRIO (`to`), não o remetente (que é a
      // própria caixa). A dedup por `gmail:<id>` garante que um envio feito
      // PELO card do CRM (já gravado) não entre de novo.
      const enviados = await inboxFromAccount(conta.userId, conta.id, {
        max: opts.maxPorConta ?? 15,
        query: 'in:sent newer_than:1d',
      });
      for (const m of enviados) {
        r.mensagens += 1;
        const destino = extrairEndereco(m.to);
        if (!destino) continue;
        // Enviou para si mesmo: não é lead.
        if (destino === conta.email.toLowerCase()) continue;

        const [lead] = await db
          .select({ id: leads.id })
          .from(leads)
          .where(and(isNotNull(leads.email), sql`lower(${leads.email}) = ${destino}`))
          .limit(1);

        let leadId: string | null = lead?.id ?? null;
        if (!leadId) {
          // Mesma proteção do inbound: não abre lead para no-reply/robô.
          if (pareceRobo(destino)) { r.robos += 1; continue; }
          leadId = await criarLeadDeEmail(destino, extrairNome(m.to), stageEntrada, conta.userId);
          if (!leadId) continue;
          r.criados += 1;
        }

        const novo = await anexarSaidaAoLead(leadId, m, conta.email);
        if (novo) r.anexadas += 1;
      }
    } catch (err) {
      r.erros += 1;
      logger.warn(
        { err: err instanceof Error ? err.message : err, conta: conta.email },
        '[email] sync da conta falhou — as outras seguem'
      );
    }
  }

  if (r.anexadas > 0 || r.erros > 0) {
    logger.info({ ...r }, '[email] sincronização concluída');
  }
  return r;
}

/**
 * Abre um lead para um remetente que ainda não estava no CRM.
 *
 * `externalContactId` é o próprio endereço: junto com `channel = 'email'` ele
 * cai no índice único que já existia para o WhatsApp, e é o que garante que
 * dois e-mails da mesma pessoa no mesmo tick não criem dois cards. Por isso o
 * `onConflictDoNothing` seguido de leitura, em vez de checar antes e inserir
 * depois — entre a checagem e a inserção cabe outra passada do cron.
 */
async function criarLeadDeEmail(
  endereco: string,
  nome: string | null,
  stageId: string | null,
  /** Dono da caixa que recebeu — o lead nasce pertencendo a esse BDR. */
  ownerId: string
): Promise<string | null> {
  try {
    const [criado] = await db
      .insert(leads)
      .values({
        channel: 'email',
        externalContactId: endereco,
        email: endereco,
        ownerId,
        // Sem nome no cabeçalho, o endereço é melhor rótulo que "Sem nome":
        // o atendente reconhece de quem é antes de abrir.
        name: nome ?? endereco,
        status: 'new',
        stageId,
      })
      .onConflictDoNothing()
      .returning({ id: leads.id });
    if (criado) return criado.id;

    // Perdeu a corrida: o lead é de outra passada, e serve igual.
    const [existente] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.channel, 'email'), eq(leads.externalContactId, endereco)))
      .limit(1);
    return existente?.id ?? null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, endereco },
      '[email] não consegui abrir lead para o remetente'
    );
    return null;
  }
}

/**
 * Grava a mensagem no histórico do lead.
 *
 * Idempotente pelo `external_id` (o id da mensagem no Gmail): reprocessar o
 * mesmo tick, ou um tick atrasado, não duplica nada — é o que permite o cron
 * rodar a cada 2 minutos sem medo.
 */
/**
 * Repara o corpo de uma mensagem já gravada quando o Gmail a devolve maior.
 *
 * Até 03/09 o CRM gravava só o `snippet` (~150 chars). A dedup por
 * `gmail:<id>` faz o reprocessamento devolver `isNew=false` e nunca tocar no
 * corpo — então os e-mails cortados ficariam cortados para sempre. Enquanto a
 * mensagem estiver na janela `newer_than:1d`, o tick a revê com `format=full`
 * e este UPDATE só alonga: nunca encurta, nunca mexe em quem já está inteiro.
 */
async function alongarCorpoSePreciso(externalId: string, corpo: string): Promise<void> {
  if (!corpo) return;
  try {
    await db.execute(sql`
      update messages set body = ${corpo}
      where external_id = ${externalId}
        and length(coalesce(body, '')) < ${corpo.length}
    `);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, externalId },
      '[email] não consegui alongar o corpo da mensagem'
    );
  }
}

async function anexarAoLead(
  leadId: string,
  m: { id: string; subject: string; snippet: string; body?: string; date: number },
  caixa: string
): Promise<boolean> {
  const { recordInboundMessage } = await import('@/modules/messages/service');

  // Assunto na primeira linha e o trecho embaixo, como num cliente de e-mail.
  // Sem markdown: o CRM não renderiza `**`, então o negrito que estava aqui
  // aparecia cru na tela — "**Reunião** vamos marcar?" no preview do card.
  //
  // Corpo completo (format=full); o snippet é só o fallback de mensagem sem texto.
  const texto = (m.body && m.body.trim()) || m.snippet;
  const corpo = m.subject ? `${m.subject}\n\n${texto}` : texto;

  try {
    const res = await recordInboundMessage({
      leadId,
      // Prefixo `gmail:` para o id nunca colidir com um id de WhatsApp — os
      // dois canais dividem a mesma tabela e o mesmo índice UNIQUE.
      externalId: `gmail:${m.id}`,
      body: corpo,
      type: 'text',
      timestamp: new Date(m.date),
      metadata: { canal: 'email', caixa, assunto: m.subject },
    });
    if (!res.isNew) await alongarCorpoSePreciso(`gmail:${m.id}`, corpo);
    return res.isNew;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId, gmailId: m.id },
      '[email] não consegui gravar a mensagem no lead'
    );
    return false;
  }
}

/**
 * Grava no lead um e-mail que SAIU da caixa (pasta Enviados).
 *
 * Espelho de `anexarAoLead` para o outbound. `recordOwnerOutbound` e não
 * `recordInbound`: a mensagem já saiu (foi enviada pela pessoa, no Gmail ou
 * pelo CRM), então é registro de saída, `sender = owner`. A dedup por
 * `gmail:<id>` faz um envio já gravado pelo card do CRM não duplicar aqui.
 */
async function anexarSaidaAoLead(
  leadId: string,
  m: { id: string; subject: string; snippet: string; body?: string; date: number },
  caixa: string
): Promise<boolean> {
  const { recordOwnerOutbound } = await import('@/modules/messages/service');
  // Corpo completo (format=full); o snippet é só o fallback de mensagem sem texto.
  const texto = (m.body && m.body.trim()) || m.snippet;
  const corpo = m.subject ? `${m.subject}\n\n${texto}` : texto;
  try {
    const res = await recordOwnerOutbound({
      leadId,
      externalId: `gmail:${m.id}`,
      body: corpo,
      type: 'text',
      timestamp: new Date(m.date),
      metadata: { canal: 'email', caixa, assunto: m.subject, origem: 'sent-sync' },
    });
    if (!res.isNew) await alongarCorpoSePreciso(`gmail:${m.id}`, corpo);
    return res.isNew;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId, gmailId: m.id },
      '[email] não consegui gravar a saída no lead'
    );
    return false;
  }
}
