import { describe, expect, it } from 'vitest';
import { STAGES_PADRAO, type StageColumn } from '@/modules/pipeline/types';
import {
  manualExternalContactId,
  manualLeadSchema,
  normalizeManualLead,
  resolveManualLeadDestination,
} from '../manual-create';

describe('criação manual de lead', () => {
  const base = {
    name: 'Maria Silva',
    phone: '(11) 99999-8888',
    email: '',
    notes: '',
    connectionId: '',
    attributedChannel: 'instagram' as const,
    status: 'new' as const,
    stageId: 'padrao:new',
  };

  it('normaliza telefone, e-mail e campos vazios', () => {
    const parsed = manualLeadSchema.parse({ ...base, email: ' MARIA@EXEMPLO.COM ' });
    expect(normalizeManualLead(parsed)).toMatchObject({
      phone: '11999998888',
      email: 'maria@exemplo.com',
      notes: null,
      connectionId: undefined,
    });
  });

  it('exige ao menos telefone ou e-mail', () => {
    const parsed = manualLeadSchema.safeParse({ ...base, phone: '', email: '' });
    expect(parsed.success).toBe(false);
  });

  it('exige telefone quando há conexão de WhatsApp', () => {
    const parsed = manualLeadSchema.safeParse({
      ...base,
      phone: '',
      email: 'maria@exemplo.com',
      connectionId: 'conexao-1',
    });
    expect(parsed.success).toBe(false);
  });

  it('resolve coluna padrão sem persistir id sintético', () => {
    expect(resolveManualLeadDestination(base, STAGES_PADRAO)).toEqual({
      status: 'new',
      stageId: null,
    });
  });

  it('preserva id e status-base de uma coluna personalizada', () => {
    const custom: StageColumn = {
      ...STAGES_PADRAO[1],
      id: 'stage:proposta',
      label: 'Proposta',
      isCustom: true,
    };
    expect(resolveManualLeadDestination(
      { status: 'new', stageId: custom.id },
      [...STAGES_PADRAO, custom]
    )).toEqual({ status: 'priority', stageId: custom.id });
  });

  it('recusa coluna oculta, inexistente ou de encerramento', () => {
    const hidden = { ...STAGES_PADRAO[0], visible: false };
    expect(() => resolveManualLeadDestination(base, [hidden])).toThrow('não está disponível');
    expect(() => resolveManualLeadDestination({ ...base, stageId: 'forjada' }, STAGES_PADRAO))
      .toThrow('não está disponível');
    expect(() => resolveManualLeadDestination(
      { status: 'converted', stageId: 'padrao:converted' } as never,
      STAGES_PADRAO
    )).toThrow('coluna operacional');
  });

  it('usa telefone como identidade só quando há conexão', () => {
    expect(manualExternalContactId({ connectionId: 'c1', phone: '55119999', id: 'x' }))
      .toBe('55119999');
    expect(manualExternalContactId({ phone: '55119999', id: 'x' })).toBe('manual:x');
  });
});
