/**
 * GET  /api/admin/units — lista as unidades do cliente
 * POST /api/admin/units — cria uma unidade
 *
 * Admin apenas. O gating de PLANO (FEATURE_UNITS) é aplicado no middleware,
 * então um cliente sem o módulo recebe 404 aqui — não 403: para quem não
 * contratou, unidades não existem.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { listarUnidades, criarUnidade } from '@/modules/units/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const incluirInativas = new URL(req.url).searchParams.get('todas') === '1';
  return NextResponse.json({ units: await listarUnidades(incluirInativas) });
}

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let body: { name?: string; slug?: string; description?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const name = body.name?.trim();
  if (!name) return NextResponse.json({ error: 'nome obrigatório' }, { status: 400 });

  try {
    const unidade = await criarUnidade({
      name,
      slug: body.slug?.trim() || name,
      description: body.description ?? null,
    });
    return NextResponse.json({ unit: unidade }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Slug é UNIQUE: duas filiais com o mesmo apelido é erro do usuário, não do
    // sistema, e merece mensagem que diz o que fazer.
    if (/unique|duplicate|23505/i.test(msg)) {
      return NextResponse.json({ error: 'já existe uma unidade com esse identificador' }, { status: 409 });
    }
    throw err;
  }
}
