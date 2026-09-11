'use client';

/**
 * Tela de Mensagens Agendadas — retornos e follow-ups programados.
 *
 * Permite atendente criar agendamento manual, editar pendentes, enviar agora
 * ou cancelar. IA também aparece como origem (createdById nulo).
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Calendar as CalendarIcon, Clock, Search, Bot, UserRound, CircleCheckBig, Loader2,
  AlertCircle, Plus, Pencil, Send, X, Save,
} from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import type { ScheduledMessageView } from '@/app/api/scheduled-messages/route';
import { leadDisplayName, leadDisplaySubtitle, leadInitials } from '@/lib/lead-display';
import Loading from '@/components/Loading';

type StatusFilter = 'todos' | 'pending' | 'sent' | 'cancelled' | 'failed';
type OriginFilter = 'todos' | 'ai' | 'human';

export default function AgendamentosPage() {
  const [data, setData] = useState<ScheduledMessageView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('todos');
  const [origin, setOrigin] = useState<OriginFilter>('todos');
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<ScheduledMessageView | null>(null);

  async function load() {
    try {
      const res = await fetch('/api/scheduled-messages', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { scheduledMessages: ScheduledMessageView[] };
      setData(json.scheduledMessages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, []);

  const list = useMemo(() => {
    const all = data ?? [];
    return all.filter(s => {
      const text = `${s.leadName ?? ''} ${s.leadPhone ?? ''} ${s.body}`.toLowerCase();
      const mQ = !q || text.includes(q.toLowerCase());
      const mS = status === 'todos' || s.status === status;
      const mO = origin === 'todos' || s.origin === origin;
      return mQ && mS && mO;
    });
  }, [q, status, origin, data]);

  const all = data ?? [];
  const pendentes = all.filter(s => s.status === 'pending').length;
  const enviados = all.filter(s => s.status === 'sent').length;
  const urgentes = all.filter(s => s.status === 'pending' && new Date(s.scheduledAt).getTime() - Date.now() < 5 * 60_000).length;

  async function handleSendNow(s: ScheduledMessageView) {
    const r = await fetch(`/api/scheduled-messages/${s.id}/send-now`, { method: 'POST' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Falha: ${j?.error ?? r.status}`);
      return;
    }
    load();
  }

  async function handleCancel(s: ScheduledMessageView) {
    if (!confirm(`Cancelar agendamento para ${s.leadName ?? 'cliente'}?`)) return;
    const r = await fetch(`/api/scheduled-messages/${s.id}`, { method: 'DELETE' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert(`Falha: ${j?.error ?? r.status}`);
      return;
    }
    load();
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<CalendarIcon size={18} strokeWidth={1.6} />}
        title="Mensagens Agendadas"
        subtitle="Retornos e follow-ups programados"
        right={
          <div className="flex items-center gap-2">
            {urgentes > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
                style={{ background: 'rgba(251,191,36,0.18)', color: '#FBBF24' }}>
                <span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> {urgentes} urgente{urgentes > 1 ? 's' : ''}
              </span>
            )}
            <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
              style={{ background: '#451A03', color: '#FBBF24' }}>
              <Clock size={12} strokeWidth={1.6} /> {pendentes} pendentes
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px]"
              style={{ background: '#14532D', color: '#4ADE80' }}>
              <CircleCheckBig size={12} strokeWidth={1.6} /> {enviados} enviados
            </span>
            <button
              onClick={() => setShowNew(true)}
              className="ml-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-primary px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-mid"
            >
              <Plus size={14} strokeWidth={2} /> Novo agendamento
            </button>
          </div>
        }
      />

      <div className="px-3 py-4 md:px-6 md:py-6">
        {error && (
          <div className="mb-4 rounded-xl border p-3 text-[12px]"
            style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }}>
            Erro: {error}
          </div>
        )}

        {urgentes > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-xl border px-4 py-3 text-[12.5px]"
            style={{ background: 'rgba(251,191,36,0.08)', borderColor: 'rgba(251,191,36,0.3)', color: '#FBBF24' }}>
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{urgentes} mensagem{urgentes > 1 ? 'ns' : ''} para enviar em menos de 5 minutos!</span>
          </div>
        )}

        <Card padding={14} className="mb-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[260px]">
              <Search size={14} strokeWidth={1.6} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Buscar cliente ou mensagem..."
                className="w-full rounded-lg py-2 pl-9 pr-3 text-[12.5px] bg-[#0F0F14] border border-[var(--border-subtle)] text-text-primary"
              />
            </div>
            <div className="flex gap-1.5">
              {([
                { k: 'todos', l: 'Todos' },
                { k: 'pending', l: 'Pendentes' },
                { k: 'sent', l: 'Enviados' },
                { k: 'cancelled', l: 'Cancelados' },
              ] as { k: StatusFilter; l: string }[]).map(f => (
                <Pill key={f.k} active={status === f.k} onClick={() => setStatus(f.k)}>{f.l}</Pill>
              ))}
            </div>
            <div className="ml-2 flex gap-1.5 border-l border-[var(--border-subtle)] pl-2">
              {([
                { k: 'todos', l: 'Todos', icon: null },
                { k: 'ai', l: 'IA', icon: <Bot size={11} strokeWidth={1.7} /> },
                { k: 'human', l: 'Atendente', icon: <UserRound size={11} strokeWidth={1.7} /> },
              ] as { k: OriginFilter; l: string; icon: React.ReactNode }[]).map(f => (
                <Pill key={f.k} active={origin === f.k} onClick={() => setOrigin(f.k)}>
                  <span className="inline-flex items-center gap-1">{f.icon}{f.l}</span>
                </Pill>
              ))}
            </div>
          </div>
        </Card>

        {loading && !data ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed py-16 text-text-muted text-[12.5px]"
            style={{ borderColor: 'var(--border-subtle)' }}>
            <Loading size="sm" />
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.map(s => (
              <ScheduleCard
                key={s.id}
                s={s}
                onEdit={() => setEditing(s)}
                onSendNow={() => handleSendNow(s)}
                onCancel={() => handleCancel(s)}
              />
            ))}
            {list.length === 0 && (
              <div className="col-span-full rounded-xl border border-dashed py-16 text-center text-[13px] text-text-muted"
                style={{ borderColor: 'var(--border-subtle)' }}>
                Nenhum agendamento {data ? 'encontrado' : 'ainda'}
              </div>
            )}
          </div>
        )}
      </div>

      {showNew && <ScheduleModal mode="create" onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
      {editing && <ScheduleModal mode="edit" initial={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </div>
  );
}

function Pill({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg transition-all duration-150 px-3 py-1.5 text-[12px] ${
        active ? 'text-white' : 'text-text-muted hover:text-text-secondary'
      }`}
      style={
        active
          ? { background: 'var(--accent)', boxShadow: '0 0 12px rgba(var(--accent-mid-rgb),0.35)' }
          : { background: '#18181F', border: '1px solid rgba(255,255,255,0.04)' }
      }
    >
      {children}
    </button>
  );
}

function formatRelative(target: Date | string, status: string): string {
  const dt = new Date(target);
  const diffMs = dt.getTime() - Date.now();
  if (status === 'sent') {
    const absMin = Math.round(-diffMs / 60_000);
    if (absMin < 60) return `Enviado há ${absMin}min`;
    return `Enviado há ${Math.round(absMin / 60)}h`;
  }
  if (status === 'cancelled') return 'Cancelado';
  if (status === 'failed') return 'Falhou';
  // pending
  const min = Math.round(diffMs / 60_000);
  if (min < 0) return `Atrasada ${Math.abs(min)}min`;
  if (min < 60) return `Em ${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `Em ${h}h ${m}min`;
}

function ScheduleCard({
  s,
  onEdit,
  onSendNow,
  onCancel,
}: {
  s: ScheduledMessageView;
  onEdit: () => void;
  onSendNow: () => void;
  onCancel: () => void;
}) {
  const isUrgent = s.status === 'pending' && new Date(s.scheduledAt).getTime() - Date.now() < 5 * 60_000;
  const isPending = s.status === 'pending';

  const statusColor =
    s.status === 'pending'
      ? { bg: 'rgba(251,191,36,0.10)', tx: '#FBBF24', label: 'Aguardando' }
      : s.status === 'sent'
      ? { bg: 'rgba(74,222,128,0.10)', tx: '#4ADE80', label: 'Enviado' }
      : s.status === 'failed'
      ? { bg: 'rgba(248,113,113,0.10)', tx: '#F87171', label: 'Falhou' }
      : { bg: '#1C1C28', tx: '#94A3B8', label: 'Cancelado' };

  const channelLabel = 'WA';
  const channelBg = 'rgba(34,197,94,0.15)';
  const channelColor = '#22C55E';

  // Lead pode ter chegado sem `leadName` (agendamento manual sem informar nome).
  // Caímos pro telefone pra não exibir "Sem nome"/"??".
  const leadLike = {
    name: s.leadName,
    phone: s.leadPhone,
  };
  const initials = leadInitials(leadLike);
  const titleText = leadDisplayName(leadLike);
  const subtitleText = leadDisplaySubtitle(leadLike);
  const palette = ['#C08BFF', '#22D3EE', '#F472B6', '#A78BFA', '#FBBF24', '#4ADE80'];
  let hash = 0;
  for (const ch of s.leadId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = palette[hash % palette.length];

  return (
    <div
      className="group relative overflow-hidden rounded-2xl border p-4 transition-all duration-200 hover:-translate-y-[1px]"
      style={{
        background: '#111116',
        borderColor: isUrgent ? 'rgba(251,191,36,0.45)' : 'var(--border-subtle)',
        boxShadow: isUrgent ? '0 0 18px rgba(251,191,36,0.10)' : undefined,
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-semibold"
            style={{ background: `${color}33`, color, border: `1px solid ${color}55` }}
          >{initials}</div>
          <div>
            <div className="text-[13px] font-semibold text-text-primary">{titleText}</div>
            {subtitleText && <div className="text-[11px] text-text-muted">{subtitleText}</div>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ background: channelBg, color: channelColor }}>{channelLabel}</span>
          <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] font-medium"
            style={{ background: statusColor.bg, color: statusColor.tx, border: `1px solid ${statusColor.tx}33` }}>
            {statusColor.label}
          </span>
        </div>
      </div>

      <div className="mb-1 flex items-center justify-between">
        <div className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary">
          <CalendarIcon size={12} strokeWidth={1.6} />
          {new Date(s.scheduledAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
          <span className="ml-1 text-text-muted">· {formatRelative(s.scheduledAt, s.status)}</span>
        </div>
        <span className="inline-flex items-center gap-1 rounded-md px-1.5 text-[10px] font-semibold"
          style={s.origin === 'human'
            ? { background: '#18181F', color: '#F8FAFC', border: '1px solid var(--border-subtle)', height: 18 }
            : { background: 'var(--accent-deep)', color: 'var(--accent-light)', height: 18 }}>
          {s.origin === 'human' ? <><UserRound size={10} strokeWidth={1.7} /> {s.createdByName ?? 'Atendente'}</> : <><Bot size={10} strokeWidth={1.7} /> IA</>}
        </span>
      </div>

      <div className="mt-3 rounded-lg p-3 text-[12.5px] text-text-secondary"
        style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
        {s.body}
      </div>

      {s.internalNote && (
        <div className="mt-2 text-[11px] text-text-muted italic">
          📝 {s.internalNote}
        </div>
      )}

      {isPending && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={onEdit} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border-subtle)] bg-transparent px-2.5 py-1 text-[11.5px] text-text-secondary hover:bg-white/5">
            <Pencil size={12} strokeWidth={1.7} /> Editar
          </button>
          <button onClick={onSendNow} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 text-[11.5px] text-emerald-300 hover:bg-emerald-500/25">
            <Send size={12} strokeWidth={1.7} /> Enviar agora
          </button>
          <button onClick={onCancel} className="inline-flex items-center gap-1 rounded-lg bg-red-500/10 border border-red-500/25 px-2.5 py-1 text-[11.5px] text-red-300 hover:bg-red-500/20">
            <X size={12} strokeWidth={1.7} /> Cancelar
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Modal ─────────────────────────────────────────────────────────────── */

function ScheduleModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  initial?: ScheduledMessageView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.leadName ?? '');
  const [contact, setContact] = useState(initial?.leadPhone ?? '');
  // Canal fixo: o produto só conversa por WhatsApp. Instagram segue existindo
  // como ORIGEM de lead (atribuição), nunca como canal de envio.
  const channel = 'whatsapp' as const;
  const [body, setBody] = useState(initial?.body ?? '');
  const [internalNote, setInternalNote] = useState(initial?.internalNote ?? '');
  const [scheduledAt, setScheduledAt] = useState(() => {
    const base = initial?.scheduledAt ? new Date(initial.scheduledAt) : new Date(Date.now() + 30 * 60_000);
    // Format pra <input type="datetime-local">: YYYY-MM-DDTHH:mm
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}T${pad(base.getHours())}:${pad(base.getMinutes())}`;
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSave() {
    setErr(null);
    if (!body.trim()) { setErr('mensagem é obrigatória'); return; }
    if (!scheduledAt) { setErr('data e hora obrigatórios'); return; }
    if (mode === 'create') {
      if (!contact.trim()) { setErr('telefone/usuário obrigatório'); return; }
    }

    setSaving(true);
    try {
      const at = new Date(scheduledAt);
      if (mode === 'create') {
        const body_ = {
          channel,
          contact: contact.trim(),
          name: name.trim() || undefined,
          body: body.trim(),
          internalNote: internalNote.trim() || undefined,
          scheduledAt: at.toISOString(),
        };
        const r = await fetch('/api/scheduled-messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body_),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(j?.error ?? `HTTP ${r.status}`);
        }
      } else if (initial) {
        const body_: Record<string, unknown> = {
          body: body.trim(),
          scheduledAt: at.toISOString(),
          internalNote: internalNote.trim(),
        };
        const r = await fetch(`/api/scheduled-messages/${initial.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body_),
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
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 px-0 sm:items-center sm:px-4" onClick={onClose}>
      <div
        className="max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border bg-[#0F0F14] p-4 sm:max-w-md sm:rounded-2xl sm:p-5"
        style={{ borderColor: 'var(--border-subtle)' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'rgba(74,222,128,0.12)', color: '#4ADE80' }}>
              <Plus size={18} strokeWidth={1.7} />
            </div>
            <div>
              <h2 className="text-[14px] font-semibold text-text-primary">{mode === 'create' ? 'Novo Agendamento' : 'Editar Agendamento'}</h2>
              <p className="text-[11.5px] text-text-muted">{mode === 'create' ? 'Agendar mensagem de retorno ao cliente' : 'Atualize a mensagem ou horário'}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-white/5"><X size={16} /></button>
        </div>

        {err && (
          <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">{err}</div>
        )}

        {mode === 'create' && (
          <div className="mb-3 grid gap-3 md:grid-cols-2">
            <Field label="Nome do cliente">
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Nome completo" className="modal-input" />
            </Field>
            <Field label={channel === 'whatsapp' ? 'Telefone' : 'Usuário'}>
              <input
                value={contact}
                onChange={e => setContact(e.target.value)}
                placeholder={channel === 'whatsapp' ? '(11) 99999-9999' : '@usuario'}
                className="modal-input"
              />
            </Field>
          </div>
        )}


        <Field label="Data e hora do envio">
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={e => setScheduledAt(e.target.value)}
            className="modal-input"
          />
        </Field>

        <Field label="Mensagem">
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Olá! Conforme combinado, estou te retornando..."
            rows={4}
            className="modal-input resize-none"
          />
        </Field>

        <Field label="Nota interna (opcional)">
          <input
            value={internalNote}
            onChange={e => setInternalNote(e.target.value)}
            placeholder="Ex: cliente vai verificar com parceiro..."
            className="modal-input"
          />
        </Field>

        <div className="mt-5 flex gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-blue-primary px-3 py-2 text-[13px] font-semibold text-white hover:bg-blue-mid disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {mode === 'create' ? 'Agendar mensagem' : 'Salvar alterações'}
          </button>
          <button onClick={onClose} className="rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-[13px] text-text-secondary hover:bg-white/5">
            Cancelar
          </button>
        </div>
      </div>
      <style jsx>{`
        :global(.modal-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid var(--border-subtle);
          background: #18181F;
          padding: 0.5rem 0.75rem;
          font-size: 13px;
          color: var(--text-primary, #fff);
          margin-top: 0;
        }
        :global(.modal-input:focus) { outline: none; border-color: var(--accent-light); }
      `}</style>
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
