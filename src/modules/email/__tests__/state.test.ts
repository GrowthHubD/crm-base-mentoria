/**
 * O `state` do OAuth é a identidade de quem está conectando.
 *
 * O callback do Google não tem sessão confiável (o cookie pode não vir numa
 * volta cross-site), então quem diz "esta conta é do usuário X" é o `state`. Se
 * ele fosse forjável, bastaria trocar o id para ligar a SUA caixa de e-mail à
 * conta de outra pessoa no CRM — e todo e-mail dela sairia pela sua.
 *
 * Por isso ele é assinado, e por isso a comparação é em tempo constante.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { assinarState, verificarState } from '../oauth-state';

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = 'segredo-de-teste-nao-usar-em-producao';
});

describe('state do OAuth', () => {
  it('vai e volta preservando o conteúdo', () => {
    const s = assinarState('user-123:abc');
    expect(verificarState(s)).toBe('user-123:abc');
  });

  it('recusa assinatura trocada', () => {
    const s = assinarState('user-123:abc');
    const [corpo] = s.split('.');
    expect(verificarState(`${corpo}.assinaturaerrada`)).toBeNull();
  });

  it('recusa corpo adulterado com a assinatura original', () => {
    // O ataque que importa: pegar um state válido e trocar o id do usuário.
    const s = assinarState('user-123:abc');
    const [, mac] = s.split('.');
    const outroCorpo = Buffer.from('user-999:abc').toString('base64url');
    expect(verificarState(`${outroCorpo}.${mac}`)).toBeNull();
  });

  it('recusa state sem separador', () => {
    expect(verificarState('semponto')).toBeNull();
  });

  it('recusa string vazia', () => {
    expect(verificarState('')).toBeNull();
  });

  it('states de conexões diferentes não se repetem', () => {
    // O nonce entra fora daqui, mas o formato precisa suportar: dois payloads
    // diferentes têm de gerar assinaturas diferentes.
    expect(assinarState('user-1:aaa')).not.toBe(assinarState('user-1:bbb'));
  });
});
