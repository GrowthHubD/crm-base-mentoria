'use client';

/**
 * Contas de e-mail do usuário.
 *
 * Cada SDR conecta a própria caixa: o botão leva à tela do Google, e a volta
 * cai aqui com `?ok=` ou `?erro=`. Ninguém digita senha no CRM e nenhum token
 * aparece nesta tela — o servidor guarda cifrado e nunca devolve.
 *
 * O ADMIN vê e desconecta as caixas de TODO o time (o servidor faz o recorte);
 * quando há caixas de mais de uma pessoa, cada card mostra de quem é.
 */
import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, Check, Loader2, Mail, Plus, Trash2, RefreshCw } from 'lucide-react';
import Card from '@/components/Card';
import Loading from '@/components/Loading';
import { useAuthScope } from '@/modules/auth/client-scope';

interface Conta {
  id: string;
  email: string;
  displayName: string | null;
  provider: string;
  active: boolean;
  lastError: string | null;
  lastSyncAt: string | null;
  createdAt: string;
  ownerId?: string | null;
  ownerName?: string | null;
}

function Conteudo() {
  const params = useSearchParams();
  const { veTudo } = useAuthScope();
  const [contas, setContas] = useState<Conta[] | null>(null);
  const [configurado, setConfigurado] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Resultado da volta do Google.
  useEffect(() => {
    const e = params.get('erro');
    const o = params.get('ok');
    if (e) setErro(e);
    if (o) setOk(`${o} conectado com sucesso.`);
  }, [params]);

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    try {
      const r = await fetch('/api/email/accounts', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setContas(j.accounts);
      setConfigurado(j.configurado !== false);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao carregar');
    }
  }

  async function remover(c: Conta) {
    if (!confirm(`Desconectar ${c.email}? Você pode reconectar depois.`)) return;
    setBusy(c.id);
    try {
      const r = await fetch(`/api/email/accounts?id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${r.status}`);
      }
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao desconectar');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-[19px] font-semibold text-text-primary">E-mail</h1>
      <p className="mb-5 mt-1 text-[12px] text-text-muted">
        Conecte sua conta do Google para enviar e receber e-mails pelo CRM com o seu próprio
        endereço. Cada pessoa conecta a dela.
      </p>

      {erro && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border p-3 text-[12px]"
          style={{ background: 'rgba(248,113,113,0.06)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }}>
          <AlertCircle size={14} strokeWidth={1.8} className="mt-[1px] shrink-0" />
          {erro}
        </div>
      )}
      {ok && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border p-3 text-[12px]"
          style={{ background: 'rgba(34,197,94,0.06)', borderColor: 'rgba(34,197,94,0.3)', color: '#22C55E' }}>
          <Check size={14} strokeWidth={1.9} /> {ok}
        </div>
      )}

      {!configurado && (
        <Card padding={16} className="mb-4">
          <div className="text-[13px] text-text-primary">E-mail ainda não habilitado neste sistema</div>
          <p className="mt-1 text-[12px] text-text-muted">
            Falta o administrador cadastrar o aplicativo do Google. Enquanto isso, o botão de
            conectar não aparece — ele só daria erro.
          </p>
        </Card>
      )}

      {!contas && !erro && (
        <div className="flex items-center gap-2 text-[13px] text-text-muted">
          <Loading size="sm" />
        </div>
      )}

      {contas && (
        <>
          <div className="flex flex-col gap-2">
            {(() => {
              // Mostra o dono só quando há caixas de mais de uma pessoa — é a
              // visão do admin. Para um BDR (uma dona só) seria redundante.
              // Admin vê SEMPRE de quem é (ele gerencia caixas alheias); um BDR só
              // veria a própria, então o rótulo apareceria à toa — por isso o OR.
              const varios = veTudo || new Set(contas.map((c) => c.ownerId ?? '')).size > 1;
              return contas.map((c) => (
              <Card key={c.id} padding={14}>
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: 'rgba(var(--accent-light-rgb),0.12)', color: 'var(--accent-light)' }}>
                    <Mail size={16} strokeWidth={1.7} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-text-primary">{c.email}</div>
                    {varios && c.ownerName && (
                      <div className="mt-0.5 text-[10.5px] text-text-muted">de {c.ownerName}</div>
                    )}
                    <div className="mt-0.5 text-[11px]" style={{ color: c.active ? 'var(--text-muted)' : '#F87171' }}>
                      {c.active
                        ? c.lastSyncAt
                          ? `Ativa · última sincronização ${new Date(c.lastSyncAt).toLocaleString('pt-BR')}`
                          : 'Ativa'
                        : `Precisa reconectar${c.lastError ? ` — ${c.lastError}` : ''}`}
                    </div>
                  </div>
                  {!c.active && (
                    <a href="/api/email/oauth/start"
                      className="shrink-0 rounded-lg border px-2.5 py-2 text-[12px] text-text-muted transition-colors hover:text-text-primary"
                      style={{ borderColor: 'var(--border-subtle)' }} title="Reconectar">
                      <RefreshCw size={14} strokeWidth={1.8} />
                    </a>
                  )}
                  <button onClick={() => remover(c)} disabled={busy === c.id}
                    className="shrink-0 rounded-lg border px-2.5 py-2 text-text-muted transition-colors hover:text-[#F87171]"
                    style={{ borderColor: 'var(--border-subtle)' }} title="Desconectar">
                    {busy === c.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} strokeWidth={1.8} />}
                  </button>
                </div>
              </Card>
              ));
            })()}
          </div>

          {configurado && (
            <a href="/api/email/oauth/start"
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-3 text-[12.5px] text-text-muted transition-colors hover:text-text-primary"
              style={{ borderColor: 'var(--border-subtle)' }}>
              <Plus size={14} strokeWidth={1.9} />
              Conectar conta do Google
            </a>
          )}

          <p className="mt-4 text-[11px] text-text-muted">
            O CRM pede permissão para <strong>enviar</strong> e <strong>ler</strong> e-mails — nunca
            para apagar. Você pode revogar o acesso quando quiser em
            {' '}<span className="text-text-secondary">myaccount.google.com/permissions</span>.
          </p>
        </>
      )}
    </div>
  );
}

export default function EmailConfigPage() {
  // `useSearchParams` exige Suspense no App Router — sem ele o build falha.
  return (
    <Suspense fallback={<div className="px-4 py-6"><Loading size="sm" /></div>}>
      <Conteudo />
    </Suspense>
  );
}
