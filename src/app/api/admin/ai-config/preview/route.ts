/**
 * GET /api/admin/ai-config/preview — retorna o prompt efetivo (system + user
 * exemplo) que vai pro LLM, compilado com a config atual (singleton).
 *
 * Útil pro admin enxergar o template completo que o agente usa quando responde.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { buildPreviewPrompt } from '@/modules/ai-agent/service';

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const preview = await buildPreviewPrompt();
  return NextResponse.json(preview);
}
