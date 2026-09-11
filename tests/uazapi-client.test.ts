import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendText, sendImage, sendAudio, sendDocument, UazapiError, isStatusConnected, extractPhoneFromStatus } from '@/modules/channels/whatsapp/client';

// Mock global fetch — recriado a cada teste para isolamento
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('uazapi client', () => {
  it('sendText envia POST /send/text com number+text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'wa_123' }));
    const result = await sendText('inst-token', '+55 11 99999-9999', 'Oi');
    expect(result.message_id).toBe('wa_123');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.test.local/send/text');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.number).toBe('5511999999999');
    expect(body.text).toBe('Oi');
    expect(init.headers.token).toBe('inst-token');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('sendImage usa /send/media com type=image', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'img_1' }));
    await sendImage('tok', '5511', 'https://x/i.jpg', 'caption');
    const init = fetchMock.mock.calls[0][1];
    const body = JSON.parse(init.body);
    expect(body.type).toBe('image');
    expect(body.file).toBe('https://x/i.jpg');
    expect(body.text).toBe('caption');
  });

  it('sendAudio com ptt=true usa type=ptt', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'a' }));
    await sendAudio('tok', '5511', 'data:audio/ogg;base64,XXX', true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('ptt');
  });

  it('sendAudio com ptt=false usa type=audio', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'a' }));
    await sendAudio('tok', '5511', 'https://x/song.mp3', false);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('audio');
  });

  it('sendDocument inclui docName', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'd' }));
    await sendDocument('tok', '5511', 'https://x/file.pdf', 'fatura.pdf');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('document');
    expect(body.docName).toBe('fatura.pdf');
  });

  it('sendText inclui delay quando informado (presence "digitando...")', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'wa_x' }));
    await sendText('tok', '5511999999999', 'Oi', 2500);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.delay).toBe(2500);
  });

  it('sendText omite delay quando 0 ou undefined', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'a' }));
    await sendText('tok', '5511999999999', 'Oi');
    let body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.delay).toBeUndefined();

    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'b' }));
    await sendText('tok', '5511999999999', 'Oi', 0);
    body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.delay).toBeUndefined();
  });

  it('sendImage inclui delay no body do /send/media', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message_id: 'img' }));
    await sendImage('tok', '5511', 'https://x/i.jpg', 'cap', 1500);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.delay).toBe(1500);
    expect(body.type).toBe('image');
  });

  it('lança UazapiError em status >= 400', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not authorized', { status: 401 }));
    await expect(sendText('tok', '5511', 'oi')).rejects.toThrow(UazapiError);
  });

  it('UazapiError.isTransient() identifica 5xx e 429', async () => {
    const err500 = new UazapiError('/send/text', 500, 'down');
    const err429 = new UazapiError('/send/text', 429, 'rate');
    const err400 = new UazapiError('/send/text', 400, 'bad');
    const err0 = new UazapiError('/send/text', 0, 'network');
    expect(err500.isTransient()).toBe(true);
    expect(err429.isTransient()).toBe(true);
    expect(err0.isTransient()).toBe(true);
    expect(err400.isTransient()).toBe(false);
  });

  it('lança UazapiError com status=0 em erro de rede', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    try {
      await sendText('tok', '5511', 'oi');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UazapiError);
      expect((err as UazapiError).status).toBe(0);
      expect((err as UazapiError).isTransient()).toBe(true);
    }
  });
});

describe('isStatusConnected', () => {
  it('shape A (api.uazapi.com): status string', () => {
    expect(isStatusConnected({ status: 'connected' })).toBe(true);
    expect(isStatusConnected({ status: 'disconnected' })).toBe(false);
    expect(isStatusConnected({ status: 'CONNECTED' })).toBe(true);
  });
  it('shape A: campo connected boolean', () => {
    expect(isStatusConnected({ connected: true })).toBe(true);
    expect(isStatusConnected({ connected: false })).toBe(false);
  });
  it('shape B (williphone): status objeto com connected+loggedIn', () => {
    expect(isStatusConnected({ status: { connected: true, loggedIn: true } })).toBe(true);
    expect(isStatusConnected({ status: { connected: true, loggedIn: false } })).toBe(false);
    expect(isStatusConnected({ status: { connected: false, loggedIn: true } })).toBe(false);
  });
  it('null/undefined retorna false', () => {
    expect(isStatusConnected(null)).toBe(false);
    expect(isStatusConnected(undefined)).toBe(false);
    expect(isStatusConnected({})).toBe(false);
  });
});

describe('extractPhoneFromStatus', () => {
  it('shape A: campo phone direto', () => {
    expect(extractPhoneFromStatus({ phone: '5521999999999' })).toBe('5521999999999');
  });
  it('shape B: extrai do jid antes do : ou @', () => {
    expect(
      extractPhoneFromStatus({ status: { jid: '5521999433160:4@s.whatsapp.net', connected: true } })
    ).toBe('5521999433160');
    expect(extractPhoneFromStatus({ status: { jid: '5511999999999@s.whatsapp.net' } })).toBe('5511999999999');
  });
  it('null sem dado', () => {
    expect(extractPhoneFromStatus({})).toBe(null);
    expect(extractPhoneFromStatus(null)).toBe(null);
    expect(extractPhoneFromStatus({ status: { connected: true } })).toBe(null);
  });
});
