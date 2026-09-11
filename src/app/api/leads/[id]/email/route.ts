/**
 * POST /api/leads/[id]/email — envia um e-mail para o contato deste lead.
 *
 * O envio é o que CRIA O VÍNCULO: ao mandar, o endereço fica gravado em
 * `leads.email`, e é por ele que a resposta do cliente vai encontrar este lead
 * quando o cron passar. Sem isso, o e-mail que chegasse não teria onde cair —
 * foi o que aconteceu no primeiro teste de recebimento.
 *
 * A mensagem enviada entra no mesmo histórico do WhatsApp, para o atendente ver
 * a conversa inteira num lugar só, em ordem.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAoLead } from '@/lib/escopo-dono';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { eq } from 'drizzle-orm';
import { sendFromAccount, listAccounts } from '@/modules/email/service';
import { GmailAuthError } from '@/modules/email/gmail-client';
import { recordOwnerOutbound } from '@/modules/messages/service';
import { logger } from '@/lib/logger';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id: leadId } = await params;
  const acesso = await garantirAcessoAoLead(guard.user, leadId);
  if ('response' in acesso) return acesso.response;

  let body: { para?: unknown; assunto?: unknown; texto?: unknown; contaId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const assunto = String(body.assunto ?? '').trim();
  const texto = String(body.texto ?? '').trim();
  if (!assunto) return NextResponse.json({ error: 'Informe o assunto' }, { status: 400 });
  if (!texto) return NextResponse.json({ error: 'Escreva a mensagem' }, { status: 400 });

  const [lead] = await db
    .select({ id: leads.id, email: leads.email })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return NextResponse.json({ error: 'Lead não encontrado' }, { status: 404 });

  // Destinatário: o que veio no corpo, ou o que já está na ficha do lead.
  const para = String(body.para ?? lead.email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(para)) {
    return NextResponse.json({ error: 'Informe um e-mail válido para o contato' }, { status: 400 });
  }

  // De qual caixa. Sem `contaId`, usa a primeira conta ativa de quem está
  // enviando — o caso comum é a pessoa ter só a dela.
  // Envio SEMPRE sai da caixa do próprio remetente — nunca veTudo aqui, senão
  // um admin cairia na primeira caixa de qualquer um. Escopo próprio.
  const contas = await listAccounts({ userId: guard.user.id, veTudo: false });
  const ativas = contas.filter((c) => c.active);
  if (ativas.length === 0) {
    return NextResponse.json(
      { error: 'Conecte uma conta de e-mail em Configurações → E-mail antes de enviar.' },
      { status: 400 }
    );
  }
  const conta =
    (typeof body.contaId === 'string' && ativas.find((c) => c.id === body.contaId)) || ativas[0];

  try {
    const enviado = await sendFromAccount(guard.user.id, conta.id, {
      to: para,
      subject: assunto,
      text: texto,
    });

    // Grava o endereço no lead — é isto que faz a resposta voltar para cá.
    if (lead.email?.toLowerCase() !== para) {
      await db.update(leads).set({ email: para, updatedAt: new Date() }).where(eq(leads.id, leadId));
    }

    // Entra no histórico junto com as mensagens de WhatsApp.
    // `recordOwnerOutbound` e não `recordPendingOutbound`: a mensagem JÁ SAIU
    // pelo Gmail — não há fila para entregá-la depois, e registrar como
    // pendente deixaria um envio eternamente "aguardando".
    await recordOwnerOutbound({
      leadId,
      externalId: enviado.messageId ? `gmail:${enviado.messageId}` : null,
      // Sem markdown: o CRM não renderiza `**`, e o negrito aparecia cru na
      // tela. Assunto na primeira linha, como num cliente de e-mail.
      body: `${assunto}\n\n${texto}`,
      type: 'text',
      sentById: guard.user.id,
      metadata: { canal: 'email', para, de: conta.email, assunto },
    }).catch((err: unknown) => {
      // O e-mail JÁ SAIU. Falhar aqui não pode virar erro para quem enviou —
      // seria um "erro" que faz a pessoa mandar de novo e o cliente receber
      // duas vezes.
      logger.error(
        { err: err instanceof Error ? err.message : err, leadId },
        '[email] enviado, mas não consegui gravar no histórico'
      );
    });

    return NextResponse.json({ ok: true, messageId: enviado.messageId, de: conta.email, para });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro ao enviar';
    logger.error({ err: msg, leadId, contaId: conta.id }, '[email] envio falhou');
    return NextResponse.json(
      { error: msg },
      { status: err instanceof GmailAuthError ? 401 : 502 }
    );
  }
}
