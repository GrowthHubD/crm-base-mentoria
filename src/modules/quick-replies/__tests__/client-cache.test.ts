import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('cache client de respostas rapidas', () => {
  it('o chat usa o hook modular sem fetch direto por montagem', () => {
    const chat = readFileSync(join(root, 'src/components/crm/ChatPanel.tsx'), 'utf8');
    expect(chat).toContain('const quickReplies = useQuickReplies()');
    expect(chat).not.toContain("fetch('/api/admin/quick-replies'");
  });

  it('o CRUD invalida o cache depois de escrita', () => {
    const page = readFileSync(join(root, 'src/app/(dashboard)/textos-rapidos/page.tsx'), 'utf8');
    expect(page.match(/invalidarQuickReplies\(\)/g)).toHaveLength(2);
  });

  it('o hook delega isolamento e dedupe ao cache autenticado compartilhado', () => {
    const hook = readFileSync(
      join(root, 'src/modules/quick-replies/hooks/useQuickReplies.ts'),
      'utf8'
    );
    expect(hook).toContain('useDados<QuickRepliesResponse>(QUICK_REPLIES_URL)');
    expect(hook).toContain('invalidar(QUICK_REPLIES_URL)');
  });
});
