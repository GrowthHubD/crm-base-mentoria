'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AtSign,
  FileText,
  Layers3,
  Loader2,
  Phone,
  Radio,
  UserPlus,
  X,
} from 'lucide-react';
import type { CrmConnection } from '@/modules/pipeline/crm-read-model';
import type { StageColumn } from '@/modules/pipeline/types';
import { createManualLeadRequest } from '../api/create-manual-lead';
import { manualLeadSchema, type ManualLeadRequest } from '../manual-create';

interface Props {
  stages: StageColumn[];
  connections: CrmConnection[];
  initialStage: StageColumn;
  initialConnectionId?: string | null;
  onClose: () => void;
  onCreated: (leadId: string) => void;
}

const FIELD =
  'w-full rounded-lg border bg-[#18181F] px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none';
const LABEL = 'mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-text-secondary';

export default function CreateLeadModal({
  stages,
  connections,
  initialStage,
  initialConnectionId,
  onClose,
  onCreated,
}: Props) {
  const availableStages = useMemo(
    () => stages.filter((stage) => stage.visible && stage.status !== 'converted'),
    [stages]
  );
  const initialConnection = initialConnectionId
    && connections.some((connection) => connection.id === initialConnectionId)
      ? initialConnectionId
      : '';
  const [form, setForm] = useState<ManualLeadRequest>({
    name: '',
    phone: '',
    email: '',
    notes: '',
    connectionId: initialConnection || '',
    attributedChannel: 'manual',
    status: initialStage.status === 'converted' ? 'new' : initialStage.status,
    stageId: initialStage.status === 'converted' ? availableStages[0]?.id ?? null : initialStage.id,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedStage = availableStages.find((stage) => stage.id === form.stageId);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, saving]);

  function update<K extends keyof ManualLeadRequest>(key: K, value: ManualLeadRequest[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;

    const candidate = {
      ...form,
      status: selectedStage?.status ?? form.status,
    };
    const parsed = manualLeadSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Revise os dados do lead');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const result = await createManualLeadRequest(parsed.data);
      onCreated(result.lead.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível criar o lead');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-5"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-lead-title"
        className="max-h-[94dvh] w-full overflow-y-auto rounded-t-2xl border bg-[#0F0F15] shadow-2xl sm:max-w-2xl sm:rounded-2xl"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-[#0F0F15]/95 px-5 py-4 backdrop-blur"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="flex items-center gap-3">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-blue-mid/15 text-blue-light">
              <UserPlus size={18} strokeWidth={1.8} />
            </span>
            <div>
              <h2 id="create-lead-title" className="text-[15px] font-semibold text-white">Novo lead</h2>
              <p className="text-[11px] text-text-muted">O card será criado em {selectedStage?.label ?? initialStage.label}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Fechar"
            className="grid h-8 w-8 place-items-center rounded-lg text-text-muted transition hover:bg-white/5 hover:text-white disabled:opacity-40">
            <X size={17} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-5 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="new-lead-name">
                <UserPlus size={13} /> Nome do lead
              </label>
              <input id="new-lead-name" autoFocus maxLength={120} value={form.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="Ex: Maria Silva" className={FIELD} />
            </div>

            <div>
              <label className={LABEL} htmlFor="new-lead-phone"><Phone size={13} /> Telefone</label>
              <input id="new-lead-phone" inputMode="tel" maxLength={30} value={form.phone}
                onChange={(event) => update('phone', event.target.value)}
                placeholder="(11) 99999-9999" className={FIELD} />
            </div>
            <div>
              <label className={LABEL} htmlFor="new-lead-email"><AtSign size={13} /> E-mail</label>
              <input id="new-lead-email" type="email" maxLength={254} value={form.email}
                onChange={(event) => update('email', event.target.value)}
                placeholder="maria@empresa.com" className={FIELD} />
            </div>

            <div>
              <label className={LABEL} htmlFor="new-lead-stage"><Layers3 size={13} /> Coluna inicial</label>
              <select id="new-lead-stage" value={form.stageId ?? ''}
                onChange={(event) => {
                  const stage = availableStages.find((item) => item.id === event.target.value);
                  if (!stage || stage.status === 'converted') return;
                  const status: ManualLeadRequest['status'] = stage.status;
                  setForm((current) => ({ ...current, stageId: stage.id, status }));
                }} className={FIELD}>
                {availableStages.map((stage) => (
                  <option key={stage.id} value={stage.id}>{stage.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="new-lead-connection"><Radio size={13} /> Conexão</label>
              <select id="new-lead-connection" value={form.connectionId}
                onChange={(event) => update('connectionId', event.target.value)} className={FIELD}>
                <option value="">Cadastro manual</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name ?? connection.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="new-lead-origin"><Radio size={13} /> Origem comercial</label>
              <select id="new-lead-origin" value={form.attributedChannel ?? 'manual'}
                onChange={(event) => update('attributedChannel', event.target.value as ManualLeadRequest['attributedChannel'])}
                className={FIELD}>
                <option value="manual">Cadastro manual</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="instagram">Instagram</option>
                <option value="google">Google Ads</option>
                <option value="email">E-mail</option>
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className={LABEL} htmlFor="new-lead-notes"><FileText size={13} /> Observações internas</label>
              <textarea id="new-lead-notes" rows={3} maxLength={5_000} value={form.notes}
                onChange={(event) => update('notes', event.target.value)}
                placeholder="Contexto, interesse ou próximo passo" className={`${FIELD} resize-y`} />
            </div>
          </div>

          {form.connectionId && !form.phone.trim() && (
            <p className="text-[11px] text-amber-300">Informe o telefone para vincular o lead ao WhatsApp.</p>
          )}
          {error && (
            <div role="alert" className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-[12px] text-red-300">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
            <button type="button" onClick={onClose} disabled={saving}
              className="rounded-lg px-4 py-2 text-[12px] text-text-muted transition hover:bg-white/5 hover:text-white disabled:opacity-40">
              Cancelar
            </button>
            <button type="submit" disabled={saving}
              className="btn-primary min-w-32 justify-center disabled:cursor-not-allowed disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              {saving ? 'Criando...' : 'Criar lead'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
