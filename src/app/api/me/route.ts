/**
 * GET /api/me — retorna info básica do usuário logado pro client.
 *
 * Útil pra páginas client ('use client') que precisam decidir UI por role
 * (ex: esconder botão de cadastro pra atendente).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { escopoDono } from '@/lib/escopo-dono';
import { cardsSoPorArraste } from '@/modules/pipeline/modo';

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  return NextResponse.json({
    id: guard.user.id,
    name: guard.user.name,
    email: guard.user.email,
    role: guard.user.role,
    // Se esta pessoa enxerga o time inteiro ou só a carteira dela. As telas
    // client usam para decidir o que mostrar — a decisão de ACESSO continua
    // sendo de cada rota do servidor.
    veTudo: escopoDono(guard.user).veTudo,
    // Modo funil (arraste): a tela do lead esconde as ações de ATENDIMENTO
    // (IA, Resolvido, Converti!, Urgência) — que não fazem sentido num CRM de
    // prospecção, onde o card anda por arraste. Ver `pipeline/modo.ts`.
    kanbanManual: cardsSoPorArraste(),
  });
}
