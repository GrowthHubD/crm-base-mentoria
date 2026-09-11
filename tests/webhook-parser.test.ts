import { describe, it, expect } from 'vitest';
import {
  parseV2Webhook,
  detectEventType,
  isUsableMediaUrl,
  normalizeMediaType,
  normalizeMime,
} from '@/modules/channels/whatsapp/webhook-parser';
import type { UazapiV2WebhookPayload } from '@/modules/messages/types';

describe('webhook-parser', () => {
  describe('isUsableMediaUrl', () => {
    it('aceita URL HTTPS válida', () => {
      expect(isUsableMediaUrl('https://example.com/image.jpg')).toBe(true);
    });
    it('rejeita URL .enc (CDN criptografada)', () => {
      expect(isUsableMediaUrl('https://mmg.whatsapp.net/path.enc')).toBe(false);
      expect(isUsableMediaUrl('https://example.com/foo.enc?v=1')).toBe(false);
    });
    it('rejeita placeholder web.whatsapp.net', () => {
      expect(isUsableMediaUrl('https://web.whatsapp.net/')).toBe(false);
      expect(isUsableMediaUrl('https://web.whatsapp.net')).toBe(false);
    });
    it('rejeita strings vazias / null', () => {
      expect(isUsableMediaUrl(null)).toBe(false);
      expect(isUsableMediaUrl(undefined)).toBe(false);
      expect(isUsableMediaUrl('')).toBe(false);
      expect(isUsableMediaUrl('not-a-url')).toBe(false);
    });
  });

  describe('normalizeMediaType', () => {
    it('mapeia tipos canônicos', () => {
      expect(normalizeMediaType('text')).toBe('text');
      expect(normalizeMediaType('image')).toBe('image');
      expect(normalizeMediaType('audio')).toBe('audio');
      expect(normalizeMediaType('video')).toBe('video');
      expect(normalizeMediaType('document')).toBe('document');
      expect(normalizeMediaType('sticker')).toBe('sticker');
      expect(normalizeMediaType('location')).toBe('location');
    });
    it('normaliza ptt → audio', () => {
      expect(normalizeMediaType('ptt')).toBe('audio');
      expect(normalizeMediaType('voice')).toBe('audio');
    });
    it('normaliza nomes Baileys-style', () => {
      expect(normalizeMediaType('imageMessage')).toBe('image');
      expect(normalizeMediaType('audioMessage')).toBe('audio');
      expect(normalizeMediaType('extendedTextMessage')).toBe('text');
      expect(normalizeMediaType('conversation')).toBe('text');
    });
    it('default para unknown em strings desconhecidas', () => {
      expect(normalizeMediaType('foo')).toBe('unknown');
      expect(normalizeMediaType('')).toBe('text');
      expect(normalizeMediaType(undefined)).toBe('text');
    });
  });

  describe('normalizeMime', () => {
    it('audio/opus → audio/ogg', () => {
      expect(normalizeMime('audio/opus')).toBe('audio/ogg');
    });
    it('preserva outros mimes', () => {
      expect(normalizeMime('image/jpeg')).toBe('image/jpeg');
      expect(normalizeMime('video/mp4')).toBe('video/mp4');
    });
    it('null → null', () => {
      expect(normalizeMime(null)).toBe(null);
      expect(normalizeMime(undefined)).toBe(null);
    });
  });

  describe('detectEventType', () => {
    it('detecta tipo explícito', () => {
      expect(detectEventType({ EventType: 'messages' } as UazapiV2WebhookPayload)).toBe('messages');
      expect(detectEventType({ EventType: 'connection' } as UazapiV2WebhookPayload)).toBe('connection');
      expect(detectEventType({ EventType: 'qr' } as UazapiV2WebhookPayload)).toBe('qr');
      expect(detectEventType({ EventType: 'messages_update' } as UazapiV2WebhookPayload)).toBe('messages_update');
    });
    it('fallback pra messages se tem campo message', () => {
      expect(detectEventType({ message: { id: '1' } } as UazapiV2WebhookPayload)).toBe('messages');
    });
    it('unknown sem nada reconhecível', () => {
      expect(detectEventType({} as UazapiV2WebhookPayload)).toBe('unknown');
    });
  });

  describe('parseV2Webhook', () => {
    it('extrai mensagem texto inbound básica', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        instanceName: 'inst-1',
        chat: {
          wa_chatid: '5511999999999@s.whatsapp.net',
          wa_contactName: 'João',
          imagePreview: 'https://example.com/avatar.jpg',
        },
        message: {
          id: 'msg-abc',
          chatid: '5511999999999@s.whatsapp.net',
          fromMe: false,
          messageType: 'text',
          text: 'Olá, tudo bem?',
          messageTimestamp: 1700000000000,
        },
      };
      const parsed = parseV2Webhook(payload);
      expect(parsed).not.toBeNull();
      expect(parsed!.externalId).toBe('msg-abc');
      expect(parsed!.contactPhone).toBe('5511999999999');
      expect(parsed!.contactJid).toBe('5511999999999@s.whatsapp.net');
      expect(parsed!.isGroup).toBe(false);
      expect(parsed!.fromMe).toBe(false);
      expect(parsed!.pushName).toBe('João');
      expect(parsed!.profilePic).toBe('https://example.com/avatar.jpg');
      expect(parsed!.mediaType).toBe('text');
      expect(parsed!.content).toBe('Olá, tudo bem?');
      expect(parsed!.mediaUrl).toBeNull();
      expect(parsed!.mediaBase64).toBeNull();
    });

    it('detecta grupo via wa_isGroup', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        chat: { wa_chatid: '12345-67890@g.us', wa_isGroup: true, wa_name: 'Grupo X' },
        message: { id: 'g-1', text: 'msg', messageType: 'text' },
      };
      const parsed = parseV2Webhook(payload);
      expect(parsed!.isGroup).toBe(true);
    });

    it('extrai mídia com nome alternativo (fileURL ao invés de mediaUrl)', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        chat: { wa_chatid: '5511999999999@s.whatsapp.net' },
        message: {
          id: 'img-1',
          messageType: 'image',
          fileURL: 'https://example.com/image.jpg',
          mimetype: 'image/jpeg',
          caption: 'Olha essa foto',
        },
      };
      const parsed = parseV2Webhook(payload);
      expect(parsed!.mediaType).toBe('image');
      expect(parsed!.mediaUrl).toBe('https://example.com/image.jpg');
      expect(parsed!.mimeType).toBe('image/jpeg');
      expect(parsed!.content).toBe('Olha essa foto');
    });

    it('aceita ptt como áudio com mime opus → ogg', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        chat: { wa_chatid: '5511@s.whatsapp.net' },
        message: {
          id: 'audio-1',
          messageType: 'ptt',
          fileURL: 'https://example.com/voice.ogg',
          mimetype: 'audio/opus',
        },
      };
      const parsed = parseV2Webhook(payload);
      expect(parsed!.mediaType).toBe('audio');
      expect(parsed!.mimeType).toBe('audio/ogg');
    });

    it('extrai content de message.content.text quando text não está', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        chat: { wa_chatid: '5511@s.whatsapp.net' },
        message: { id: 'm', content: { text: 'oi' }, messageType: 'text' },
      };
      const parsed = parseV2Webhook(payload);
      expect(parsed!.content).toBe('oi');
    });

    it('preserva quote', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        chat: { wa_chatid: '5511@s.whatsapp.net' },
        message: {
          id: 'r',
          messageType: 'text',
          text: 'resposta',
          quoted: { id: 'parent-1', content: 'mensagem original' },
        },
      };
      const parsed = parseV2Webhook(payload);
      expect(parsed!.quoted).toEqual({ id: 'parent-1', content: 'mensagem original' });
    });

    it('retorna null sem chat phone resolvível', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        message: { id: 'no-chat', messageType: 'text', text: 'oi' },
      };
      expect(parseV2Webhook(payload)).toBeNull();
    });

    it('retorna null sem campo message', () => {
      expect(parseV2Webhook({ EventType: 'messages' } as UazapiV2WebhookPayload)).toBeNull();
    });

    it('detecta fromMe', () => {
      const payload: UazapiV2WebhookPayload = {
        EventType: 'messages',
        chat: { wa_chatid: '5511@s.whatsapp.net' },
        message: { id: 'me-1', fromMe: true, text: 'eu enviei', messageType: 'text' },
      };
      const parsed = parseV2Webhook(payload);
      expect(parsed!.fromMe).toBe(true);
    });
  });
});
