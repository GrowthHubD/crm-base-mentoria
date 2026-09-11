import { describe, it, expect } from 'vitest';
import {
  isWithinFollowupWindow,
  nextFollowupWindowOpen,
} from '@/modules/followup/service';

// Janela: 8h-18h hora local (VPS em America/Sao_Paulo).
// Helper pra montar Date em hora local de forma estável (não bate em UTC).
function localDate(year: number, month1: number, day: number, hour: number, minute = 0): Date {
  // month1 = 1-12 pra legibilidade; Date espera 0-11.
  return new Date(year, month1 - 1, day, hour, minute, 0, 0);
}

describe('followup window', () => {
  describe('isWithinFollowupWindow', () => {
    it('dentro: 8h00 (abre), 12h, 17h59 (último minuto)', () => {
      expect(isWithinFollowupWindow(localDate(2026, 6, 2, 8, 0))).toBe(true);
      expect(isWithinFollowupWindow(localDate(2026, 6, 2, 12, 0))).toBe(true);
      expect(isWithinFollowupWindow(localDate(2026, 6, 2, 17, 59))).toBe(true);
    });
    it('fora: 7h59 (antes da abertura), 18h00 (fechamento), 23h, 4h', () => {
      expect(isWithinFollowupWindow(localDate(2026, 6, 2, 7, 59))).toBe(false);
      expect(isWithinFollowupWindow(localDate(2026, 6, 2, 18, 0))).toBe(false);
      expect(isWithinFollowupWindow(localDate(2026, 6, 2, 23, 0))).toBe(false);
      expect(isWithinFollowupWindow(localDate(2026, 6, 2, 4, 30))).toBe(false);
    });
  });

  describe('nextFollowupWindowOpen', () => {
    it('dentro da janela → retorna o mesmo instante (no-op)', () => {
      const t = localDate(2026, 6, 2, 10, 30);
      expect(nextFollowupWindowOpen(t).getTime()).toBe(t.getTime());
    });
    it('antes da abertura no mesmo dia → hoje 8h', () => {
      const t = localDate(2026, 6, 2, 5, 0);
      const next = nextFollowupWindowOpen(t);
      expect(next.getDate()).toBe(2);
      expect(next.getHours()).toBe(8);
      expect(next.getMinutes()).toBe(0);
    });
    it('depois do fechamento → amanhã 8h', () => {
      const t = localDate(2026, 6, 2, 23, 30);
      const next = nextFollowupWindowOpen(t);
      expect(next.getDate()).toBe(3);
      expect(next.getHours()).toBe(8);
      expect(next.getMinutes()).toBe(0);
    });
    it('exatamente 18h (fechamento) → amanhã 8h', () => {
      const t = localDate(2026, 6, 2, 18, 0);
      const next = nextFollowupWindowOpen(t);
      expect(next.getDate()).toBe(3);
      expect(next.getHours()).toBe(8);
    });
    it('viragem de mês: 30/06 23h → 01/07 8h', () => {
      const t = localDate(2026, 6, 30, 23, 0);
      const next = nextFollowupWindowOpen(t);
      expect(next.getMonth()).toBe(6); // julho (0-indexed)
      expect(next.getDate()).toBe(1);
      expect(next.getHours()).toBe(8);
    });
  });
});
