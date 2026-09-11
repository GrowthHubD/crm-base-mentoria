/**
 * Garantia do persist-first: uma mensagem que falha ao entrar NÃO pode ser
 * dada como processada.
 *
 * A Cloud API nunca retransmite depois do nosso 200. Se `handleCloudEvents`
 * resolver com sucesso apesar de uma mensagem ter estourado, o evento é
 * marcado `done` e aquela mensagem some do mundo — o cliente perguntou e
 * ninguém nunca vê. Foi exatamente o que o `catch` original fazia: logava e
 * seguia. Este teste existe pra essa regressão não voltar em silêncio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ingestParsedInbound = vi.fn();
const getCloudConnection = vi.fn();

vi.mock('@/modules/channels/whatsapp/process-inbound', () => ({
  ingestParsedInbound: (...args: unknown[]) => ingestParsedInbound(...args),
}));
vi.mock('@/modules/channels/whatsapp/cloud-api/provider', () => ({
  getCloudConnection: (...args: unknown[]) => getCloudConnection(...args),
  findCloudConnectionByPhoneNumberId: vi.fn(async () => null),
  makeCloudMediaResolver: () => vi.fn(),
}));
vi.mock('@/modules/channels/whatsapp/cloud-api/adapter', () => ({
  CloudApiAdapter: { rememberLastInbound: vi.fn() },
}));
vi.mock('@/modules/messages/service', () => ({
  updateExternalStatus: vi.fn(async () => {}),
  markFailed: vi.fn(async () => {}),
  reads: { byExternalId: vi.fn(async () => null) },
}));

const { handleCloudEvents } = await import('@/modules/channels/whatsapp/cloud-api/ingest');

function batch(messageIds: string[]) {
  return {
    phoneNumberId: '109876543210987',
    statuses: [],
    messages: messageIds.map(id => ({
      externalId: id,
      contactPhone: '5511999998888',
      contactJid: null,
      isGroup: false,
      fromMe: false,
      pushName: 'Teste',
      profilePic: null,
      mediaType: 'text' as const,
      content: 'oi',
      fileName: null,
      mimeType: null,
    })),
  } as unknown as Parameters<typeof handleCloudEvents>[1];
}

beforeEach(() => {
  vi.clearAllMocks();
  getCloudConnection.mockResolvedValue({ id: 'conn-1', credentials: {} });
});

describe('handleCloudEvents', () => {
  it('resolve quando todas as mensagens entram', async () => {
    ingestParsedInbound.mockResolvedValue({ ok: true });
    await expect(handleCloudEvents('conn-1', batch(['wamid.1', 'wamid.2']))).resolves.toBeUndefined();
    expect(ingestParsedInbound).toHaveBeenCalledTimes(2);
  });

  it('LANÇA quando uma mensagem falha — senão o evento vira done e a msg some', async () => {
    ingestParsedInbound
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('banco fora'));

    await expect(handleCloudEvents('conn-1', batch(['wamid.1', 'wamid.2']))).rejects.toThrow(/banco fora/);
  });

  it('tenta TODAS as mensagens antes de lançar — uma ruim não leva as outras', async () => {
    ingestParsedInbound
      .mockRejectedValueOnce(new Error('falha A'))
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('falha C'));

    await expect(handleCloudEvents('conn-1', batch(['a', 'b', 'c']))).rejects.toThrow(/2 mensagem/);
    expect(ingestParsedInbound).toHaveBeenCalledTimes(3);
  });

  it('sem connection correspondente, LANÇA — a mensagem não pode virar "done"', async () => {
    // Este teste já existiu afirmando o contrário: que descartar era certo,
    // "porque retentar daria no mesmo". A premissa era falsa e o teste
    // TRANCOU o bug — a connection pode passar a existir depois, e passou.
    //
    // Consequência em produção: quem chama roda `markDone` quando isto retorna
    // normalmente, então o evento ficava gravado como concluído e a mensagem
    // do cliente nunca entrava. Silencioso dos dois lados — a Meta viu 200, o
    // CRM disse "processado". Comeu 6 mensagens antes de alguém notar.
    //
    // Lançando, o evento vai para retentativa e depois para `failed`, que é
    // visível e reprocessável a partir do payload cru.
    getCloudConnection.mockResolvedValue(null);
    await expect(handleCloudEvents('conn-x', batch(['wamid.1']))).rejects.toThrow(
      /nenhuma connection cloud-api corresponde/
    );
    expect(ingestParsedInbound).not.toHaveBeenCalled();
  });
});
