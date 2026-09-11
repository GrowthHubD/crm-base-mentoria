'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Wifi, MessageCircle, Plus, RefreshCw, Info, Loader2, X, CheckCircle2, Trash2, AlertCircle, Webhook,
} from 'lucide-react';
import { useDados, invalidar } from '@/lib/useDados';
import PageHeader from '@/components/PageHeader';
import Card from '@/components/Card';
import StatusBadge from '@/components/StatusBadge';
import type { ConnectionView } from '@/app/api/connections/route';
import Loading from '@/components/Loading';

const REFRESH_INTERVAL_MS = 15_000;
const QR_POLL_INTERVAL_MS = 3_000;

/**
 * Falhas seguidas toleradas antes de mostrar erro na tela do QR.
 *
 * Com polling de 3s, três falhas são ~9 segundos — tempo suficiente para um
 * deploy trocar o Worker sem que quem está escaneando veja "erro 500" piscando.
 * Falha real passa desses 9 segundos e aparece do mesmo jeito.
 */
const TOLERANCIA_FALHAS = 3;

type ModalState =
  | { stage: 'closed' }
  | { stage: 'form' }
  | { stage: 'qr'; connectionId: string; instanceId: string; qrcode: string | null; error?: string }
  | { stage: 'success'; connectionId: string };

export default function ConexoesPage() {
  // O papel decide o que APARECE; quem decide o que PODE é a rota (`requireAdmin`
  // em criar e apagar). Aqui é só para não oferecer botão que responderia 403 —
  // botão que sempre falha é pior do que botão ausente.
  // `/api/me` devolve os campos na RAIZ (`{ id, name, email, role, ... }`), não
  // embrulhados em `{ user }`. Ler o caminho errado deixava `ehAdmin` sempre
  // falso e escondia o botão de adicionar conexão de TODO MUNDO, inclusive do
  // admin — a tela ficava sem saída, com "0 de 0 conexões" e nada para clicar.
  const { dado: eu, carregando: carregandoPapel } = useDados<{ role?: string }>('/api/me');
  // Enquanto o papel não chega, assume admin: um instante a mais com o botão
  // visível é inofensivo (a rota recusa quem não pode), enquanto o contrário
  // faz o botão piscar e sumir na frente de quem tem direito a ele.
  const ehAdmin = carregandoPapel || eu?.role === 'admin';

  const [modal, setModal] = useState<ModalState>({ stage: 'closed' });
  const [busyId, setBusyId] = useState<string | null>(null);

  // Cache entre telas — ver `lib/useDados.ts`. Conexões é a tela que mais se
  // visita de relance ("o número caiu?"), então pintar na hora com a última
  // leitura e revalidar por baixo é exatamente o comportamento certo aqui.
  const { dado, carregando: loading, recarregar } = useDados<{ connections: ConnectionView[] }>(
    '/api/connections',
    { intervalo: REFRESH_INTERVAL_MS }
  );
  const data = dado?.connections ?? null;
  const error = null as string | null;

  // Depois de conectar/desconectar um número, o estado da tela não pode ficar
  // esperando o próximo polling: invalida e busca de novo na hora.
  const reload = async () => {
    invalidar('/api/connections');
    await recarregar();
  };

  const all = data ?? [];
  const list = useMemo(() => all.filter(c => c.type === 'whatsapp'), [all]);
  const waActive = list.filter(c => c.status === 'connected').length;

  const subtitle = data
    ? `${waActive} de ${list.length} conexões ativas`
    // Sem frase de espera: o subtítulo simplesmente não existe até o número
    // chegar. "Carregando…" num cabeçalho é ruído — quem olha já vê que a
    // tela está montando, e a frase fica no lugar do dado por um instante.
    : '';

  async function handleReconnect(c: ConnectionView) {
    setModal({
      stage: 'qr',
      connectionId: c.id,
      instanceId: c.instanceId ?? '',
      qrcode: null,
    });
  }

  async function handleDisconnect(c: ConnectionView) {
    if (!confirm(`Remover conexão "${c.name ?? c.id}"? Essa ação não pode ser desfeita.`)) return;
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/connections/${c.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Erro ao desconectar: ${j.error ?? res.status}`);
        return;
      }
      await reload();
    } finally {
      setBusyId(null);
    }
  }

  async function handleSyncWebhook(c: ConnectionView) {
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/connections/${c.id}/webhook`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Erro ao configurar webhook: ${j.error ?? res.status}`);
        return;
      }
      alert(`Webhook configurado: ${j.webhookUrl}`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        icon={<Wifi size={18} strokeWidth={1.6} />}
        title="Conexões"
        subtitle={subtitle}
      />

      <div className="px-3 py-4 md:px-6 md:py-6">
        {loading && !data && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-text-muted text-[12.5px]"
            style={{ borderColor: 'var(--border-subtle)' }}>
            <Loader2 size={14} strokeWidth={1.6} className="animate-spin" />
            <Loading size="sm" label="Carregando conexões" />
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl border p-3 text-[12px]"
            style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }}>
            Erro: {error}
          </div>
        )}

        {data && (
          <Section
            icon={<MessageCircle size={18} strokeWidth={1.6} style={{ color: '#4ADE80' }} />}
            title={`WhatsApp (${waActive} conectado${waActive === 1 ? '' : 's'})`}
            items={list}
            addLabel="Adicionar WhatsApp"
            onAdd={() => setModal({ stage: 'form' })}
            podeGerenciar={ehAdmin}
            onReconnect={handleReconnect}
            onDisconnect={handleDisconnect}
            onSyncWebhook={handleSyncWebhook}
            busyId={busyId}
          />
        )}

        <Card padding={20} className="mt-6">
          <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-text-primary">
            <Info size={16} strokeWidth={1.6} className="text-blue-light" />
            Como funciona a integração
          </div>
          <div className="text-[12px] text-text-secondary">
            <p>
              <strong className="text-text-primary">WhatsApp:</strong> conexão via uazapi (servidor dedicado). Adicionar uma instância gera o QR code direto na interface — escaneie no WhatsApp Business, pronto.
            </p>
          </div>
        </Card>
      </div>

      {modal.stage !== 'closed' && (
        <ConnectModal
          state={modal}
          onChange={setModal}
          onSuccess={async () => {
            await reload();
          }}
        />
      )}
    </div>
  );
}

function Section({
  icon, title, items, addLabel, addDisabled, addDisabledHint, onAdd, onReconnect, onDisconnect, onSyncWebhook, busyId, podeGerenciar = true,
}: {
  icon: React.ReactNode;
  title: string;
  items: ConnectionView[];
  addLabel: string;
  /** Criar e apagar conexão são de admin — a rota já recusa (`requireAdmin`);
   *  aqui só evitamos oferecer o botão que responderia 403. */
  podeGerenciar?: boolean;
  addDisabled?: boolean;
  addDisabledHint?: string;
  onAdd?: () => void;
  onReconnect: (c: ConnectionView) => void;
  onDisconnect: (c: ConnectionView) => void;
  podeRemover?: boolean;
  onSyncWebhook: (c: ConnectionView) => void;
  busyId: string | null;
}) {
  return (
    <div className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <span className="text-[13px] font-semibold text-text-primary">{title}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 stagger">
        {items.map(c => (
          <ConnCard
            key={c.id}
            c={c}
            onReconnect={onReconnect}
            onDisconnect={onDisconnect}
            podeRemover={podeGerenciar}
            onSyncWebhook={onSyncWebhook}
            busy={busyId === c.id}
          />
        ))}
        {podeGerenciar && (
          <AddCard label={addLabel} onClick={onAdd} disabled={addDisabled} disabledHint={addDisabledHint} />
        )}
      </div>
    </div>
  );
}

function ConnCard({
  c, onReconnect, onDisconnect, onSyncWebhook, busy, podeRemover = true,
}: {
  c: ConnectionView;
  onReconnect: (c: ConnectionView) => void;
  onDisconnect: (c: ConnectionView) => void;
  /** Só admin apaga — a rota já recusa; aqui é para não oferecer o botão. */
  podeRemover?: boolean;
  onSyncWebhook: (c: ConnectionView) => void;
  busy: boolean;
}) {
  const variant = c.status === 'connected' ? 'conectado' : c.status === 'qr_pending' ? 'aguardando' : 'desconectado';
  const variantLabel = c.status === 'connected' ? 'Conectado'
    : c.status === 'qr_pending' ? 'Aguardando QR'
    : c.status === 'disconnected' ? 'Desconectado'
    : c.status;

  const lastActivity = c.lastSeenAt
    ? new Date(c.lastSeenAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

  return (
    <Card padding={18} interactive>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold text-text-primary">{c.name ?? 'Sem nome'}</div>
          <div className="mt-0.5 truncate text-[12px] text-text-muted">
            {c.phone ? formatPhone(c.phone) : c.instanceId ?? '—'}
          </div>
        </div>
        <StatusBadge variant={variant}>{variantLabel}</StatusBadge>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg p-2.5"
        style={{ background: '#18181F', border: '1px solid var(--border-subtle)' }}>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Última atividade</div>
          <div className="mt-0.5 text-[12px] text-text-secondary">{lastActivity}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-text-muted">Mensagens hoje</div>
          <div className="mt-0.5 text-[12px] text-text-primary tabular-nums">{c.messagesToday}</div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {c.status === 'connected' ? (
          <span className="flex-1 inline-flex items-center justify-center rounded-md text-[11.5px] text-text-muted" style={{ height: 34 }}>
            ✓ Online via uazapi
          </span>
        ) : (
          <button className="btn-primary flex-1" onClick={() => onReconnect(c)} disabled={busy}>
            <RefreshCw size={12} strokeWidth={1.8} /> Reconectar
          </button>
        )}
        <button
          onClick={() => onSyncWebhook(c)}
          disabled={busy}
          aria-label="Reconfigurar webhook"
          title="Reconfigurar webhook"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-md border transition-colors duration-150 hover:bg-[rgba(var(--accent-light-rgb),0.08)] disabled:opacity-40"
          style={{ borderColor: 'rgba(var(--accent-light-rgb),0.25)', color: 'var(--accent-light)' }}
        >
          <Webhook size={13} strokeWidth={1.8} />
        </button>
        {podeRemover && <button
          onClick={() => onDisconnect(c)}
          disabled={busy}
          aria-label="Remover conexão"
          className="flex h-[34px] w-[34px] items-center justify-center rounded-md border transition-colors duration-150 hover:bg-[rgba(248,113,113,0.08)] disabled:opacity-40"
          style={{ borderColor: 'rgba(248,113,113,0.25)', color: '#F87171' }}
        >
          {busy ? <Loader2 size={13} strokeWidth={1.8} className="animate-spin" /> : <Trash2 size={13} strokeWidth={1.8} />}
        </button>}
      </div>
    </Card>
  );
}

function AddCard({ label, onClick, disabled, disabledHint }: { label: string; onClick?: () => void; disabled?: boolean; disabledHint?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-[170px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed text-center transition-all duration-200 hover:-translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0"
      style={{ borderColor: 'rgba(var(--accent-mid-rgb),0.35)', background: 'rgba(var(--accent-mid-rgb),0.03)' }}
    >
      <div
        className="flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: 'rgba(var(--accent-mid-rgb),0.15)', color: 'var(--accent-light)' }}
      >
        <Plus size={18} strokeWidth={1.8} />
      </div>
      <span className="text-[13px] font-semibold text-blue-light">{label}</span>
      {disabled && disabledHint && (
        <span className="text-[11px] text-text-muted">{disabledHint}</span>
      )}
    </button>
  );
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 13) return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  if (digits.length === 12) return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4, 8)}-${digits.slice(8)}`;
  return phone;
}

// ─── Modal ────────────────────────────────────────────────────────────────

function ConnectModal({
  state,
  onChange,
  onSuccess,
}: {
  state: ModalState;
  onChange: (s: ModalState) => void;
  onSuccess: () => Promise<void>;
}) {
  const close = () => onChange({ stage: 'closed' });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={close}
    >
      <div
        className="relative max-h-[92dvh] w-full max-w-full overflow-y-auto rounded-t-2xl border p-4 sm:max-h-[88vh] sm:max-w-md sm:rounded-2xl sm:p-6"
        style={{ background: '#0F0F14', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={close}
          aria-label="Fechar"
          className="absolute right-4 top-4 text-text-muted hover:text-text-primary"
        >
          <X size={18} strokeWidth={1.6} />
        </button>

        {state.stage === 'form' && <FormStep onChange={onChange} />}
        {state.stage === 'qr' && (
          <QrStep
            connectionId={state.connectionId}
            instanceId={state.instanceId}
            qrcode={state.qrcode}
            error={state.error}
            onConnected={async () => {
              onChange({ stage: 'success', connectionId: state.connectionId });
              await onSuccess();
              setTimeout(close, 1500);
            }}
            onUpdate={(patch) => onChange({ ...state, ...patch })}
          />
        )}
        {state.stage === 'success' && <SuccessStep />}
      </div>
    </div>
  );
}

function FormStep({ onChange }: { onChange: (s: ModalState) => void }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /**
   * Quais servidores ESTE deploy tem, perguntado ao servidor.
   *
   * Não dá para resolver isso em build: `NEXT_PUBLIC_*` é inlined na hora do
   * `next build`, e o bundle é o mesmo para todos os clientes — o seletor
   * apareceria até em quem só tem uazapi. Já custou um deploy: a variável foi
   * para o `wrangler.jsonc` (runtime), o bundle nasceu sem ela, e a tela
   * seguiu tentando uazapi num deploy que não tem uazapi.
   */
  const [disponiveis, setDisponiveis] = useState<{ uazapi: boolean; evolution: boolean } | null>(null);
  const [provider, setProvider] = useState<'uazapi' | 'evolution'>('uazapi');

  useEffect(() => {
    let vivo = true;
    fetch('/api/connections/providers', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!vivo || !j?.providers) return;
        setDisponiveis(j.providers);
        if (j.padrao) setProvider(j.padrao);
      })
      .catch(() => {
        /* sem resposta, segue no padrão histórico (uazapi) */
      });
    return () => {
      vivo = false;
    };
  }, []);

  // Só faz o usuário escolher quando existe escolha de verdade.
  const mostrarSeletor = Boolean(disponiveis?.uazapi && disponiveis?.evolution);

  async function submit() {
    if (!name.trim()) {
      setErr('Informe um nome');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const res = await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name.trim(), provider }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(j.error ?? `HTTP ${res.status}`);
        setSubmitting(false);
        return;
      }
      onChange({
        stage: 'qr',
        connectionId: j.id,
        // uazapi devolve `instanceId`; Evolution devolve `instanceName`.
        instanceId: j.instanceId ?? j.instanceName,
        // A Evolution já devolve o QR no create — aproveitar evita um
        // round-trip e faz o código aparecer na hora, em vez de na primeira
        // batida do polling.
        qrcode: j.qrcode ?? null,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Erro');
      setSubmitting(false);
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-center gap-2 text-[15px] font-semibold text-text-primary">
        <MessageCircle size={18} strokeWidth={1.6} style={{ color: '#4ADE80' }} />
        Adicionar WhatsApp
      </div>
      <p className="mb-5 text-[12px] text-text-muted">
        Informe um nome pra identificar essa instância. O QR code será gerado em seguida.
      </p>

      <label className="mb-1 block text-[11px] uppercase tracking-wider text-text-muted">
        Nome da instância
      </label>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Ex: WhatsApp Principal"
        autoFocus
        disabled={submitting}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        className="mb-3 w-full rounded-lg border bg-[#18181F] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-blue-mid"
        style={{ borderColor: 'var(--border-subtle)' }}
      />

      {/*
        Só aparece quando o deploy tem OS DOIS servidores. Com um só, não há
        escolha a fazer e a tela continua idêntica à de antes.
      */}
      {mostrarSeletor && (
        <>
          <label className="mb-1 block text-[11px] uppercase tracking-wider text-text-muted">
            Servidor
          </label>
          <div className="mb-3 grid grid-cols-2 gap-2">
            {([
              ['uazapi', 'Padrão'],
              ['evolution', 'Servidor próprio'],
            ] as const).map(([valor, rotulo]) => (
              <button
                key={valor}
                type="button"
                onClick={() => setProvider(valor)}
                disabled={submitting}
                className="rounded-lg border px-3 py-2 text-[12px] transition-colors"
                style={{
                  borderColor: provider === valor ? 'var(--blue-mid)' : 'var(--border-subtle)',
                  background: provider === valor ? 'rgba(var(--accent-mid-rgb),0.10)' : '#18181F',
                  color: provider === valor ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {rotulo}
              </button>
            ))}
          </div>
        </>
      )}

      {err && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border p-2.5 text-[12px]"
          style={{ background: 'rgba(248,113,113,0.06)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }}>
          <AlertCircle size={13} strokeWidth={1.8} className="mt-[1px] shrink-0" />
          {err}
        </div>
      )}

      <button
        onClick={submit}
        disabled={submitting}
        className="btn-primary w-full"
      >
        {submitting ? <Loader2 size={13} strokeWidth={1.8} className="animate-spin" /> : <Plus size={13} strokeWidth={1.8} />}
        {submitting ? 'Criando…' : 'Criar instância'}
      </button>
    </div>
  );
}

function QrStep({
  connectionId,
  instanceId,
  qrcode,
  error,
  onConnected,
  onUpdate,
}: {
  connectionId: string;
  instanceId: string;
  qrcode: string | null;
  error?: string;
  onConnected: () => Promise<void> | void;
  onUpdate: (patch: { qrcode?: string | null; error?: string }) => void;
}) {
  const stoppedRef = useRef(false);
  /** Último QR publicado — para não repintar a imagem quando ele não mudou. */
  const ultimoQrRef = useRef<string | null>(null);
  /** Falhas seguidas. Zera a cada resposta boa. */
  const falhasRef = useRef(0);

  useEffect(() => {
    stoppedRef.current = false;
    falhasRef.current = 0;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (stoppedRef.current) return;
      try {
        const res = await fetch(`/api/connections/${connectionId}/qrcode`, { cache: 'no-store' });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          falhasRef.current += 1;
          // Só reclama depois de falhar seguidamente. Uma falha isolada é o
          // normal de um deploy acontecendo ou de uma oscilação de rede — e
          // mostrá-la na hora faz a tela alternar entre "erro 500" e
          // "aguardando conexão", que assusta sem informar.
          if (falhasRef.current >= TOLERANCIA_FALHAS) {
            onUpdate({ error: j.error ?? `HTTP ${res.status}` });
          }
        } else {
          const j = await res.json() as { qrcode: string | null; connected: boolean };
          falhasRef.current = 0;
          if (j.connected) {
            stoppedRef.current = true;
            await onConnected();
            return;
          }
          // Só publica quando o código MUDOU de verdade. O WhatsApp renova o
          // QR de tempos em tempos, mas entre renovações ele é o mesmo —
          // reenviar a mesma string recriava o <img> a cada ciclo e a imagem
          // piscava, o que atrapalha justamente na hora de escanear.
          if (j.qrcode !== ultimoQrRef.current) {
            ultimoQrRef.current = j.qrcode;
            onUpdate({ qrcode: j.qrcode, error: undefined });
          } else {
            onUpdate({ error: undefined });
          }
        }
      } catch (e) {
        falhasRef.current += 1;
        if (falhasRef.current >= TOLERANCIA_FALHAS) {
          onUpdate({ error: e instanceof Error ? e.message : 'Erro' });
        }
      }
      if (!stoppedRef.current) {
        timeout = setTimeout(poll, QR_POLL_INTERVAL_MS);
      }
    }

    poll();
    return () => {
      stoppedRef.current = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [connectionId, onConnected, onUpdate]);

  const qrSrc = qrcode
    ? (qrcode.startsWith('data:') ? qrcode : `data:image/png;base64,${qrcode}`)
    : null;

  return (
    <div>
      <div className="mb-1 text-[15px] font-semibold text-text-primary">Escaneie o QR Code</div>
      <p className="mb-4 text-[12px] text-text-muted">
        Abra o WhatsApp Business → Aparelhos conectados → Conectar um aparelho.
        <br />
        <span className="text-[11px] text-text-muted">ID: {instanceId}</span>
      </p>

      <div className="mb-4 flex aspect-square items-center justify-center rounded-xl border bg-white"
        style={{ borderColor: 'var(--border-subtle)' }}>
        {qrSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={qrSrc} alt="QR Code" className="h-full w-full object-contain p-3" />
        ) : (
          <div className="flex flex-col items-center gap-2 text-text-muted">
            <Loader2 size={24} strokeWidth={1.8} className="animate-spin" />
            <span className="text-[12px]">Gerando QR…</span>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border p-2.5 text-[12px]"
          style={{ background: 'rgba(248,113,113,0.06)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }}>
          <AlertCircle size={13} strokeWidth={1.8} className="mt-[1px] shrink-0" />
          {error}
        </div>
      )}

      <div className="text-center text-[11.5px] text-text-muted">
        <Loader2 size={11} strokeWidth={1.8} className="inline animate-spin" /> Aguardando conexão…
      </div>
    </div>
  );
}

function SuccessStep() {
  return (
    <div className="py-8 text-center">
      <CheckCircle2 size={36} strokeWidth={1.8} className="mx-auto mb-3" style={{ color: '#4ADE80' }} />
      <div className="text-[15px] font-semibold text-text-primary">Conectado!</div>
      <div className="mt-1 text-[12px] text-text-muted">Pronto pra receber mensagens.</div>
    </div>
  );
}
