/**
 * GET /api/dashboard/repetition-check?text=... — quantas vezes uma mensagem
 * idêntica já saiu (outbound) nas últimas horas. Alimenta o alerta anti-ban do
 * composer do CRM ("essa mensagem já saiu X vezes").
 *
 * Aberto a qualquer atendente autenticado (precisa no composer). Conta tanto
 * envios pelo CRM quanto pelo celular (owner echo entra como outbound).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { exigirVisaoDeTime } from '@/lib/escopo-dono';
import { countRecentIdenticalOutbound } from '@/modules/quick-replies';

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;
  const visao = exigirVisaoDeTime(guard.user);
  if ('response' in visao) return visao.response;

  const text = new URL(req.url).searchParams.get('text') ?? '';
  if (!text.trim()) return NextResponse.json({ count: 0, windowHours: 0 });

  const result = await countRecentIdenticalOutbound(text);
  return NextResponse.json(result);
}
