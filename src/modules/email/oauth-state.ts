/**
 * O `state` do OAuth — a identidade de quem está conectando a caixa.
 *
 * Vive fora do `route.ts` porque o Next não deixa um arquivo de rota exportar
 * nada além dos handlers (`GET`, `POST`…): qualquer export a mais quebra o
 * build com um erro de tipo obscuro sobre `OmitWithTag`.
 *
 * Por que assinado: o callback do Google não tem sessão confiável — a volta é
 * cross-site e o cookie pode não vir. Quem diz "esta conta é do usuário X" é o
 * `state`. Se fosse forjável, bastaria trocar o id nele para ligar a SUA caixa
 * de e-mail à conta de outra pessoa, e todo e-mail dela sairia pela sua.
 */
import crypto from 'node:crypto';

function segredo(): string {
  // Reaproveita o secret da sessão: é o segredo que já existe em todo deploy e
  // que só o servidor conhece. Uma variável nova seria mais uma peça para
  // esquecer de configurar num cliente.
  const s = process.env.BETTER_AUTH_SECRET;
  if (!s) throw new Error('BETTER_AUTH_SECRET ausente — necessário para assinar o state');
  return s;
}

export function assinarState(payload: string): string {
  const mac = crypto.createHmac('sha256', segredo()).update(payload).digest('base64url');
  return `${Buffer.from(payload).toString('base64url')}.${mac}`;
}

/** Devolve o payload se a assinatura confere; `null` em qualquer outro caso. */
export function verificarState(state: string): string | null {
  const [corpo, mac] = state.split('.');
  if (!corpo || !mac) return null;

  const payload = Buffer.from(corpo, 'base64url').toString();
  const esperado = crypto.createHmac('sha256', segredo()).update(payload).digest('base64url');

  const a = Buffer.from(mac);
  const b = Buffer.from(esperado);
  // Comparação em tempo constante: comparar com `===` vazaria, pelo tempo de
  // resposta, quantos caracteres do início batem — o suficiente para descobrir
  // a assinatura byte a byte.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  return payload;
}

/** A URL que o Google chama de volta. Tem de bater com a cadastrada no Console. */
export function redirectUri(origin: string): string {
  const base = process.env.NEXTAUTH_URL || origin;
  return `${base.replace(/\/+$/, '')}/api/email/oauth/callback`;
}
