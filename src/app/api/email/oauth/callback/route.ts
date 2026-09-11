/**
 * GET /api/email/oauth/callback — a volta do Google.
 *
 * Aqui a pessoa está sendo redirecionada pelo navegador, não fazendo uma
 * chamada de API: por isso o retorno é sempre um REDIRECT para a tela de
 * e-mail, com o resultado no query string. Devolver JSON deixaria o usuário
 * olhando para um objeto no meio do navegador.
 *
 * A identidade de quem conecta vem do `state` assinado, e não da sessão do
 * cookie: o Google redireciona de volta num contexto que pode não carregar o
 * cookie (navegação cross-site), e confiar na sessão aqui faria a conexão
 * falhar de forma intermitente e inexplicável.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { connectGmail } from '@/modules/email/service';
import { GmailAuthError } from '@/modules/email/gmail-client';
import { verificarState, redirectUri } from '@/modules/email/oauth-state';
import { logger } from '@/lib/logger';

function voltar(req: NextRequest, params: Record<string, string>) {
  const base = process.env.NEXTAUTH_URL || new URL(req.url).origin;
  const u = new URL('/configuracoes/email', base);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return NextResponse.redirect(u.toString());
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const erroGoogle = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  // A pessoa clicou em "Cancelar" na tela do Google. Não é falha do sistema.
  if (erroGoogle) {
    return voltar(req, { erro: erroGoogle === 'access_denied' ? 'Autorização cancelada.' : erroGoogle });
  }
  if (!code || !state) {
    return voltar(req, { erro: 'Resposta incompleta do Google.' });
  }

  const payload = state ? verificarState(state) : null;
  if (!payload) {
    logger.warn({}, '[email] state inválido no callback — possível tentativa de forjar identidade');
    return voltar(req, { erro: 'Autorização inválida. Tente conectar de novo.' });
  }

  const userId = payload.split(':')[0];
  if (!userId) return voltar(req, { erro: 'Autorização inválida.' });

  try {
    const conta = await connectGmail({ userId, code, redirectUri: redirectUri(new URL(req.url).origin) });
    return voltar(req, { ok: conta.email });
  } catch (err) {
    const msg =
      err instanceof GmailAuthError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Erro ao conectar';
    logger.error({ err: msg, userId }, '[email] falha ao concluir a conexão');
    return voltar(req, { erro: msg });
  }
}
