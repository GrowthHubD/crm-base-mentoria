/**
 * Parser do webhook oficial (Cloud API da Meta).
 *
 * Os payloads abaixo são o formato real documentado pela Meta. O que este
 * teste protege é o contrato: o parser oficial precisa produzir o MESMO
 * `ParsedInbound` que o parser da uazapi produz, porque os dois entram no
 * mesmo `ingestParsedInbound`. Se um campo mudar de nome aqui, o CRM cria lead
 * sem telefone ou mensagem sem texto — e isso só aparece em produção.
 */
import { describe, it, expect } from 'vitest';
import { parseMetaWebhook } from '@/modules/channels/whatsapp/cloud-api/webhook-parser';

const PHONE_NUMBER_ID = '109876543210987';

function envelope(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '102290129340398',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

describe('mensagem de texto', () => {
  const payload = envelope({
    contacts: [{ profile: { name: 'Maria' }, wa_id: '5518996336068' }],
    messages: [
      {
        from: '5518996336068',
        id: 'wamid.HBgNNTUxODk5NjMzNjA2OBUCABIYFjNBMEQ4RkY4',
        timestamp: '1755780000',
        type: 'text',
        text: { body: 'oi, queria saber o preço' },
      },
    ],
  });

  it('extrai contato, texto e identifica o número que recebeu', () => {
    const parsed = parseMetaWebhook(payload);

    expect(parsed.phoneNumberId).toBe(PHONE_NUMBER_ID);
    expect(parsed.messages).toHaveLength(1);

    const msg = parsed.messages[0];
    expect(msg.contactPhone).toBe('5518996336068');
    expect(msg.contactJid).toBe('5518996336068@s.whatsapp.net');
    expect(msg.pushName).toBe('Maria');
    expect(msg.mediaType).toBe('text');
    expect(msg.content).toBe('oi, queria saber o preço');
    expect(msg.externalId).toBe('wamid.HBgNNTUxODk5NjMzNjA2OBUCABIYFjNBMEQ4RkY4');
  });

  it('converte o timestamp de segundos para milissegundos', () => {
    const msg = parseMetaWebhook(payload).messages[0];
    expect(msg.timestamp).toBe(1755780000 * 1000);
  });

  it('nunca marca como grupo nem como mensagem própria — a Meta não entrega nenhum dos dois', () => {
    const msg = parseMetaWebhook(payload).messages[0];
    expect(msg.isGroup).toBe(false);
    expect(msg.fromMe).toBe(false);
  });
});

describe('mídia', () => {
  it('guarda o media id e não inventa URL — a oficial exige duas chamadas autenticadas', () => {
    const parsed = parseMetaWebhook(
      envelope({
        contacts: [{ profile: { name: 'João' }, wa_id: '5511988887777' }],
        messages: [
          {
            from: '5511988887777',
            id: 'wamid.IMG1',
            timestamp: '1755780100',
            type: 'image',
            image: { id: '1234567890', mime_type: 'image/jpeg', caption: 'é esse aqui' },
          },
        ],
      })
    );

    const msg = parsed.messages[0];
    expect(msg.mediaType).toBe('image');
    expect(msg.providerMediaId).toBe('1234567890');
    expect(msg.mimeType).toBe('image/jpeg');
    expect(msg.mediaUrl).toBeNull();
    expect(msg.mediaBase64).toBeNull();
    // A legenda é o texto da mensagem — é o que aparece no chat e no kanban.
    expect(msg.content).toBe('é esse aqui');
  });

  it('preserva o nome do arquivo em documento', () => {
    const parsed = parseMetaWebhook(
      envelope({
        messages: [
          {
            from: '5511988887777',
            id: 'wamid.DOC1',
            timestamp: '1755780200',
            type: 'document',
            document: { id: 'doc-1', mime_type: 'application/pdf', filename: 'contrato.pdf' },
          },
        ],
      })
    );

    expect(parsed.messages[0].fileName).toBe('contrato.pdf');
    expect(parsed.messages[0].mediaType).toBe('document');
  });
});

describe('resposta a botão e reply', () => {
  it('usa o título do botão como texto — é o que a pessoa realmente tocou', () => {
    const parsed = parseMetaWebhook(
      envelope({
        messages: [
          {
            from: '5511988887777',
            id: 'wamid.BTN1',
            timestamp: '1755780300',
            type: 'interactive',
            interactive: { button_reply: { id: 'btn_sim', title: 'Quero agendar' } },
          },
        ],
      })
    );

    expect(parsed.messages[0].content).toBe('Quero agendar');
  });

  it('registra a mensagem citada', () => {
    const parsed = parseMetaWebhook(
      envelope({
        messages: [
          {
            from: '5511988887777',
            id: 'wamid.REPLY1',
            timestamp: '1755780400',
            type: 'text',
            text: { body: 'esse mesmo' },
            context: { from: '15550001111', id: 'wamid.ORIGINAL' },
          },
        ],
      })
    );

    expect(parsed.messages[0].quoted?.id).toBe('wamid.ORIGINAL');
  });
});

describe('status de entrega', () => {
  it('lê sent/delivered/read', () => {
    const parsed = parseMetaWebhook(
      envelope({
        statuses: [
          { id: 'wamid.OUT1', status: 'sent', timestamp: '1755780500', recipient_id: '5511988887777' },
          { id: 'wamid.OUT2', status: 'delivered', timestamp: '1755780501', recipient_id: '5511988887777' },
          { id: 'wamid.OUT3', status: 'read', timestamp: '1755780502', recipient_id: '5511988887777' },
        ],
      })
    );

    expect(parsed.messages).toHaveLength(0);
    expect(parsed.statuses.map((s) => s.status)).toEqual(['sent', 'delivered', 'read']);
    expect(parsed.statuses[0].externalId).toBe('wamid.OUT1');
  });

  it('traz o motivo junto quando a mensagem falha', () => {
    const parsed = parseMetaWebhook(
      envelope({
        statuses: [
          {
            id: 'wamid.OUT4',
            status: 'failed',
            timestamp: '1755780600',
            recipient_id: '5511988887777',
            errors: [
              {
                code: 131047,
                title: 'Re-engagement message',
                message: 'Message failed to send because more than 24 hours have passed',
              },
            ],
          },
        ],
      })
    );

    expect(parsed.statuses[0].status).toBe('failed');
    expect(parsed.statuses[0].error).toContain('24 hours');
  });
});

describe('robustez', () => {
  it('ignora evento sem mensagem nem status (qualidade do número, template aprovado)', () => {
    const parsed = parseMetaWebhook(
      envelope({ event: 'PHONE_NUMBER_QUALITY_UPDATE', current_limit: 'TIER_1K' })
    );
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.statuses).toHaveLength(0);
  });

  it('não quebra com payload vazio', () => {
    expect(() => parseMetaWebhook({})).not.toThrow();
    expect(parseMetaWebhook({}).messages).toHaveLength(0);
  });

  it('achata várias mensagens no mesmo POST', () => {
    const parsed = parseMetaWebhook(
      envelope({
        messages: [
          { from: '5511111111111', id: 'wamid.A', timestamp: '1755780700', type: 'text', text: { body: 'um' } },
          { from: '5522222222222', id: 'wamid.B', timestamp: '1755780701', type: 'text', text: { body: 'dois' } },
        ],
      })
    );
    expect(parsed.messages.map((m) => m.content)).toEqual(['um', 'dois']);
  });
});
