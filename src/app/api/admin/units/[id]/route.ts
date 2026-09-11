/**
 * PATCH  /api/admin/units/[id] — edita a unidade
 * DELETE /api/admin/units/[id] — DESATIVA (nunca apaga)
 *
 * Não existe exclusão: leads, mensagens e conversões da filial fechada
 * continuam no histórico, e apagar a linha os deixaria apontando para nada.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { atualizarUnidade, desativarUnidade, usoDaUnidade } from '@/modules/units/service';

export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  let body: { name?: string; slug?: string; description?: string | null; active?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const unidade = await atualizarUnidade(id, body);
  if (!unidade) return NextResponse.json({ error: 'unidade não encontrada' }, { status: 404 });
  return NextResponse.json({ unit: unidade });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const { id } = await params;
  const uso = await usoDaUnidade(id);
  const unidade = await desativarUnidade(id);
  if (!unidade) return NextResponse.json({ error: 'unidade não encontrada' }, { status: 404 });

  // Devolve o que ficou pendurado nela: o admin precisa saber que há leads sem
  // dono antes de sair da tela achando que "removeu".
  return NextResponse.json({ unit: unidade, uso });
}
