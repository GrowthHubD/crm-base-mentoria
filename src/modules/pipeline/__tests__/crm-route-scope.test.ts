import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('escopo das leituras do CRM', () => {
  it('a busca resolve unidade da sessao e do cabecalho', () => {
    const source = readFileSync(join(root, 'src/app/api/crm/search/route.ts'), 'utf8');
    expect(source).toContain('escopoDaRequisicao(guard.user, unidadeSelecionada(req))');
    expect(source).toContain('unitId: unidade.unitId');
  });

  it('o board envia unidade para filas e conexoes', () => {
    const source = readFileSync(join(root, 'src/app/api/crm/queues/route.ts'), 'utf8');
    expect(source).toMatch(/readFilter\s*=\s*{[\s\S]*unitId:\s*escopo\.unitId,[\s\S]*ownerId:\s*dono\.ownerId/);
    expect(source).toMatch(/listActiveConnections\(\{\s*ownerId:\s*dono\.ownerId,\s*unitId:\s*escopo\.unitId\s*}\)/);
  });

  it('o contrato completo continua padrao e o poll pode omitir conexoes', () => {
    const source = readFileSync(join(root, 'src/app/api/crm/queues/route.ts'), 'utf8');
    expect(source).toContain("url.searchParams.get('includeConnections') !== '0'");
    expect(source).toMatch(/includeConnections\s*\?\s*await Promise\.all\([\s\S]*listActiveConnections/);
    // Contrato agora inclui as caixas de e-mail (uma aba por caixa no CRM).
    expect(source).toContain('connections ? { queues, connections, emailAccounts: caixas } : { queues }');
  });

  it('a busca de email aplica o canal no servidor', () => {
    const source = readFileSync(join(root, 'src/app/api/crm/search/route.ts'), 'utf8');
    expect(source).toContain("channelParam === 'email' ? 'email' : undefined");
  });
});
