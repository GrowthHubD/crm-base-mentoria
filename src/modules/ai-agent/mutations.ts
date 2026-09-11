/**
 * Mutations do módulo ai-agent — single-tenant.
 *
 * `upsertConfig(input)` opera na única row; cria se não existir.
 */
import { db } from '@/lib/db/client';
import { eq } from 'drizzle-orm';
import { aiAgentConfig } from '@/lib/db/schema/ai-agent-config';
import type { AiAgentConfigInput } from './types';
import { getConfigRow } from './queries';

/**
 * Upsert da config. Aceita patch parcial — campos não enviados são ignorados.
 * Sempre incrementa `updatedAt`.
 */
export async function upsertConfig(input: AiAgentConfigInput): Promise<void> {
  const existing = await getConfigRow();

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    patch[k] = v;
  }

  if (existing) {
    await db.update(aiAgentConfig).set(patch).where(eq(aiAgentConfig.id, existing.id));
  } else {
    await db.insert(aiAgentConfig).values(patch as typeof aiAgentConfig.$inferInsert);
  }
}
