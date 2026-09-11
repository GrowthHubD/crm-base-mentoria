'use client';

/**
 * Tab "Agendamentos" do LeadModal — agendamentos manuais únicos pra esse lead.
 *
 * Diferente dos follow-ups automáticos (configurados em /agente-ia, disparados
 * por ociosidade do lead), agendamentos manuais são pontuais: atendente clica
 * "agendar pra daqui a 30min" e a mensagem entra em `scheduled_messages` —
 * aparece em /agendamentos e dispara no horário.
 */
import { useEffect, useState } from 'react';
import {
  Calendar as CalendarIcon, Clock, Bot, UserRound, Loader2, Plus, Pencil,
  Send, X, Save, Trash2,
} from 'lucide-react';
import type { ScheduledMessageView } from '@/app/api/scheduled-messages/route';
import Loading from '@/components/Loading';

export default function AgendamentosTab({ leadId }: { leadId: string }) {
  const [items, setItems] = useState<ScheduledMessageView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<ScheduledMessageView | null>(null);

  async function load() {
    try {
      const res = await fetch(`/api/scheduled-messages?leadId=${encodeURIComponent(leadId)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { scheduledMessages: ScheduledMessageView[] };
      setItems(j.scheduledMessages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function handleSendNow(s: ScheduledMessageView) {
    const r = await fetch(`/api/scheduled-messages/${s.id}/send-now`, { method: 'POST' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Falha: ${j?.error ?? r.status}`);
      return;
    }
    void load();
  }

  async function handleCancel(s: ScheduledMessageView) {
    if (!confirm('Cancelar este agendamento?')) return;
    const r = await fetch(`/api/scheduled-messages/${s.id}`, { method: 'DELETE' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Falha: ${j?.error ?? r.status}`);
      return;
    }
    void load();
  }

  const pending = (items ?? []).filter(s => s.status === 'pending');
  const others = (items ?? []).filter(s => s.status !== 'pending');

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto px-5 py-5">
      <div
        className="flex items-center justify-between rounded-xl border px-4 py-3"
        style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}
      >
        <div>
          <div className="flex items-center gap-2 text-[13px] font-semibold text-text-secondary">
            <CalendarIcon size={14} strokeWidth={1.7} className="text-text-muted" />
            Agendamentos deste lead
          </div>
          <div className="mt-0.5 text-[11px] text-text-muted">
            Mensagens pontuais agendadas pelo atendente. Para automáticos por ociosidade, veja /agente-ia.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowNew(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-blue-500 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-blue-600"
        >
          <Plus size={13} strokeWidth={2} />
          Novo agendamento
        </button>
      </div>

      {error && (
        <div className="rounded-md px-3 py-2 text-[11.5px]"
          style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}>
          {error}
        </div>
      )}

      {items === null ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-[12.5px] text-text-muted"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <Loading size="sm" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed py-10 text-center text-[12.5px] text-text-muted"
          style={{ borderColor: 'var(--border-subtle)' }}>
          Nenhum agendamento pra esse lead ainda.
        </div>
      ) : (
        <>
          {pending.length > 0 && (
            <Section title="Pendentes">
              {pending.map(s => (
                <ScheduledCard
                  key={s.id}
                  s={s}
                  onEdit={() => setEditing(s)}
                  onSendNow={() => handleSendNow(s)}
                  onCancel={() => handleCancel(s)}
                />
              ))}
            </Section>
          )}
          {others.length > 0 && (
            <Section title="Histórico">
              {others.map(s => (
                <ScheduledCard key={s.id} s={s} />
              ))}
            </Section>
          )}
        </>
      )}

      {showNew && (
        <ScheduleModal
          leadId={leadId}
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); void load(); }}
        />
      )}
      {editing && (
        <ScheduleModal
          leadId={leadId}
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void load(); }}
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="section-label">{title}</div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function ScheduledCard({
  s, onEdit, onSendNow, onCancel,
}: {
  s: ScheduledMessageView;
  onEdit?: () => void;
  onSendNow?: () => void;
  onCancel?: () => void;
}) {
  const isPending = s.status === 'pending';
  const statusStyle =
    s.status === 'pending'
      ? { bg: 'rgba(251,191,36,0.10)', text: '#FBBF24', label: 'Aguardando' }
      : s.status === 'sent'
      ? { bg: 'rgba(74,222,128,0.10)', text: '#4ADE80', label: 'Enviado' }
      : s.status === 'failed'
      ? { bg: 'rgba(248,113,113,0.10)', text: '#F87171', label: 'Falhou' }
      : { bg: 'rgba(148,163,184,0.12)', text: '#94A3B8', label: 'Cancelado' };

  return (
    <div
      className="rounded-xl border p-3.5"
      style={{ background: '#0F0F14', borderColor: 'var(--border-subtle)' }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-2 text-[12px] text-text-secondary">
          <CalendarIcon size={12} strokeWidth={1.6} />
          {new Date(s.scheduledAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          <span className="ml-1 inline-flex items-center gap-1 text-text-muted">
            <Clock size={11} strokeWidth={1.6} />
            {formatRelative(s.scheduledAt, s.status)}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center rounded-md px-2 py-0.5 text-[10.5px] font-semibold"
            style={{ background: statusStyle.bg, color: statusStyle.text, border: `1px solid ${statusStyle.text}33` }}>
            {statusStyle.label}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
            style={s.origin === 'human'
              ? { background: '#18181F', color: '#F8FAFC', border: '1px solid var(--border-subtle)' }
              : { background: 'var(--accent-deep)', color: 'var(--accent-light)' }}>
            {s.origin === 'human'
              ? <><UserRound size={9} strokeWidth={1.7} /> {s.createdByName ?? 'Atendente'}</>
              : <><Bot size={9} strokeWidth={1.7} /> IA</>}
          </span>
        </div>
      </div>

      <div className="rounded-md p-2.5 text-[12.5px] text-text-secondary"
        style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
        {s.body}
      </div>

      {s.internalNote && (
        <div className="mt-2 text-[11px] text-text-muted italic">
          📝 {s.internalNote}
        </div>
      )}

      {isPending && (onEdit || onSendNow || onCancel) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {onEdit && (
            <button onClick={onEdit}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-[11px] text-text-secondary hover:bg-white/5">
              <Pencil size={11} strokeWidth={1.7} /> Editar
            </button>
          )}
          {onSendNow && (
            <button onClick={onSendNow}
              className="inline-flex items-center gap-1 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-300 hover:bg-emerald-500/20">
              <Send size={11} strokeWidth={1.7} /> Enviar agora
            </button>
          )}
          {onCancel && (
            <button onClick={onCancel}
              className="inline-flex items-center gap-1 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/20">
              <Trash2 size={11} strokeWidth={1.7} /> Cancelar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function formatRelative(target: Date | string, status: string): string {
  const dt = new Date(target);
  const diffMs = dt.getTime() - Date.now();
  if (status === 'sent') {
    const absMin = Math.round(-diffMs / 60_000);
    if (absMin < 60) return `há ${absMin}min`;
    return `há ${Math.round(absMin / 60)}h`;
  }
  if (status === 'cancelled') return 'cancelado';
  if (status === 'failed') return 'falhou';
  const min = Math.round(diffMs / 60_000);
  if (min < 0) return `atrasada ${Math.abs(min)}min`;
  if (min < 60) return `em ${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `em ${h}h ${m}min`;
}

// ─── Modal de criar/editar ──────────────────────────────────────────────────

function ScheduleModal({
  leadId, initial, onClose, onSaved,
}: {
  leadId: string;
  initial?: ScheduledMessageView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [body, setBody] = useState(initial?.body ?? '');
  const [internalNote, setInternalNote] = useState(initial?.internalNote ?? '');
  const [scheduledAt, setScheduledAt] = useState(() => {
    const base = initial?.scheduledAt ? new Date(initial.scheduledAt) : new Date(Date.now() + 30 * 60_000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const mode = initial ? 'edit' : 'create';

  async function handleSave() {
    setErr(null);
    if (!body.trim()) { setErr('mensagem é obrigatória'); return; }
    if (!scheduledAt) { setErr('data e hora obrigatórios'); return; }

    setSaving(true);
    try {
      const at = new Date(scheduledAt);
      if (mode === 'create') {
        const r = await fetch('/api/scheduled-messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leadId,
            body: body.trim(),
            scheduledAt: at.toISOString(),
            internalNote: internalNote.trim() || undefined,
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error ?? `HTTP ${r.status}`);
        }
      } else if (initial) {
        const r = await fetch(`/api/scheduled-messages/${initial.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: body.trim(),
            scheduledAt: at.toISOString(),
            internalNote: internalNote.trim(),
          }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error ?? `HTTP ${r.status}`);
        }
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 px-0 sm:items-center sm:px-4" onClick={onClose}>
      <div
        className="max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border p-4 sm:max-w-md sm:rounded-2xl sm:p-5"
        style={{ background: '#0F0F14', borderColor: 'var(--border-subtle)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg"
              style={{ background: 'rgba(var(--accent-light-rgb),0.15)', color: 'var(--accent-light)' }}>
              <CalendarIcon size={18} strokeWidth={1.7} />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-text-primary">
                {mode === 'create' ? 'Agendar mensagem' : 'Editar agendamento'}
              </h2>
              <p className="text-[11.5px] text-text-muted">
                Pontual pra esse lead. Aparece em /agendamentos.
              </p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-white/5">
            <X size={16} />
          </button>
        </div>

        {err && (
          <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {err}
          </div>
        )}

        <Field label="Data e hora do envio">
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={e => setScheduledAt(e.target.value)}
            className="w-full rounded-lg border bg-[#18181F] px-3 py-2 text-[13px] text-text-primary focus:border-blue-light focus:outline-none"
            style={{ borderColor: 'var(--border-subtle)' }}
          />
        </Field>

        <Field label="Mensagem">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Olá! Conforme combinado..."
            rows={4}
            className="w-full resize-none rounded-lg border bg-[#18181F] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
            style={{ borderColor: 'var(--border-subtle)' }}
          />
        </Field>

        <Field label="Nota interna (opcional)">
          <input
            value={internalNote}
            onChange={e => setInternalNote(e.target.value)}
            placeholder='Ex: "cliente vai confirmar com parceiro"'
            className="w-full rounded-lg border bg-[#18181F] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
            style={{ borderColor: 'var(--border-subtle)' }}
          />
        </Field>

        <div className="mt-5 flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-500 px-3 py-2 text-[13px] font-semibold text-white hover:bg-blue-600 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {mode === 'create' ? 'Agendar' : 'Salvar'}
          </button>
          <button onClick={onClose}
            className="rounded-lg border px-3 py-2 text-[13px] text-text-secondary hover:bg-white/5"
            style={{ borderColor: 'var(--border-subtle)' }}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-[11.5px] font-medium text-text-primary">{label}</span>
      {children}
    </label>
  );
}
