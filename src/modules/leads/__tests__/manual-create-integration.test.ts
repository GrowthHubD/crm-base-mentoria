import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('integração da criação manual no CRM', () => {
  const route = readFileSync(join(root, 'src/app/api/leads/route.ts'), 'utf8');
  const page = readFileSync(join(root, 'src/app/(dashboard)/crm/page.tsx'), 'utf8');
  const mutation = readFileSync(join(root, 'src/modules/leads/mutations.ts'), 'utf8');

  it('protege o POST e deriva escopo no servidor', () => {
    const post = route.slice(route.indexOf('export async function POST'));
    expect(post).toContain('await requireSession(req)');
    expect(post).toContain('escopoDaRequisicao(guard.user, unidadeSelecionada(req))');
    expect(post).toContain('listActiveConnections({ ownerId: dono.ownerId, unitId: escopo.unitId })');
  });

  it('valida o destino contra as colunas reais antes de persistir', () => {
    expect(route).toContain('resolveManualLeadDestination(input, stages)');
    expect(route.indexOf('resolveManualLeadDestination(input, stages)'))
      .toBeLessThan(route.indexOf('createLeadFromContact({'));
  });

  it('recusa telefone de WhatsApp já cadastrado', () => {
    expect(route).toContain('await reads.findByContact(channel, externalContactId)');
    expect(route).toContain("status: 409");
  });

  it('persiste status e stageId explícitos sem mudar o default do webhook', () => {
    expect(mutation).toContain("status: input.status ?? 'new'");
    expect(mutation).toContain('input.stageId !== undefined');
    expect(mutation).toContain('cardsSoPorArraste() ? await colunaDeEntrada() : null');
  });

  it('oferece criação geral e por coluna e abre o card criado', () => {
    expect(page).toContain('Novo lead');
    expect(page).toContain('onCreateLead={s.status !== \'converted\' ? setCreateLeadStage : undefined}');
    expect(page).toContain('setOpenLead(leadId)');
    expect(page).toContain('void reload(true)');
  });
});
