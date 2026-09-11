import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '@/lib/encryption';

describe('encryption (AES-256-GCM)', () => {
  it('encrypt/decrypt round-trip preserva texto', () => {
    const plain = 'token-secreto-uazapi-12345';
    const enc = encrypt(plain);
    expect(enc).not.toBe(plain);
    expect(enc).toContain(':');
    const dec = decrypt(enc);
    expect(dec).toBe(plain);
  });

  it('mesmo plaintext gera ciphertexts diferentes (IV aleatório)', () => {
    const plain = 'mesma-string';
    const a = encrypt(plain);
    const b = encrypt(plain);
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(plain);
    expect(decrypt(b)).toBe(plain);
  });

  it('preserva caracteres especiais e Unicode', () => {
    const plain = 'olá ç ã 🎉 áéíóú !@#$%^&*()_+';
    const enc = encrypt(plain);
    expect(decrypt(enc)).toBe(plain);
  });

  it('preserva strings longas', () => {
    const plain = 'a'.repeat(10_000);
    expect(decrypt(encrypt(plain))).toBe(plain);
  });
});
