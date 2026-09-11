/**
 * GET /api/email/oauth/start — manda a pessoa para a tela do Google.
 *
 * O `state` carrega o id de quem está conectando, assinado — ver
 * `modules/email/oauth-state.ts` para o porquê de ele não poder ser forjável.
 */
import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { requireSession } from '@/lib/auth-helpers';
import { buildAuthUrl, isGmailConfigured } from '@/modules/email/gmail-client';
import { assinarState, redirectUri } from '@/modules/email/oauth-state';

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  if (!isGmailConfigured()) {
    return NextResponse.json(
      { error: 'E-mail não configurado neste deploy (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' },
      { status: 500 }
    );
  }

  // `nonce` para o state nunca se repetir entre duas conexões da mesma pessoa.
  const nonce = crypto.randomBytes(8).toString('hex');
  const state = assinarState(`${guard.user.id}:${nonce}`);

  return NextResponse.redirect(
    buildAuthUrl({ redirectUri: redirectUri(new URL(req.url).origin), state })
  );
}
