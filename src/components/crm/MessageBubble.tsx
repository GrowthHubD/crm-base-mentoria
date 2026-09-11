'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Bot, UserRound, CheckCheck, Clock, AlertCircle, Smartphone, FileText, Mail,
  ExternalLink, CornerDownRight, MoreVertical, Star, Trash2, Pencil, Loader2, Check, X, Reply,
} from 'lucide-react';
import type { Message } from '@/modules/messages/types';
import AudioPlayer from './AudioPlayer';
import StickerView from './StickerView';
import MediaLightbox from './MediaLightbox';

type Props = {
  m: Message;
  /** Imagens/vídeos consecutivos da mesma direção viram álbum — passe os outros aqui (sem incluir `m`). */
  galleryPeers?: Message[];
  /** Callback quando uma mutação acontece — pra parent reload. */
  onChanged?: () => void;
  /** Quando setado, o botão "responder" aparece no hover da bolha e chama com a msg. */
  onReply?: (m: Message) => void;
};

export default function MessageBubble({ m, galleryPeers = [], onChanged, onReply }: Props) {
  const isOutbound = m.direction === 'outbound';
  const [lightbox, setLightbox] = useState<{ src: string; type: 'image' | 'video'; fileName?: string | null } | null>(null);

  const isImageOrVideo = m.type === 'image' || m.type === 'video';
  const showAsAlbum = isImageOrVideo && galleryPeers.length > 0;

  // Nome do atendente exibido ACIMA da bolha (estilo grupo de WhatsApp).
  // Apenas o nome — sem cargo (cliente removeu "Atendente"/"Gerente" da
  // exibição em 09/06). Badge IA dentro da bolha continua visível.
  // Owner (celular do dono): sem nome aqui — vai como badge "Celular".
  const attendantLabel =
    isOutbound && (m.sender === 'human' || m.sender === 'ai') && m.senderName
      ? m.senderName
      : null;

  return (
    <div className={`group flex flex-col ${isOutbound ? 'items-end' : 'items-start'}`}>
      {attendantLabel && (
        <div
          className="mb-1 px-1 text-[11px] font-semibold"
          style={{ color: 'var(--accent-light)' }}
        >
          {attendantLabel}
        </div>
      )}
      <div className={`relative flex max-w-[85%] items-start gap-1 ${isOutbound ? 'flex-row-reverse' : 'flex-row'}`}>
        <div
          className={`max-w-full rounded-2xl text-[13px] leading-snug ${m.type === 'sticker' ? 'bg-transparent px-0 py-0' : 'px-3.5 py-2'}`}
          style={
            m.type === 'sticker'
              ? undefined
              : {
                  background: isOutbound ? 'var(--accent-deep)' : '#1C1C28',
                  color: '#F1F5F9',
                  borderTopRightRadius: isOutbound ? 4 : 16,
                  borderTopLeftRadius: isOutbound ? 16 : 4,
                }
          }
        >
          <SenderBadge sender={m.sender} isOutbound={isOutbound} hideHumanBadge={!!attendantLabel} canal={(m.metadata as { canal?: string } | null)?.canal} />
          {m.isStarred && (
            <Star
              size={11}
              strokeWidth={1.7}
              className="float-right ml-2 mt-0.5"
              style={{ color: '#FBBF24', fill: '#FBBF24' }}
            />
          )}

          {m.quotedContent && (
            <div className="mb-1.5 flex gap-1.5 rounded border-l-2 px-2 py-1 text-[11.5px] italic"
              style={{ borderColor: 'var(--accent-light)', background: 'rgba(var(--accent-light-rgb),0.08)', color: '#cbd5e1' }}>
              <CornerDownRight size={11} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[var(--accent-light)]" />
              <span className="line-clamp-2">{m.quotedContent}</span>
            </div>
          )}

          {/* ── Mídia ─────────────────────────────────────────────── */}
          {m.mediaUrl && m.type === 'image' && !showAsAlbum && (
            <ChatImage
              src={m.mediaUrl}
              onClick={() => setLightbox({ src: m.mediaUrl!, type: 'image', fileName: m.fileName })}
              className="mt-1 max-h-64 cursor-zoom-in rounded-md"
            />
          )}

          {showAsAlbum && (
            <ImageAlbum
              messages={[m, ...galleryPeers]}
              onOpen={(msg) => setLightbox({ src: msg.mediaUrl!, type: msg.type === 'video' ? 'video' : 'image', fileName: msg.fileName })}
            />
          )}

          {m.mediaUrl && m.type === 'video' && !showAsAlbum && (
            <video
              src={m.mediaUrl}
              controls
              preload="metadata"
              onClick={() => setLightbox({ src: m.mediaUrl!, type: 'video', fileName: m.fileName })}
              className="mt-1 max-h-72 cursor-zoom-in rounded-md"
            />
          )}

          {m.mediaUrl && m.type === 'audio' && (
            <div className="mt-1">
              <AudioPlayer src={m.mediaUrl} isOutbound={isOutbound} />
            </div>
          )}
          {!m.mediaUrl && m.type === 'audio' && (
            <div
              className="mt-1 inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11.5px]"
              style={{ background: 'rgba(248,113,113,0.10)', color: '#FCA5A5', border: '1px solid rgba(248,113,113,0.30)' }}
              title="A uazapi não enviou a mídia no webhook (precisa habilitar 'mídia inline' no painel da uazapi pra essa instância)."
            >
              <AlertCircle size={11} strokeWidth={1.8} />
              Áudio indisponível no servidor — ouça pelo WhatsApp
            </div>
          )}
          {!m.mediaUrl && (m.type === 'image' || m.type === 'video' || m.type === 'document' || m.type === 'sticker') && (
            <div
              className="mt-1 inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11.5px]"
              style={{ background: 'rgba(248,113,113,0.10)', color: '#FCA5A5', border: '1px solid rgba(248,113,113,0.30)' }}
              title="A uazapi não enviou a mídia no webhook (precisa habilitar 'mídia inline' no painel da uazapi pra essa instância)."
            >
              <AlertCircle size={11} strokeWidth={1.8} />
              Mídia indisponível — abra no WhatsApp
            </div>
          )}

          {m.mediaUrl && m.type === 'sticker' && (
            <StickerView src={m.mediaUrl} mimeType={m.mimeType} />
          )}

          {m.mediaUrl && m.type === 'document' && (
            <a
              href={m.mediaUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-blue-light hover:underline"
              style={{ background: 'rgba(255,255,255,0.06)' }}
            >
              <FileText size={14} strokeWidth={1.7} />
              <span className="max-w-[180px] truncate">{m.fileName ?? 'documento'}</span>
              <ExternalLink size={11} strokeWidth={1.7} className="shrink-0 opacity-70" />
            </a>
          )}

          {/* ── Texto / caption ──────────────────────────────────── */}
          {m.body && (
            <div className={`whitespace-pre-wrap ${m.mediaUrl && m.type !== 'sticker' ? 'mt-1' : ''}`}>
              {/* Pra áudios, o body é a transcrição automática (Whisper). Pequeno
                  hint visual pra o atendente saber que veio do modelo, não digitado. */}
              {m.type === 'audio' && (
                <div className="mb-0.5 text-[10px] uppercase tracking-wide text-text-muted opacity-80">
                  Transcrição
                </div>
              )}
              {m.body}
            </div>
          )}
        </div>

        <MessageMenu m={m} isOutbound={isOutbound} onChanged={onChanged} onReply={onReply} />
        <ReactionPicker messageId={m.id} onChanged={onChanged} />
      </div>

      {m.reactions && m.reactions.length > 0 && (
        <div className={`-mt-1 mb-1 flex flex-wrap gap-1 ${isOutbound ? 'pr-1 self-end' : 'pl-1 self-start'}`}>
          {Object.entries(
            m.reactions.reduce<Record<string, number>>((acc, r) => {
              acc[r.emoji] = (acc[r.emoji] ?? 0) + 1;
              return acc;
            }, {})
          ).map(([emoji, count]) => (
            <span
              key={emoji}
              className="inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[11px]"
              style={{ borderColor: 'var(--border-subtle)', background: '#15151B' }}
            >
              {emoji}
              {count > 1 && <span className="text-text-muted">{count}</span>}
            </span>
          ))}
        </div>
      )}

      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted">
        <Clock size={9} strokeWidth={1.6} />
        {new Date(m.timestamp).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
        {isOutbound && (
          <CheckCheck
            size={11}
            strokeWidth={1.6}
            className={m.status === 'read' ? 'text-blue-light' : m.status === 'delivered' ? 'text-text-secondary' : ''}
          />
        )}
        {m.status === 'failed' && (
          <span className="inline-flex items-center gap-1 text-[#F87171]">
            <AlertCircle size={9} strokeWidth={1.7} /> falhou
          </span>
        )}
        {m.status === 'pending' && (
          <span className="text-text-muted italic">enviando…</span>
        )}
      </div>

      {lightbox && (
        <MediaLightbox
          src={lightbox.src}
          type={lightbox.type}
          fileName={lightbox.fileName}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function SenderBadge({
  sender,
  isOutbound,
  hideHumanBadge,
  canal,
}: {
  sender: Message['sender'];
  isOutbound: boolean;
  hideHumanBadge?: boolean;
  /** `metadata.canal` da mensagem. `'email'` troca o selo; ausente = WhatsApp. */
  canal?: string;
}) {
  // E-mail vem ANTES de tudo, e nos dois sentidos.
  //
  // O selo existe para dizer POR ONDE a mensagem passou, e num histórico que
  // mistura WhatsApp e e-mail essa é a informação que muda a leitura: sem ela,
  // um e-mail enviado aparecia como "Celular" — que é o selo de mensagem
  // mandada pelo aparelho do dono — e sugeria que alguém tinha respondido pelo
  // WhatsApp quando ninguém tinha.
  if (canal === 'email') {
    return (
      <div className="mb-1 inline-flex items-center gap-1 rounded-md px-1.5 text-[9.5px] font-semibold"
        style={{ background: 'rgba(var(--accent-light-rgb),0.18)', color: 'var(--accent-light)' }}>
        <Mail size={9} strokeWidth={1.8} /> E-mail
      </div>
    );
  }

  if (!isOutbound) return null;

  if (sender === 'ai') {
    return (
      <div className="mb-1 inline-flex items-center gap-1 rounded-md px-1.5 text-[9.5px] font-semibold"
        style={{ background: 'rgba(var(--accent-light-rgb),0.18)', color: 'var(--accent-light)' }}>
        <Bot size={9} strokeWidth={1.8} /> IA
      </div>
    );
  }
  if (sender === 'human' && !hideHumanBadge) {
    return (
      <div className="mb-1 inline-flex items-center gap-1 rounded-md px-1.5 text-[9.5px] font-semibold"
        style={{ background: 'rgba(34,197,94,0.18)', color: '#4ADE80' }}>
        <UserRound size={9} strokeWidth={1.8} /> Atendente
      </div>
    );
  }
  if (sender === 'owner') {
    return (
      <div className="mb-1 inline-flex items-center gap-1 rounded-md px-1.5 text-[9.5px] font-semibold"
        style={{ background: 'rgba(251,191,36,0.18)', color: '#FBBF24' }}>
        <Smartphone size={9} strokeWidth={1.8} /> Celular
      </div>
    );
  }
  return null;
}

function ImageAlbum({
  messages,
  onOpen,
}: {
  messages: Message[];
  onOpen: (msg: Message) => void;
}) {
  const visible = messages.slice(0, 4);
  const extra = messages.length - visible.length;

  return (
    <div className="mt-1 grid w-[300px] gap-1 overflow-hidden rounded-md"
      style={{
        gridTemplateColumns: visible.length === 1 ? '1fr' : '1fr 1fr',
        gridTemplateRows: visible.length <= 2 ? '1fr' : '1fr 1fr',
      }}>
      {visible.map((msg, i) => (
        <button
          type="button"
          key={msg.id}
          onClick={() => onOpen(msg)}
          className="relative aspect-square overflow-hidden bg-black/30"
        >
          {msg.type === 'video' ? (
            <video src={msg.mediaUrl ?? ''} muted className="h-full w-full object-cover" />
          ) : (
            <AlbumTileImage src={msg.mediaUrl ?? ''} />
          )}
          {i === visible.length - 1 && extra > 0 && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-[16px] font-semibold text-white">
              +{extra}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * <img> resiliente pra bolha do chat. Resolve dois sintomas que o cliente viu
 * ao enviar um álbum de imagens:
 *   - "sumiu num primeiro momento": enquanto a foto baixa (algumas têm vários MB),
 *     reserva altura + fundo neutro em vez de colapsar a área pra 0.
 *   - "capa quebrada": se a URL morre (arquivo removido do storage, mídia da
 *     uazapi expirada), troca o glyph feio do navegador por um aviso limpo.
 */
function ChatImage({
  src,
  onClick,
  className,
}: {
  src: string;
  onClick?: () => void;
  className?: string;
}) {
  const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  if (status === 'error') {
    return (
      <div
        className="mt-1 inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[11.5px]"
        style={{ background: 'rgba(248,113,113,0.10)', color: '#FCA5A5', border: '1px solid rgba(248,113,113,0.30)' }}
        title="A imagem não está mais disponível no servidor — reenvie a foto ou abra no WhatsApp."
      >
        <AlertCircle size={11} strokeWidth={1.8} />
        Imagem indisponível
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      onClick={onClick}
      onLoad={() => setStatus('ok')}
      onError={() => setStatus('error')}
      className={className}
      style={
        status === 'loading'
          ? { minWidth: 140, minHeight: 120, background: 'rgba(255,255,255,0.05)' }
          : undefined
      }
    />
  );
}

/** Tile do álbum (grid). Espaço já é reservado pelo pai (aspect-square); aqui
 *  só trocamos a foto quebrada por um ícone neutro em vez do glyph do navegador. */
function AlbumTileImage({ src }: { src: string }) {
  const [errored, setErrored] = useState(false);

  if (errored) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#1C1C28] text-text-muted">
        <AlertCircle size={18} strokeWidth={1.6} />
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      onError={() => setErrored(true)}
      className="h-full w-full object-cover"
    />
  );
}

// ─── Reaction picker ─────────────────────────────────────────────────────

const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function ReactionPicker({
  messageId,
  onChanged,
}: {
  messageId: string;
  onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function react(emoji: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/messages/${messageId}/react`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emoji }),
      });
      if (res.ok) onChanged?.();
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative pt-1">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-label="Reagir"
        disabled={busy}
        className="flex h-6 w-6 items-center justify-center rounded text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary disabled:opacity-40"
      >
        {busy ? <Loader2 size={12} className="animate-spin" /> : <span className="text-[12px] leading-none">😊</span>}
      </button>

      {open && (
        <div
          className="absolute z-10 mt-1 flex gap-0.5 rounded-full border px-1.5 py-1 shadow-lg"
          style={{
            background: '#15151B',
            borderColor: 'var(--border-subtle)',
            // posiciona logo abaixo do botão, à direita pra não invadir o conteúdo
            left: 0,
          }}
        >
          {QUICK_REACTIONS.map(emoji => (
            <button
              key={emoji}
              type="button"
              disabled={busy}
              onClick={() => react(emoji)}
              className="flex h-7 w-7 items-center justify-center rounded-full text-[16px] transition hover:bg-white/8 disabled:opacity-40"
              aria-label={`Reagir com ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Context menu ────────────────────────────────────────────────────────

function MessageMenu({
  m, isOutbound, onChanged, onReply,
}: {
  m: Message;
  isOutbound: boolean;
  onChanged?: () => void;
  onReply?: (m: Message) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(m.body ?? '');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const canEdit = isOutbound && m.type === 'text' && !!m.externalId && m.status !== 'pending';
  const canDelete = true; // qualquer mensagem pode ser apagada do CRM

  async function call(action: 'toggleStar' | 'edit' | 'delete', payload?: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    try {
      const opts: RequestInit = action === 'delete'
        ? { method: 'DELETE' }
        : {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, ...(payload ?? {}) }),
          };
      const res = await fetch(`/api/messages/${m.id}`, opts);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(`Erro: ${j.error ?? res.status}`);
        return false;
      }
      onChanged?.();
      return true;
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col gap-1 rounded-lg border p-1.5"
        style={{ background: '#0F0F14', borderColor: 'var(--border-subtle)' }}>
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={2}
          autoFocus
          className="resize-none rounded bg-[#18181F] px-2 py-1 text-[12px] text-text-primary focus:outline-none"
          style={{ minWidth: 200 }}
        />
        <div className="flex justify-end gap-1">
          <button
            type="button"
            onClick={() => { setEditing(false); setEditText(m.body ?? ''); }}
            disabled={busy}
            aria-label="Cancelar"
            className="flex h-6 w-6 items-center justify-center rounded text-text-muted hover:text-text-primary"
          >
            <X size={11} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            onClick={async () => {
              if (!editText.trim() || editText === m.body) { setEditing(false); return; }
              const ok = await call('edit', { body: editText.trim() });
              if (ok) setEditing(false);
            }}
            disabled={busy || !editText.trim()}
            aria-label="Salvar"
            className="flex h-6 w-6 items-center justify-center rounded text-[#4ADE80] hover:bg-[rgba(74,222,128,0.1)] disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} strokeWidth={1.8} className="animate-spin" /> : <Check size={11} strokeWidth={2} />}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={ref} className="relative pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Opções"
        className="flex h-6 w-6 items-center justify-center rounded text-text-muted opacity-0 transition group-hover:opacity-100 hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary"
      >
        <MoreVertical size={13} strokeWidth={1.7} />
      </button>

      {open && (
        <div
          className="absolute z-10 mt-1 flex flex-col rounded-lg border py-1 shadow-lg"
          style={{
            background: '#0F0F14',
            borderColor: 'var(--border-subtle)',
            minWidth: 160,
            [isOutbound ? 'right' : 'left']: 0,
          } as React.CSSProperties}
        >
          {onReply && (
            <MenuItem
              icon={<Reply size={12} strokeWidth={1.7} />}
              label="Responder"
              onClick={() => { setOpen(false); onReply(m); }}
              busy={busy}
            />
          )}
          <MenuItem
            icon={<Star size={12} strokeWidth={1.7} style={m.isStarred ? { fill: '#FBBF24', color: '#FBBF24' } : {}} />}
            label={m.isStarred ? 'Desfavoritar' : 'Favoritar'}
            onClick={async () => { setOpen(false); await call('toggleStar'); }}
            busy={busy}
          />
          {canEdit && (
            <MenuItem
              icon={<Pencil size={12} strokeWidth={1.7} />}
              label="Editar"
              onClick={() => { setOpen(false); setEditing(true); }}
              busy={busy}
            />
          )}
          {canDelete && (
            <MenuItem
              icon={<Trash2 size={12} strokeWidth={1.7} />}
              label="Apagar"
              danger
              onClick={async () => {
                setOpen(false);
                if (!confirm('Apagar essa mensagem? (também remove no WhatsApp se enviada)')) return;
                await call('delete');
              }}
              busy={busy}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon, label, onClick, danger, busy,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-[rgba(255,255,255,0.04)] disabled:opacity-40"
      style={{ color: danger ? '#F87171' : '#cbd5e1' }}
    >
      {icon}
      {label}
    </button>
  );
}
