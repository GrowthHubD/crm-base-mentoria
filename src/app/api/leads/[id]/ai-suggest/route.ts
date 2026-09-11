/**
 * POST /api/leads/[id]/ai-suggest — gera DICA pro atendente humano.
 *
 * Importante: NÃO redige resposta pro cliente. Usa prompt separado (Suporte IA)
 * que orienta o atendente em 1ª pessoa. Configurável por admin via
 * ai_agent_config.support_system_prompt (default em modules/ai-agent/support.ts).
 *
 * Body: { question?: string }  // pergunta do atendente; se vazio, a IA olha o
 *                                histórico e sugere o próximo passo.
 * Returns: { advice: string, draft: string, fallback: boolean }
 *   advice = orientação pro atendente; draft = mensagem pronta pro cliente (''
 *   quando não há rascunho que faça sentido enviar).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { garantirAcessoAoLead } from '@/lib/escopo-dono';
import { generateSupportSuggestion } from '@/modules/ai-agent/support';
import { logger } from '@/lib/logger';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const { id: leadId } = await params;
  const acesso = await garantirAcessoAoLead(guard.user, leadId);
  if ('response' in acesso) return acesso.response;
  let body: { question?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const question = body.question?.trim() ?? '';

  try {
    const result = await generateSupportSuggestion(leadId, question);
    return NextResponse.json({
      advice: result.advice,
      draft: result.draft,
      fallback: result.fallback,
      // Compat: abas antigas (pré-deploy) liam `suggestion`/`transferred`;
      // mantemos pra não quebrar durante a janela de deploy.
      suggestion: result.advice,
      transferred: false,
      contextUsed: 0,
    });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err, leadId }, '[ai-suggest] falhou');
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro' },
      { status: 500 }
    );
  }
}
