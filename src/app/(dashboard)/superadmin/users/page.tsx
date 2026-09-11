'use client';

/**
 * Gestão de usuários — o admin cria/edita gerentes e atendentes.
 */
import { useEffect, useState } from 'react';
import { Users, Plus, Trash2, Save, Loader2, Pencil } from 'lucide-react';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import Loading from '@/components/Loading';

type Role = 'admin' | 'attendant';

interface UserRow {
  id: string;
  name: string;
  email: string;
  role: Role;
  createdAt: string;
}

export default function UsersPage() {
  const [items, setItems] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);

  // Form
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('attendant');

  // Edição inline de uma linha: nome, e-mail e (opcional) nova senha.
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPass, setEditPass] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  function abrirEdicao(u: UserRow) {
    setEditId(u.id); setEditName(u.name); setEditEmail(u.email); setEditPass(''); setError(null);
  }
  async function salvarEdicao(u: UserRow) {
    setSavingEdit(true);
    try {
      const body: Record<string, unknown> = {};
      if (editName.trim() && editName.trim() !== u.name) body.name = editName.trim();
      if (editEmail.trim() && editEmail.trim().toLowerCase() !== u.email) body.email = editEmail.trim();
      if (editPass) body.password = editPass;
      if (Object.keys(body).length === 0) { setEditId(null); return; }
      const r = await fetch(`/api/superadmin/users/${u.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j?.error ?? `HTTP ${r.status}`); }
      setEditId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const a = await fetch('/api/superadmin/users', { cache: 'no-store' });
      if (a.status === 403) { setError('Acesso restrito.'); return; }
      if (!a.ok) throw new Error(`users HTTP ${a.status}`);
      const aj = (await a.json()) as { items: UserRow[] };
      setItems(aj.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function handleCreate() {
    if (!email || !password || !name || !role) {
      setError('preencha email, name, password e role');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const body = { email, password, name, role };
      const r = await fetch('/api/superadmin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      setShowCreate(false);
      setEmail(''); setName(''); setPassword(''); setRole('attendant');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdate(u: UserRow, patch: Partial<UserRow>) {
    try {
      const body: Record<string, unknown> = {};
      if (patch.name !== undefined) body.name = patch.name;
      if (patch.role !== undefined) body.role = patch.role;
      const r = await fetch(`/api/superadmin/users/${u.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDelete(u: UserRow) {
    if (!confirm(`Remover ${u.email}?`)) return;
    try {
      const r = await fetch(`/api/superadmin/users/${u.id}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j?.error ?? `HTTP ${r.status}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col">
        <PageHeader icon={<Users size={18} strokeWidth={1.6} />} title="Usuários" subtitle="Gerentes e atendentes" />
        <div className="px-6 py-8"><Loading size="sm" /></div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<Users size={18} strokeWidth={1.6} />}
        title="Usuários"
        subtitle="Gerentes e atendentes"
        right={
          <button
            type="button"
            onClick={() => setShowCreate(s => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-primary px-3 py-1.5 text-[12.5px] font-semibold text-white hover:bg-blue-mid"
          >
            <Plus size={14} strokeWidth={2} /> Novo usuário
          </button>
        }
      />

      <div className="px-6 py-6 pb-24 max-w-5xl">
        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
        )}

        {showCreate && (
          <Card padding={20} className="mb-6">
            <h2 className="mb-3 text-[14px] font-semibold text-text-primary">Novo usuário</h2>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Nome"><input value={name} onChange={e => setName(e.target.value)} className="su-input" /></Field>
              <Field label="Email"><input type="email" value={email} onChange={e => setEmail(e.target.value)} className="su-input" /></Field>
              <Field label="Senha"><input type="text" value={password} onChange={e => setPassword(e.target.value)} className="su-input" /></Field>
              <Field label="Cargo">
                <select value={role} onChange={e => setRole(e.target.value as Role)} className="su-input">
                  <option value="attendant">Atendente</option>
                  <option value="admin">Gerente</option>
                </select>
              </Field>
            </div>
            <div className="mt-4 flex gap-2">
              <button onClick={handleCreate} disabled={creating} className="inline-flex items-center gap-1.5 rounded-lg bg-blue-primary px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-50">
                {creating ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Criar
              </button>
              <button onClick={() => setShowCreate(false)} className="rounded-lg border border-[var(--border-subtle)] px-3 py-1.5 text-[12.5px] text-text-secondary hover:bg-white/5">
                Cancelar
              </button>
            </div>
          </Card>
        )}

        <Card padding={0}>
          {/* Rolagem horizontal no celular: a coluna Cargo (com o select) saía
              da tela e ficava inalcançável. Rolar é melhor que empilhar aqui —
              a tabela tem só três colunas e a leitura em linha se mantém. */}
          <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-[12.5px]">
            <thead>
              <tr className="border-b border-[var(--border-subtle)]">
                <th className="px-4 py-3 text-left font-medium text-text-muted">Nome</th>
                <th className="px-4 py-3 text-left font-medium text-text-muted">Email</th>
                <th className="px-4 py-3 text-left font-medium text-text-muted">Cargo</th>
                <th className="px-4 py-3 text-right font-medium text-text-muted">Ações</th>
              </tr>
            </thead>
            <tbody>
              {items.map(u => (
                editId === u.id ? (
                  <tr key={u.id} className="border-b border-[var(--border-subtle)] last:border-0 bg-white/[0.02]">
                    <td className="px-4 py-2.5">
                      <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Nome"
                        className="w-full rounded-md border border-[var(--border-subtle)] bg-[#0F0F14] px-2 py-1 text-[12px] text-text-primary" />
                    </td>
                    <td className="px-4 py-2.5">
                      <input value={editEmail} onChange={e => setEditEmail(e.target.value)} placeholder="E-mail de login"
                        className="w-full rounded-md border border-[var(--border-subtle)] bg-[#0F0F14] px-2 py-1 text-[12px] text-text-primary" />
                      <input value={editPass} onChange={e => setEditPass(e.target.value)} placeholder="Nova senha (deixe vazio p/ manter)"
                        className="mt-1 w-full rounded-md border border-[var(--border-subtle)] bg-[#0F0F14] px-2 py-1 text-[12px] text-text-primary" />
                    </td>
                    <td className="px-4 py-2.5">
                      <select value={u.role} onChange={e => handleUpdate(u, { role: e.target.value as Role })}
                        className="rounded-md bg-transparent border border-[var(--border-subtle)] px-2 py-1 text-[12px] text-text-primary">
                        <option value="attendant">Atendente</option>
                        <option value="admin">Gerente</option>
                      </select>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <button onClick={() => salvarEdicao(u)} disabled={savingEdit}
                        className="mr-1 rounded-md p-1.5 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-50" title="Salvar">
                        {savingEdit ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} strokeWidth={1.8} />}
                      </button>
                      <button onClick={() => setEditId(null)} className="rounded-md px-2 py-1 text-[12px] text-text-muted hover:bg-white/5" title="Cancelar">
                        Cancelar
                      </button>
                    </td>
                  </tr>
                ) : (
                <tr key={u.id} className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-white/2">
                  <td className="px-4 py-2.5 text-text-primary">{u.name}</td>
                  <td className="px-4 py-2.5 text-text-secondary">{u.email}</td>
                  <td className="px-4 py-2.5">
                    <select
                      value={u.role}
                      onChange={e => handleUpdate(u, { role: e.target.value as Role })}
                      className="rounded-md bg-transparent border border-[var(--border-subtle)] px-2 py-1 text-[12px] text-text-primary"
                    >
                      <option value="attendant">Atendente</option>
                      <option value="admin">Gerente</option>
                    </select>
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    <button onClick={() => abrirEdicao(u)} className="mr-1 rounded-md p-1.5 text-text-muted hover:bg-white/5 hover:text-text-primary" title="Editar nome, e-mail e senha">
                      <Pencil size={14} strokeWidth={1.8} />
                    </button>
                    <button onClick={() => handleDelete(u)} className="rounded-md p-1.5 text-text-muted hover:bg-red-500/10 hover:text-red-300" title="Remover">
                      <Trash2 size={14} strokeWidth={1.8} />
                    </button>
                  </td>
                </tr>
                )
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      </div>
      <style jsx>{`
        :global(.su-input) {
          width: 100%;
          border-radius: 0.5rem;
          border: 1px solid var(--border-subtle);
          background: #0F0F14;
          padding: 0.5rem 0.75rem;
          font-size: 13px;
          color: var(--text-primary, #fff);
        }
        :global(.su-input:disabled) { opacity: 0.5; }
      `}</style>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium text-text-primary">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10.5px] text-text-muted">{hint}</span>}
    </label>
  );
}
