/**
 * POST /api/admin/quick-replies/generate-variations — gera N paráfrases de um
 * texto via IA, pro admin cadastrar como variações do atalho (anti-ban).
 * Body: { text: string, count?: number }. Retorna { variations: string[] }.
 *
 * Liberado pra qualquer membro da unidade (mesma porta do CRUD de atalhos). Não
 * persiste nada — só devolve as sugestões; o atendente revisa e salva via
 * PUT/POST do atalho.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { generateVariations } from '@/modules/quick-replies';

export async function POST(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  let payload: { text?: string; count?: number };
  try {
    payload = (await req.json()) as { text?: string; count?: number };
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const text = (payload.text ?? '').trim();
  if (!text) return NextResponse.json({ error: 'texto vazio' }, { status: 400 });

  const { variations, fallback } = await generateVariations(text, payload.count ?? 4);
  if (fallback && variations.length === 0) {
    return NextResponse.json(
      { error: 'não foi possível gerar variações agora (IA indisponível). Tente de novo.' },
      { status: 503 }
    );
  }
  return NextResponse.json({ variations });
}
