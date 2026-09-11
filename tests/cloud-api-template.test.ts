/**
 * Formato do template na Cloud API.
 *
 * O que este teste protege é o que a Meta rejeita em silêncio ou entrega
 * errado: parâmetros são POSICIONAIS ({{1}}, {{2}}), o código de idioma tem
 * que bater exatamente com o cadastrado, e template não aceita `context`
 * (citar mensagem) — incluir o campo derruba a chamada inteira.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { sendTemplate } = await import('@/modules/channels/whatsapp/cloud-api/client');

const creds = {
  phoneNumberId: '109876543210987',
  accessToken: 'token-de-teste',
} as Parameters<typeof sendTemplate>[0];

function lastBody(): Record<string, unknown> {
  return JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string);
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ messages: [{ id: 'wamid.ABC' }] }),
  });
});

describe('sendTemplate', () => {
  it('monta name + language e devolve o wamid', async () => {
    const result = await sendTemplate(creds, '5511999998888', 'retomada_24h', 'pt_BR');
    const body = lastBody();

    expect(body.type).toBe('template');
    expect((body.template as Record<string, unknown>).name).toBe('retomada_24h');
    expect((body.template as { language: { code: string } }).language.code).toBe('pt_BR');
    expect(result.message_id).toBe('wamid.ABC');
  });

  it('mantém a ORDEM dos parâmetros do corpo — {{1}}, {{2}}', async () => {
    await sendTemplate(creds, '5511999998888', 'retomada_24h', 'pt_BR', {
      body: ['Marina', 'o orçamento'],
    });
    const comps = (lastBody().template as { components: Array<{ type: string; parameters: Array<{ text: string }> }> }).components;
    const bodyComp = comps.find(c => c.type === 'body')!;

    expect(bodyComp.parameters.map(p => p.text)).toEqual(['Marina', 'o orçamento']);
  });

  it('omite components quando não há variável — template fixo', async () => {
    await sendTemplate(creds, '5511999998888', 'aviso_simples', 'pt_BR');
    expect(lastBody().template).not.toHaveProperty('components');
  });

  it('NUNCA manda context: a Meta rejeita template com citação', async () => {
    await sendTemplate(creds, '5511999998888', 'retomada_24h', 'pt_BR', { body: ['x'] });
    expect(lastBody()).not.toHaveProperty('context');
  });
});
