'use client';

/**
 * /textos-rapidos — CRUD dos atalhos da unit.
 *
 * Acessível a TODA a equipe da unidade (atendente incluso) — é ferramenta de
 * uso diário no chat, não config de admin. Item próprio no menu lateral.
 *
 * Atendente digita "/" no chat e escolhe um — body vai pro campo de mensagem.
 * Atalhos são compartilhados POR UNIT (ver schema/quick-replies.ts).
 */
import { useEffect, useState, useCallback } from 'react';
import { Zap, Plus, Trash2, Loader2, Pencil, Check, X, Sparkles, Shuffle } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import { invalidarQuickReplies } from '@/modules/quick-replies/hooks/useQuickReplies';

interface QuickReply {
  id: string;
  shortcut: string;
  body: string;
  label: string | null;
  variations: string[] | null;
  createdAt: string;
  updatedAt: string;
}

interface Draft {
  shortcut: string;
  body: string;
  label: string;
  variations: string[];
}

const emptyDraft: Draft = { shortcut: '', body: '', label: '', variations: [] };

export default function TextosRapidosPage() {
  const [items, setItems] = useState<QuickReply[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/quick-replies', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { items: QuickReply[] };
      setItems(json.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  function startNew() {
    setEditingId('__new__');
    setDraft(emptyDraft);
    setError(null);
  }

  function startEdit(item: QuickReply) {
    setEditingId(item.id);
    setDraft({
      shortcut: item.shortcut,
      body: item.body,
      label: item.label ?? '',
      variations: item.variations ?? [],
    });
    setError(null);
  }

  function cancel() {
    setEditingId(null);
    setDraft(emptyDraft);
  }

  async function save() {
    if (!draft.shortcut.trim() || !draft.body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const isNew = editingId === '__new__';
      const url = isNew
        ? '/api/admin/quick-replies'
        : `/api/admin/quick-replies/${editingId}`;
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shortcut: draft.shortcut,
          body: draft.body,
          label: draft.label || null,
          variations: draft.variations.map(v => v.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      invalidarQuickReplies();
      setEditingId(null);
      setDraft(emptyDraft);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm('Remover esse atalho?')) return;
    try {
      const res = await fetch(`/api/admin/quick-replies/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      invalidarQuickReplies();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<Zap size={18} strokeWidth={1.6} />}
        title="Textos rápidos"
        subtitle='Atalhos que o atendente acessa digitando "/" no chat'
      />

      <div className="max-w-3xl px-3 py-4 pb-24 md:px-6 md:py-6">
        {error && (
          <div className="mb-4 rounded-md px-3 py-2 text-[12px]"
            style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}>
            {error}
          </div>
        )}

        <Card padding={16}>
          <div className="mb-3 text-[12.5px] text-text-secondary leading-relaxed">
            Cadastre frases prontas que se repetem (saudação, pagamento, política, etc.).
            No chat do CRM, o atendente digita <code className="rounded bg-white/5 px-1.5 py-0.5 text-[11.5px]">/atalho</code> e
            o texto entra no campo de mensagem pronto pra editar antes de enviar.
            Atalhos valem pra TODA a unidade — qualquer atendente pode usar.
          </div>

          {items === null ? (
            <div className="flex h-32 items-center justify-center">
              <Loader2 size={18} className="animate-spin text-text-muted" />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {items.map(item => (
                <div key={item.id}
                  className="rounded-lg border p-3"
                  style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}>
                  {editingId === item.id ? (
                    <DraftEditor
                      draft={draft}
                      onDraft={setDraft}
                      onSave={save}
                      onCancel={cancel}
                      saving={saving}
                    />
                  ) : (
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <code className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[12px] font-semibold text-blue-light">
                            /{item.shortcut}
                          </code>
                          {item.label && (
                            <span className="text-[11.5px] text-text-muted">{item.label}</span>
                          )}
                          {item.variations && item.variations.length > 0 && (
                            <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-400"
                              title="O sistema sorteia entre estas versões a cada uso (anti-bloqueio)">
                              <Shuffle size={10} strokeWidth={2} />
                              {item.variations.length + 1} versões
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[12.5px] text-text-secondary whitespace-pre-wrap line-clamp-3">
                          {item.body}
                        </p>
                      </div>
                      <button onClick={() => startEdit(item)}
                        className="flex h-7 w-7 items-center justify-center rounded-md border text-text-muted hover:text-blue-light hover:border-blue-light/40"
                        style={{ borderColor: 'var(--border-subtle)', background: '#0F0F14' }}
                        aria-label="Editar">
                        <Pencil size={12} strokeWidth={1.7} />
                      </button>
                      <button onClick={() => remove(item.id)}
                        className="flex h-7 w-7 items-center justify-center rounded-md border text-error-text/80 hover:text-error-text hover:border-error-text/40"
                        style={{ borderColor: 'var(--border-subtle)', background: '#0F0F14' }}
                        aria-label="Remover">
                        <Trash2 size={12} strokeWidth={1.7} />
                      </button>
                    </div>
                  )}
                </div>
              ))}

              {editingId === '__new__' && (
                <div className="rounded-lg border-2 border-dashed p-3"
                  style={{ borderColor: 'rgba(var(--accent-mid-rgb),0.35)', background: '#0F0F14' }}>
                  <DraftEditor
                    draft={draft}
                    onDraft={setDraft}
                    onSave={save}
                    onCancel={cancel}
                    saving={saving}
                  />
                </div>
              )}

              {editingId !== '__new__' && (
                <button onClick={startNew}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-3 text-[12.5px] font-semibold text-blue-light transition-all hover:-translate-y-[1px] hover:bg-[rgba(var(--accent-mid-rgb),0.05)]"
                  style={{ borderColor: 'rgba(var(--accent-mid-rgb),0.35)' }}>
                  <Plus size={13} strokeWidth={1.8} /> Adicionar atalho
                </button>
              )}

              {items.length === 0 && editingId !== '__new__' && (
                <div className="rounded-md border border-dashed py-6 text-center text-[12px] text-text-muted"
                  style={{ borderColor: 'var(--border-subtle)' }}>
                  Nenhum atalho cadastrado ainda. Clique em "Adicionar atalho" pra começar.
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function DraftEditor({
  draft, onDraft, onSave, onCancel, saving,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Gatilho</div>
          <div className="flex items-center gap-1.5">
            <span className="text-[13px] font-semibold text-text-muted">/</span>
            <input
              value={draft.shortcut}
              onChange={e => onDraft({ ...draft, shortcut: e.target.value })}
              placeholder="ex: pagamento"
              className="flex-1 rounded-md border bg-[#0F0F14] px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
              style={{ borderColor: 'var(--border-subtle)' }}
            />
          </div>
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Rótulo (opcional)</div>
          <input
            value={draft.label}
            onChange={e => onDraft({ ...draft, label: e.target.value })}
            placeholder='ex: "Instruções de pagamento"'
            className="w-full rounded-md border bg-[#0F0F14] px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
            style={{ borderColor: 'var(--border-subtle)' }}
          />
        </div>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Mensagem</div>
        <textarea
          value={draft.body}
          onChange={e => onDraft({ ...draft, body: e.target.value })}
          rows={4}
          placeholder="Texto que entra no campo quando o atalho é escolhido"
          className="w-full resize-y rounded-md border bg-[#0F0F14] px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
          style={{ borderColor: 'var(--border-subtle)' }}
        />
      </div>

      <VariationsEditor draft={draft} onDraft={onDraft} />

      <div className="flex gap-2">
        <button onClick={onSave}
          disabled={saving || !draft.shortcut.trim() || !draft.body.trim()}
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed">
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={1.9} />}
          Salvar
        </button>
        <button onClick={onCancel}
          className="rounded-md border px-3 py-1.5 text-[12px] text-text-muted hover:text-text-secondary"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <X size={12} strokeWidth={1.8} className="mr-1 inline" />
          Cancelar
        </button>
      </div>
    </div>
  );
}

/**
 * Editor das variações do atalho. Cada variação é um texto alternativo; o
 * sistema sorteia entre o body + estas a cada uso (anti-bloqueio do WhatsApp).
 * Botão "Gerar com IA" pede paráfrases ao backend a partir do body.
 */
function VariationsEditor({
  draft, onDraft,
}: {
  draft: Draft;
  onDraft: (d: Draft) => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  function setVar(i: number, value: string) {
    const next = [...draft.variations];
    next[i] = value;
    onDraft({ ...draft, variations: next });
  }
  function addVar() {
    onDraft({ ...draft, variations: [...draft.variations, ''] });
  }
  function removeVar(i: number) {
    onDraft({ ...draft, variations: draft.variations.filter((_, idx) => idx !== i) });
  }

  async function generate() {
    if (!draft.body.trim()) { setGenError('escreva a mensagem principal primeiro'); return; }
    setGenerating(true);
    setGenError(null);
    try {
      const res = await fetch('/api/admin/quick-replies/generate-variations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: draft.body, count: 4 }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((j as { error?: string }).error ?? `HTTP ${res.status}`);
      const generated = ((j as { variations?: string[] }).variations ?? []).filter(Boolean);
      // Mescla com as existentes, sem duplicar e sem repetir o body.
      const seen = new Set<string>([draft.body.trim(), ...draft.variations.map(v => v.trim())]);
      const merged = [...draft.variations];
      for (const g of generated) {
        const t = g.trim();
        if (t && !seen.has(t)) { seen.add(t); merged.push(t); }
      }
      onDraft({ ...draft, variations: merged });
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'erro ao gerar');
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="rounded-md border p-2.5" style={{ borderColor: 'var(--border-subtle)', background: '#0C0C10' }}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-400">
          <Shuffle size={11} strokeWidth={2} /> Variações (anti-bloqueio)
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={generating}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] font-semibold text-blue-light hover:bg-[rgba(var(--accent-mid-rgb),0.08)] disabled:opacity-50"
          style={{ borderColor: 'rgba(var(--accent-mid-rgb),0.35)' }}>
          {generating ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} strokeWidth={1.9} />}
          Gerar com IA
        </button>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-text-muted">
        O sistema escolhe automaticamente entre a mensagem principal e estas versões a cada uso,
        pra não enviar texto idêntico pra muitos contatos (o que dispara bloqueio do WhatsApp).
        A IA mantém valores, PIX e links — mas revise antes de salvar.
      </p>

      {genError && (
        <div className="mb-2 rounded px-2 py-1 text-[11px]" style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}>
          {genError}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        {draft.variations.map((v, i) => (
          <div key={i} className="flex items-start gap-1.5">
            <textarea
              value={v}
              onChange={e => setVar(i, e.target.value)}
              rows={2}
              placeholder={`Variação ${i + 1}`}
              className="flex-1 resize-y rounded-md border bg-[#0F0F14] px-2.5 py-1.5 text-[12.5px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
              style={{ borderColor: 'var(--border-subtle)' }}
            />
            <button type="button" onClick={() => removeVar(i)}
              className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-error-text/80 hover:text-error-text hover:border-error-text/40"
              style={{ borderColor: 'var(--border-subtle)', background: '#0F0F14' }}
              aria-label="Remover variação">
              <Trash2 size={11} strokeWidth={1.7} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addVar}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed py-1.5 text-[11.5px] font-medium text-text-muted hover:text-blue-light hover:border-blue-light/40"
          style={{ borderColor: 'var(--border-subtle)' }}>
          <Plus size={12} strokeWidth={1.8} /> Adicionar variação
        </button>
      </div>
    </div>
  );
}
