/**
 * Testes do parser da Evolution.
 *
 * O parser é a peça que mais quebra em silêncio: um campo que muda de lugar
 * num upgrade do provedor não derruba nada — só faz a mensagem chegar vazia,
 * ou com data de 1970, ou como tipo 'unknown'. Nada disso levanta exceção.
 *
 * Os payloads abaixo são o formato real da v2 (Baileys cru), reduzidos ao que
 * o parser lê.
 */
import { describe, it, expect } from 'vitest';
import { parseEvolutionWebhook, buildEvolutionEventKey } from '../webhook-parser';

const JID = '5511999999999@s.whatsapp.net';

function upsert(message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    event: 'messages.upsert',
    instance: 'acme6-principal',
    data: {
      key: { remoteJid: JID, fromMe: false, id: 'MSG_1' },
      pushName: 'João',
      messageTimestamp: 1735000000,
      message,
      ...extra,
    },
  };
}

describe('parseEvolutionWebhook — texto', () => {
  it('lê `conversation` (texto simples)', () => {
    const r = parseEvolutionWebhook(upsert({ conversation: 'oi' }));
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].content).toBe('oi');
    expect(r.messages[0].mediaType).toBe('text');
    expect(r.messages[0].contactPhone).toBe('5511999999999');
    expect(r.messages[0].externalId).toBe('MSG_1');
    expect(r.messages[0].pushName).toBe('João');
  });

  it('prefere `extendedTextMessage` a `conversation` quando os dois vêm', () => {
    // Uma resposta citada traz os dois; só o extended carrega o contexto do
    // quote, então ler o conversation perderia a citação.
    const r = parseEvolutionWebhook(
      upsert({
        conversation: 'ignorado',
        extendedTextMessage: {
          text: 'respondendo',
          contextInfo: { stanzaId: 'ORIG_1', quotedMessage: { conversation: 'pergunta' } },
        },
      })
    );
    expect(r.messages[0].content).toBe('respondendo');
    expect(r.messages[0].quoted).toEqual({ id: 'ORIG_1', content: 'pergunta' });
  });
});

describe('parseEvolutionWebhook — mídia', () => {
  it('imagem com legenda', () => {
    const r = parseEvolutionWebhook(
      upsert({
        imageMessage: {
          url: 'https://mmg.whatsapp.net/x.enc',
          mimetype: 'image/jpeg',
          caption: 'olha isso',
        },
      })
    );
    expect(r.messages[0].mediaType).toBe('image');
    expect(r.messages[0].content).toBe('olha isso');
    expect(r.messages[0].mimeType).toBe('image/jpeg');
  });

  it('documento usa fileName, e cai para title quando não houver', () => {
    const comNome = parseEvolutionWebhook(
      upsert({ documentMessage: { fileName: 'contrato.pdf', mimetype: 'application/pdf' } })
    );
    expect(comNome.messages[0].fileName).toBe('contrato.pdf');

    const soTitle = parseEvolutionWebhook(
      upsert({ documentMessage: { title: 'proposta', mimetype: 'application/pdf' } })
    );
    expect(soTitle.messages[0].fileName).toBe('proposta');
  });

  it('desembrulha documentWithCaptionMessage', () => {
    // Sem o desembrulho, um PDF com legenda chega como 'unknown'.
    const r = parseEvolutionWebhook(
      upsert({
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              fileName: 'orcamento.pdf',
              mimetype: 'application/pdf',
              caption: 'segue',
            },
          },
        },
      })
    );
    expect(r.messages[0].mediaType).toBe('document');
    expect(r.messages[0].fileName).toBe('orcamento.pdf');
    expect(r.messages[0].content).toBe('segue');
  });

  it('captura base64 inline nos dois lugares onde a v2 já o colocou', () => {
    const noMessage = parseEvolutionWebhook(
      upsert({ imageMessage: { mimetype: 'image/png' }, base64: 'QUJD' })
    );
    expect(noMessage.messages[0].mediaBase64).toBe('QUJD');

    const noData = parseEvolutionWebhook(
      upsert({ imageMessage: { mimetype: 'image/png' } }, { base64: 'WFla' })
    );
    expect(noData.messages[0].mediaBase64).toBe('WFla');
  });

  it('áudio vira mediaType audio', () => {
    const r = parseEvolutionWebhook(
      upsert({ audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } })
    );
    expect(r.messages[0].mediaType).toBe('audio');
  });
});

describe('parseEvolutionWebhook — timestamp', () => {
  it('converte segundos para milissegundos', () => {
    // Sem o ×1000 toda mensagem aterrissa em 1970 e o kanban ordena errado.
    const r = parseEvolutionWebhook(upsert({ conversation: 'oi' }));
    expect(r.messages[0].timestamp).toBe(1735000000 * 1000);
  });

  it('aceita timestamp em string', () => {
    const r = parseEvolutionWebhook(
      upsert({ conversation: 'oi' }, { messageTimestamp: '1735000000' })
    );
    expect(r.messages[0].timestamp).toBe(1735000000 * 1000);
  });

  it('não multiplica de novo se o valor já vier em ms', () => {
    const ms = 1735000000000;
    const r = parseEvolutionWebhook(upsert({ conversation: 'oi' }, { messageTimestamp: ms }));
    expect(r.messages[0].timestamp).toBe(ms);
  });

  it('cai para agora quando o timestamp é inválido', () => {
    const antes = Date.now();
    const r = parseEvolutionWebhook(upsert({ conversation: 'oi' }, { messageTimestamp: 0 }));
    expect(r.messages[0].timestamp).toBeGreaterThanOrEqual(antes);
  });
});

describe('parseEvolutionWebhook — roteamento e bordas', () => {
  it('marca grupo pelo sufixo @g.us', () => {
    const r = parseEvolutionWebhook(
      upsert({ conversation: 'oi' }, { key: { remoteJid: '123@g.us', fromMe: false, id: 'G1' } })
    );
    expect(r.messages[0].isGroup).toBe(true);
  });

  it('marca fromMe no eco de envio', () => {
    const r = parseEvolutionWebhook(
      upsert({ conversation: 'oi' }, { key: { remoteJid: JID, fromMe: true, id: 'OUT_1' } })
    );
    expect(r.messages[0].fromMe).toBe(true);
  });

  it('aceita o nome do evento em maiúsculas com underscore', () => {
    // A Evolution manda MESSAGES_UPSERT ou messages.upsert conforme a config.
    const r = parseEvolutionWebhook({ ...upsert({ conversation: 'oi' }), event: 'MESSAGES_UPSERT' });
    expect(r.messages).toHaveLength(1);
  });

  it('devolve vazio (sem lançar) para evento desconhecido', () => {
    const r = parseEvolutionWebhook({ event: 'contacts.update', instance: 'x', data: {} });
    expect(r.messages).toEqual([]);
    expect(r.statuses).toEqual([]);
  });

  it('devolve vazio quando falta a key da mensagem', () => {
    const r = parseEvolutionWebhook({
      event: 'messages.upsert',
      instance: 'x',
      data: { message: { conversation: 'sem key' } },
    });
    expect(r.messages).toEqual([]);
  });

  it('lê connection.update', () => {
    const r = parseEvolutionWebhook({
      event: 'connection.update',
      instance: 'x',
      data: { state: 'open' },
    });
    expect(r.connectionState).toBe('open');
  });
});

describe('parseEvolutionWebhook — status', () => {
  function update(status: string, keyId = 'MSG_1') {
    return {
      event: 'messages.update',
      instance: 'x',
      data: { keyId, status, messageTimestamp: 1735000000 },
    };
  }

  it.each([
    ['SERVER_ACK', 'sent'],
    ['DELIVERY_ACK', 'delivered'],
    ['READ', 'read'],
    ['PLAYED', 'read'],
    ['ERROR', 'failed'],
  ])('mapeia %s para %s', (bruto, esperado) => {
    const r = parseEvolutionWebhook(update(bruto));
    expect(r.statuses[0].status).toBe(esperado);
  });

  it('ignora PENDING (ainda não saiu, nada a atualizar)', () => {
    expect(parseEvolutionWebhook(update('PENDING')).statuses).toEqual([]);
  });

  it('ignora status desconhecido em vez de lançar', () => {
    expect(parseEvolutionWebhook(update('COISA_NOVA')).statuses).toEqual([]);
  });

  it('lê o id tanto de keyId quanto de key.id', () => {
    const porKey = parseEvolutionWebhook({
      event: 'messages.update',
      instance: 'x',
      data: { key: { id: 'MSG_2' }, status: 'READ', messageTimestamp: 1735000000 },
    });
    expect(porKey.statuses[0].externalId).toBe('MSG_2');
  });
});

describe('buildEvolutionEventKey', () => {
  it('gera chave estável para a mesma mensagem (dedupe de reentrega)', () => {
    const p = parseEvolutionWebhook(upsert({ conversation: 'oi' }));
    expect(buildEvolutionEventKey('conn-1', p)).toBe('evolution:conn-1:msg:MSG_1');
  });

  it('devolve null quando não há id do provedor — caller usa hash do corpo', () => {
    const p = parseEvolutionWebhook({
      event: 'connection.update',
      instance: 'x',
      data: { state: 'open' },
    });
    expect(buildEvolutionEventKey('conn-1', p)).toBeNull();
  });
});
