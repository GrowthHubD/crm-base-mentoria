/**
 * Tradução do estado da Evolution para o status da connection.
 *
 * Este teste existe por um bug que só apareceu em produção: o número do cliente
 * conectado e o CRM mostrando "Desconectado" — com o telefone certo na tela.
 *
 * A causa era a fonte do estado, não o mapeamento. Medido na mesma instância,
 * comprovadamente ligada:
 *
 *   GET /instance/connectionState (key global)     -> "close"
 *   GET /instance/connectionState (key da instância) -> "connecting"
 *   GET /instance/fetchInstances                    -> "open" + ownerJid
 *
 * Por isso `instanceStatus()` lê o `fetchInstances`, e o `ownerJid` é a
 * confirmação: ele só existe depois que a sessão do WhatsApp está de pé.
 */
import { describe, it, expect } from 'vitest';
import { mapConnectionState } from '../provider';

describe('mapConnectionState', () => {
  it('open = conectado — é o que o fetchInstances devolve com a sessão de pé', () => {
    expect(mapConnectionState('open')).toBe('connected');
  });

  it('connecting = ainda esperando o QR', () => {
    expect(mapConnectionState('connecting')).toBe('qr_pending');
  });

  it('close = desconectado', () => {
    expect(mapConnectionState('close')).toBe('disconnected');
  });

  it('não diferencia maiúsculas', () => {
    expect(mapConnectionState('OPEN')).toBe('connected');
    expect(mapConnectionState('Connecting')).toBe('qr_pending');
  });

  it('estado desconhecido cai em desconectado, não em conectado', () => {
    // Ao contrário, um valor novo do provedor faria a tela dizer que está tudo
    // certo com um número que não envia nada.
    expect(mapConnectionState('coisa-nova')).toBe('disconnected');
  });

  it('null e undefined não viram conectado', () => {
    expect(mapConnectionState(null)).toBe('disconnected');
    expect(mapConnectionState(undefined)).toBe('disconnected');
  });
});
