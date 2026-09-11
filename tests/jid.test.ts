import { describe, it, expect } from 'vitest';
import {
  normalizePhone,
  extractPhone,
  isGroupJid,
  phoneToJid,
} from '@/modules/channels/whatsapp/jid';

describe('jid helpers', () => {
  describe('normalizePhone', () => {
    it('remove tudo que não é dígito', () => {
      expect(normalizePhone('+55 (11) 99999-9999')).toBe('5511999999999');
      expect(normalizePhone('5511999999999')).toBe('5511999999999');
      expect(normalizePhone('+55-11-99999-9999')).toBe('5511999999999');
      expect(normalizePhone('')).toBe('');
    });
  });

  describe('extractPhone', () => {
    it('extrai dígitos de JID com sufixo @s.whatsapp.net', () => {
      expect(extractPhone('5511999999999@s.whatsapp.net')).toBe('5511999999999');
      expect(extractPhone('5521987654321@g.us')).toBe('5521987654321');
    });
    it('lida com phone formatado e JID', () => {
      expect(extractPhone('+55 (11) 99999-9999@s.whatsapp.net')).toBe('5511999999999');
      expect(extractPhone('5511999999999')).toBe('5511999999999');
    });
    it('retorna string vazia para entrada vazia', () => {
      expect(extractPhone('')).toBe('');
    });
  });

  describe('isGroupJid', () => {
    it('detecta @g.us', () => {
      expect(isGroupJid('5511@g.us')).toBe(true);
      expect(isGroupJid('5511@s.whatsapp.net')).toBe(false);
      expect(isGroupJid('5511')).toBe(false);
    });
    it('é case-insensitive', () => {
      expect(isGroupJid('5511@G.US')).toBe(true);
    });
  });

  describe('phoneToJid', () => {
    it('formata phone como JID individual', () => {
      expect(phoneToJid('+55 11 99999-9999')).toBe('5511999999999@s.whatsapp.net');
      expect(phoneToJid('5511999999999')).toBe('5511999999999@s.whatsapp.net');
    });
  });
});
