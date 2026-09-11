/**
 * Setup global do vitest. Carrega .env, mocka módulos que precisam de
 * conexão real (Redis, DB, Socket.IO, Gemini) — testes unitários ficam
 * isolados e roda sem nenhum serviço externo.
 */
import 'dotenv/config';
import { vi } from 'vitest';

// Garante ENCRYPTION_KEY de 32 bytes hex pra src/lib/encryption.ts
if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length !== 64) {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
}

// Override do uazapi pra base URL conhecida em testes (não usa o servidor real)
process.env.UAZAPI_BASE_URL = 'https://api.test.local';
process.env.UAZAPI_TOKEN = 'test-token';
process.env.UAZAPI_ADMIN_TOKEN = 'test-admin-token';

// Mocks globais — Redis (BullMQ), DB e Socket.IO são mockados por teste-a-teste
// quando relevante. Aqui só silenciamos coisas que poluem stdout.
vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));
