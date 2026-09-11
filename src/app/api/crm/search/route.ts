/**
 * GET /api/crm/search?q=<termo>&connectionId=<id> — busca conversas por nome,
 * telefone OU conteúdo das mensagens (o que foi dito no chat). Diferente do
 * filtro client-side do kanban, esta varre o banco e cobre todos os status.
 * Retorna { results } (ver ConversationSearchResult).
 */
import { NextRequest, NextResponse } from 'next/server';
import { searchConversations } from '@/modules/pipeline/queries';
import { requireSession } from '@/lib/auth-helpers';
import { escopoDono } from '@/lib/escopo-dono';
import { escopoDaRequisicao, unidadeSelecionada } from '@/lib/units';
import type { LeadChannel } from '@/modules/leads/types';

export async function GET(req: NextRequest) {
  const startedAt = performance.now();
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') ?? '').trim();
  const connectionId = url.searchParams.get('connectionId') ?? undefined;
  const channelParam = url.searchParams.get('channel');
  const channel: LeadChannel | undefined = channelParam === 'email' ? 'email' : undefined;
  if (q.length < 2) return NextResponse.json({ results: [] });

  // A busca cobre TODOS os status, inclusive os que saíram do quadro. Sem o
  // recorte por dono ela seria a rota mais fácil de usar para ler a conversa
  // de outro BDR — basta procurar por uma palavra.
  const dono = escopoDono(guard.user);
  const unidade = escopoDaRequisicao(guard.user, unidadeSelecionada(req));
  const queryStartedAt = performance.now();
  const results = await searchConversations(
    { connectionId, ownerId: dono.ownerId, unitId: unidade.unitId, channel },
    q
  );
  const response = NextResponse.json({ results });
  response.headers.set(
    'Server-Timing',
    `crm-search;dur=${(performance.now() - queryStartedAt).toFixed(1)}, total;dur=${(performance.now() - startedAt).toFixed(1)}`
  );
  return response;
}
