import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('projecao leve do historico de mensagens', () => {
  const source = readFileSync(join(root, 'src/modules/messages/queries.ts'), 'utf8');

  it('remove embedding na projecao SQL da listagem', () => {
    expect(source).toContain(
      "const { embedding: embeddingColumn, ...messageListColumns } = getTableColumns(messages)"
    );
    expect(source).toContain('message: messageListColumns');
  });

  it('preserva metadata e so inclui embedding quando a linha realmente o possui', () => {
    expect(source).toContain("...('embedding' in row ? { embedding: row.embedding ?? null } : {})");
    expect(source).toContain('metadata: row.metadata ?? null');
  });
});
