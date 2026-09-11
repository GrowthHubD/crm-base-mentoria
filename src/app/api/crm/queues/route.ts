/**
 * GET /api/crm/queues — dados pro CRM kanban (4 filas + connections).
 * ?connectionId=<id>       filtra por uma connection específica.
 * ?includeConnections=0    poll leve: só as filas, sem connections/caixas.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getKanbanData, listActiveConnections } from '@/modules/pipeline/queries';
import { requireSession } from '@/lib/auth-helpers';
import { escopoDaRequisicao, unidadeSelecionada } from '@/lib/units';
import { escopoDono } from '@/lib/escopo-dono';
import { db } from '@/lib/db/client';
import { emailAccounts } from '@/lib/db/schema/email-accounts';
import { and, eq } from 'drizzle-orm';

export async function GET(req: NextRequest) {
  const startedAt = performance.now();
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const url = new URL(req.url);
  const connectionId = url.searchParams.get('connectionId') ?? undefined;
  const includeConnections = url.searchParams.get('includeConnections') !== '0';

  // O recorte de unidade sai da SESSÃO, não do que a tela pediu. Atendente
  // preso a uma filial tem o cabeçalho ignorado — ver `lib/units.ts`.
  const escopo = escopoDaRequisicao(guard.user, unidadeSelecionada(req));
  // Recorte por DONO — de quem é a conversa. Sai da sessão pelo mesmo motivo
  // que o de unidade: o que o navegador manda é preferência, não credencial.
  const dono = escopoDono(guard.user);

  const readStartedAt = performance.now();
  const readFilter = {
    connectionId,
    unitId: escopo.unitId,
    ownerId: dono.ownerId,
  };

  // Caixas de e-mail conectadas, para o CRM montar UMA aba por caixa (igual ao
  // WhatsApp tem uma por número). Lead de e-mail não tem `connection_id`: a
  // ligação com a caixa é o DONO (a conta é por usuário), então cada aba filtra
  // `channel = email` + `owner_id = userId` no cliente. Mesmo recorte das
  // conexões (admin vê todas, BDR só a própria) e só no poll "cheio".
  const lerCaixas = () =>
    db
      .select({ id: emailAccounts.id, email: emailAccounts.email, userId: emailAccounts.userId })
      .from(emailAccounts)
      .where(
        dono.ownerId
          ? and(eq(emailAccounts.active, true), eq(emailAccounts.userId, dono.ownerId))
          : eq(emailAccounts.active, true)
      );

  const [queues, connections, caixas] = includeConnections
    ? await Promise.all([
        getKanbanData(readFilter),
        listActiveConnections({ ownerId: dono.ownerId, unitId: escopo.unitId }),
        lerCaixas(),
      ])
    : [await getKanbanData(readFilter), undefined, undefined];

  const response = NextResponse.json(
    connections ? { queues, connections, emailAccounts: caixas } : { queues }
  );
  response.headers.set(
    'Server-Timing',
    `crm-read;dur=${(performance.now() - readStartedAt).toFixed(1)}, total;dur=${(performance.now() - startedAt).toFixed(1)}`
  );
  return response;
}
