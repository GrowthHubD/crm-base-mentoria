/**
 * GET /api/connections/providers — que servidores de WhatsApp ESTE deploy tem.
 *
 * Existe porque a alternativa não funciona: `NEXT_PUBLIC_*` é substituído no
 * momento do build, e o bundle é um só para todos os clientes. Marcar a
 * disponibilidade por lá faria o seletor aparecer em TODAS as instalações,
 * inclusive nas que só falam uazapi — e some a diferença que o env por cliente
 * existe para manter.
 *
 * Runtime, portanto: cada Worker responde pelo que ele mesmo tem configurado.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { requireSession } from '@/lib/auth-helpers';
import { isEvolutionConfigured } from '@/modules/channels/whatsapp/evolution/provisioning';

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  const uazapi = Boolean(process.env.UAZAPI_ADMIN_TOKEN || process.env.UAZAPI_TOKEN);
  const evolution = isEvolutionConfigured();

  return NextResponse.json({
    providers: {
      uazapi,
      evolution,
    },
    // Qual vem marcado. Com os dois, uazapi manda por ser o padrão histórico —
    // as instalações existentes não devem mudar de comportamento.
    padrao: uazapi ? 'uazapi' : evolution ? 'evolution' : null,
  });
}
