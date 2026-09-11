import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('AuthScopeProvider', () => {
  it('entrega a identidade e os gates ja resolvidos pelo layout', () => {
    const provider = readFileSync(join(root, 'src/modules/auth/client-scope.tsx'), 'utf8');
    expect(provider).toContain("role: 'admin' | 'attendant'");
    expect(provider).toContain('veTudo: boolean');
    expect(provider).toContain('kanbanManual: boolean');
    expect(provider).toContain('() => ({ userId, role, veTudo, kanbanManual })');
    expect(provider).toContain('<AuthScopeContext.Provider value={value}>');
    expect(provider).toContain('useContext(AuthScopeContext)?.userId ?? null');
  });

  it('remove chamadas duplicadas de identidade do CRM e do modal', () => {
    const page = readFileSync(join(root, 'src/app/(dashboard)/crm/page.tsx'), 'utf8');
    const modal = readFileSync(join(root, 'src/components/crm/LeadModal.tsx'), 'utf8');
    const layout = readFileSync(join(root, 'src/app/(dashboard)/layout.tsx'), 'utf8');

    expect(page).not.toContain("fetch('/api/me'");
    expect(modal).not.toContain("fetch('/api/me'");
    expect(layout).toContain('role={row.role}');
    expect(layout).toContain('veTudo={!carteiraPropria}');
    expect(layout).toContain('kanbanManual={cardsSoPorArraste()}');
  });
});
