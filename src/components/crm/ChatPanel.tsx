'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Send, Loader2, Paperclip, FileText, X, Camera, File as FileIcon, Filter as FilterIcon, Search, Calendar, Clock, CornerDownRight, AlertTriangle, Smile, Plus } from 'lucide-react';
import type { Message, MessageType } from '@/modules/messages/types';
import MessageBubble from './MessageBubble';
import AudioRecorder from './AudioRecorder';
import { useQuickReplies } from '@/modules/quick-replies/hooks/useQuickReplies';

const EmojiPicker = dynamic(() => import('./EmojiPicker'), { ssr: false });

interface MessagesResponse { messages: Message[]; hasMore?: boolean }

const POLL_INTERVAL_MS = 4_000;
const RECENT_WINDOW_SIZE = 100;
/** Tamanho da página ao carregar mensagens anteriores (scroll pro topo). */
const OLDER_PAGE_SIZE = 100;
/** Quão perto do topo (px) dispara o carregamento de anteriores. */
const OLDER_SCROLL_THRESHOLD_PX = 120;

/** Timestamp da msg em ms (fallback createdAt). Usado pra ordenar/reconciliar. */
function msgTime(m: Message): number {
  const t = m.timestamp ?? m.createdAt;
  return t ? new Date(t).getTime() : 0;
}

type Attachment = {
  url: string;
  fileName: string;
  mimeType: string;
  type: MessageType;
  previewUrl?: string;
};

/**
 * Painel de conversa reutilizável: messages + composer.
 * Usado tanto pela página /crm/[leadId] quanto pelo LeadModal (tab Conversa).
 */
export default function ChatPanel({
  leadId,
  onActivity,
  injectedDraft,
  onDraftConsumed,
  canal,
}: {
  leadId: string;
  onActivity?: () => void;
  /** Texto vindo do Suporte IA pra pré-preencher o composer (editável, não envia). */
  injectedDraft?: string | null;
  /** Avisa o pai que o rascunho já foi consumido (pra ele zerar o estado). */
  onDraftConsumed?: () => void;
  /**
   * Canal de conversa do lead. `'email'` troca o composer: entra o campo de
   * assunto e o envio sai pela rota de e-mail. Ausente = WhatsApp, que é o
   * comportamento de sempre.
   */
  canal?: string | null;
}) {
  const isEmail = canal === 'email';
  const [assunto, setAssunto] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState<ConversationFilter>(emptyFilter);
  /** Quando o user escolhe "Fotos" ou "Arquivo" no popover, define o filtro do
   * input file. Reusamos o mesmo `<input>` pra evitar dois pickers paralelos. */
  const [fileAccept, setFileAccept] = useState('image/*,video/*,audio/*,application/pdf');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Altura do scroll antes de prepend (pra restaurar a posição de leitura). */
  const restoreScrollRef = useRef<number | null>(null);
  /** Id da última msg na renderização anterior (decide auto-scroll pro fim). */
  const prevLastIdRef = useRef<string | null>(null);
  /** Já chegamos no começo da conversa (não há mais antigas pra carregar). */
  const reachedStartRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachWrapRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const activeLeadRef = useRef(leadId);
  const messageFlightRef = useRef<{
    leadId: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const messageEtagRef = useRef<{ leadId: string; value: string } | null>(null);
  activeLeadRef.current = leadId;

  // Textos rápidos mudam pouco e são compartilhados pela unidade. O hook usa
  // cache autenticado, dedupe de request e revalidação silenciosa; abrir outra
  // conversa não repete a consulta ao banco.
  const quickReplies = useQuickReplies();

  // Picker do slash command: aparece quando o text começa com "/" + (texto opcional).
  // Filtra atalhos por substring no shortcut OU no label. Tab/Enter insere o
  // primeiro; setas navegam; Esc fecha. Quando o user apaga a barra, fecha.
  const [pickerIndex, setPickerIndex] = useState(0);
  const slashMatch = text.startsWith('/') ? text.slice(1).toLowerCase() : null;
  const pickerOpen = slashMatch !== null;
  const pickerOptions = pickerOpen
    ? quickReplies.filter(q => {
        if (slashMatch.length === 0) return true;
        const inShort = q.shortcut.toLowerCase().includes(slashMatch);
        const inLabel = (q.label ?? '').toLowerCase().includes(slashMatch);
        return inShort || inLabel;
      })
    : [];
  useEffect(() => { setPickerIndex(0); }, [text]);

  function applyQuickReply(reply: { body: string; variations?: string[] | null }) {
    // Sorteia entre o body e as variações cadastradas (anti-bloqueio): assim a
    // mesma saudação não sai idêntica pra dezenas de contatos. Sem variações,
    // usa o body direto.
    const pool = [reply.body, ...(reply.variations ?? [])].filter(Boolean);
    const chosen = pool.length > 1 ? pool[Math.floor(Math.random() * pool.length)] : reply.body;
    setText(chosen);
    // foco depois pra cursor ir pro fim, e o auto-resize recalcula
    setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(chosen.length, chosen.length);
      }
    }, 0);
  }

  // Reply/quote: msg selecionada via menu "Responder" do MessageBubble.
  // Mostra preview acima do textarea; envio injeta quotedMessageId no payload.
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);

  // Detector de repetição (anti-ban): checa quantas vezes essa MESMA mensagem
  // já saiu na unit nas últimas horas (CRM + celular). Se passar do limite,
  // mostra alerta sugerindo variar. Debounce pra não bater a API a cada tecla.
  const REPETITION_ALERT_AT = 4; // alerta a partir da 5ª repetição
  const [repetition, setRepetition] = useState<{ count: number; windowHours: number } | null>(null);
  useEffect(() => {
    const t = text.trim();
    if (t.length < 25) { setRepetition(null); return; }
    let cancelled = false;
    const id = setTimeout(() => {
      fetch(`/api/dashboard/repetition-check?text=${encodeURIComponent(t)}`, { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then((j: { count?: number; windowHours?: number } | null) => {
          if (!cancelled && j && typeof j.count === 'number') {
            setRepetition({ count: j.count, windowHours: j.windowHours ?? 0 });
          }
        })
        .catch(() => {/* silencia — feature opcional */});
    }, 600);
    return () => { cancelled = true; clearTimeout(id); };
  }, [text]);

  // Auto-expand do textarea: cresce conforme o texto até MAX_TEXTAREA_PX, depois
  // habilita scroll interno. Recalcula via scrollHeight a cada mudança do texto
  // (reseta pra 'auto' antes pra deixar shrink quando o user apaga linhas).
  // Teto menor no celular: 160px lá comem quase toda a conversa, que é o que
  // a pessoa precisa ver enquanto responde. Passando do teto, rola por dentro.
  const [maxTextareaPx, setMaxTextareaPx] = useState(160);
  const [compactUi, setCompactUi] = useState(false);
  useEffect(() => {
    const sync = () => {
      const compact = window.innerWidth < 640;
      setCompactUi(compact);
      setMaxTextareaPx(compact ? 96 : 160);
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, maxTextareaPx)}px`;
  }, [text, maxTextareaPx]);

  // Autofocus ao montar (abrir chat / trocar de lead). Usa setTimeout pra
  // garantir que o DOM tá pronto e qualquer animação de mount já terminou —
  // sem isso, o foco às vezes era perdido pro modal.
  useEffect(() => {
    const id = setTimeout(() => textareaRef.current?.focus(), 50);
    return () => clearTimeout(id);
  }, [leadId]);

  // Rascunho transferido do Suporte IA: pré-preenche o composer (substitui o que
  // estiver lá — ao vir da aba Suporte o ChatPanel acabou de montar, sem texto
  // a perder), foca e avisa o pai pra zerar o estado (evita reinjetar).
  useEffect(() => {
    if (!injectedDraft) return;
    setText(injectedDraft);
    const id = setTimeout(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }, 60);
    onDraftConsumed?.();
    return () => clearTimeout(id);
  }, [injectedDraft, onDraftConsumed]);

  // Fecha popover ao clicar fora
  useEffect(() => {
    if (!attachOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (attachWrapRef.current && !attachWrapRef.current.contains(e.target as Node)) {
        setAttachOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [attachOpen]);

  // Carrega/atualiza a JANELA RECENTE (as 200 mais recentes). Reconcilia com o
  // que já está em tela: preserva páginas antigas carregadas via "carregar
  // anteriores" e refresca a janela recente (reflete msgs novas, edições e
  // exclusões). Antes isto buscava asc+limit (as 200 mais ANTIGAS) e conversas
  // longas congelavam — msg nova nunca entrava na janela.
  async function loadMessages() {
    const requestedLead = leadId;
    const existing = messageFlightRef.current;
    if (existing?.leadId === requestedLead) return existing.promise;
    existing?.controller.abort();

    const controller = new AbortController();
    const promise = (async () => {
      try {
        const res = await fetch(
          `/api/leads/${requestedLead}/messages?limit=${RECENT_WINDOW_SIZE}`,
          {
            cache: 'no-store',
            signal: controller.signal,
            headers: messageEtagRef.current?.leadId === requestedLead
              ? { 'If-None-Match': messageEtagRef.current.value }
              : undefined,
          }
        );
        if (res.status === 304) {
          if (activeLeadRef.current === requestedLead) {
            setError((current) => (current ? null : current));
          }
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as MessagesResponse;
        const recent = json.messages;
        if (controller.signal.aborted || activeLeadRef.current !== requestedLead) return;

        const etag = res.headers.get('etag');
        if (etag) messageEtagRef.current = { leadId: requestedLead, value: etag };

        setMessages((prev) => {
          if (recent.length === 0) return prev;
          const oldestRecent = msgTime(recent[0]);
          const older = prev.filter((message) => msgTime(message) < oldestRecent);
          const next = [...older, ...recent];
          const unchanged = next.length === prev.length && next.every((message, index) => {
            const previous = prev[index];
            return previous?.id === message.id
              && previous.status === message.status
              && previous.body === message.body
              && previous.mediaUrl === message.mediaUrl
              && JSON.stringify(previous.reactions ?? []) === JSON.stringify(message.reactions ?? []);
          });
          return unchanged ? prev : next;
        });
        setHasMore(!reachedStartRef.current && Boolean(json.hasMore));
        setError((current) => (current ? null : current));
      } catch (err) {
        if (!controller.signal.aborted && activeLeadRef.current === requestedLead) {
          setError(err instanceof Error ? err.message : 'Erro carregando mensagens');
        }
      } finally {
        if (messageFlightRef.current?.controller === controller) messageFlightRef.current = null;
      }
    })();

    messageFlightRef.current = { leadId: requestedLead, controller, promise };
    return promise;
  }

  // Carrega a página anterior (mais antiga) quando o atendente rola pro topo.
  async function loadOlder() {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    const oldest = messages[0];
    const cursor = oldest.timestamp ?? oldest.createdAt;
    if (!cursor) return;
    setLoadingOlder(true);
    try {
      const res = await fetch(
        `/api/leads/${leadId}/messages?limit=${OLDER_PAGE_SIZE}&before=${encodeURIComponent(new Date(cursor).toISOString())}`,
        { cache: 'no-store' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as MessagesResponse;
      const older = json.messages;
      if (older.length === 0) {
        reachedStartRef.current = true;
        setHasMore(false);
        return;
      }
      // Preserva a posição de leitura: guarda a altura atual; o layout effect
      // reposiciona o scroll após o prepend.
      if (scrollRef.current) restoreScrollRef.current = scrollRef.current.scrollHeight;
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        const fresh = older.filter((m) => !seen.has(m.id));
        return [...fresh, ...prev];
      });
      if (!json.hasMore) {
        reachedStartRef.current = true;
        setHasMore(false);
      }
    } catch {
      /* silencioso — tenta de novo no próximo scroll pro topo */
    } finally {
      setLoadingOlder(false);
    }
  }

  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    if (e.currentTarget.scrollTop <= OLDER_SCROLL_THRESHOLD_PX && hasMore && !loadingOlder) {
      void loadOlder();
    }
  }

  useEffect(() => {
    let cancelled = false;
    // Troca de lead: zera estado pra não misturar conversas no merge.
    reachedStartRef.current = false;
    prevLastIdRef.current = null;
    setMessages([]);
    setHasMore(false);
    void loadMessages();
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => void loadMessages(), POLL_INTERVAL_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void loadMessages();
        start();
      } else {
        stop();
        messageFlightRef.current?.controller.abort();
      }
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      messageFlightRef.current?.controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // Desce pro fim só quando há msg NOVA no fim (ou carga inicial) — não quando
  // carregamos antigas no topo (prepend não muda a última msg).
  useEffect(() => {
    const lastId = messages.length ? messages[messages.length - 1].id : null;
    if (lastId && lastId !== prevLastIdRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: prevLastIdRef.current ? 'smooth' : 'auto' });
    }
    prevLastIdRef.current = lastId;
  }, [messages]);

  // Após prepend de antigas, restaura a posição de scroll (mantém o ponto que o
  // atendente estava lendo em vez de pular pro topo).
  useLayoutEffect(() => {
    if (restoreScrollRef.current != null && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight - restoreScrollRef.current;
      restoreScrollRef.current = null;
    }
  }, [messages]);

  const filteredMessages = useMemo(() => applyConversationFilter(messages, filter), [messages, filter]);
  const renderGroups = useMemo(() => buildGroups(filteredMessages), [filteredMessages]);
  const filterActive = isFilterActive(filter);

  async function uploadFile(file: File): Promise<Attachment | null> {
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/uploads/media', { method: 'POST', body: fd });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { url: string; mimeType: string; fileName: string };
      return {
        url: j.url,
        mimeType: j.mimeType,
        fileName: j.fileName,
        type: detectMessageType(j.mimeType, j.fileName),
        previewUrl: j.mimeType.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro no upload');
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const att = await uploadFile(f);
    if (att) setAttachment(att);
  }

  /** Cola imagem da área de transferência (Print Screen / "copiar imagem"):
   * detecta um item de imagem no clipboard e sobe direto como anexo, sem passar
   * pelo botão de anexar. Print screen vem sem nome de arquivo, então geramos um.
   * Não interfere no colar de texto normal — só age quando há imagem. */
  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items || uploading || sending) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault(); // não deixa o caminho/lixo do clipboard cair no texto
      const ext = (file.type.split('/')[1] || 'png').toLowerCase();
      const named =
        file.name && file.name !== 'image.png'
          ? file
          : new File([file], `print-${Date.now()}.${ext}`, { type: file.type });
      const att = await uploadFile(named);
      if (att) setAttachment(att);
      return; // um anexo por vez (mesmo limite do botão)
    }
  }

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    if (sending) return;
    const trimmed = text.trim();
    if (!trimmed && !attachment) return;

    setSending(true);
    setError(null);
    try {
      // Lead de e-mail sai por outra rota: e-mail tem assunto e destinatário,
      // que a rota de mensagens — feita para WhatsApp — não carrega. Para quem
      // atende a tela é a mesma; a diferença fica aqui dentro.
      if (isEmail) {
        const resEmail = await fetch(`/api/leads/${leadId}/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assunto: assunto.trim() || '(sem assunto)', texto: trimmed }),
        });
        if (!resEmail.ok) {
          const errBody = await resEmail.json().catch(() => ({}));
          throw new Error((errBody as { error?: string })?.error ?? `HTTP ${resEmail.status}`);
        }
        setText('');
        // O assunto NÃO é limpo de propósito: uma troca de e-mails costuma
        // seguir no mesmo assunto, e reescrevê-lo a cada resposta é trabalho à
        // toa. Quem quiser mudar, muda.
        setReplyingTo(null);
        await loadMessages();
        onActivity?.();
        return;
      }

      const body: Record<string, unknown> = attachment
        ? {
            type: attachment.type,
            mediaUrl: attachment.url,
            mediaCaption: trimmed || undefined,
            fileName: attachment.fileName,
          }
        : { type: 'text', body: trimmed };
      if (replyingTo) body.quotedMessageId = replyingTo.id;

      const res = await fetch(`/api/leads/${leadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error((errBody as { error?: string })?.error ?? `HTTP ${res.status}`);
      }
      setText('');
      setAttachment(null);
      setReplyingTo(null);
      await loadMessages();
      onActivity?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro enviando');
    } finally {
      setSending(false);
    }
  }

  async function handleSendAudio(blob: Blob, mimeType: string) {
    const file = new File([blob], `voice-${Date.now()}.${extFromMime(mimeType)}`, { type: mimeType });
    const att = await uploadFile(file);
    if (!att) throw new Error('Upload falhou');
    const res = await fetch(`/api/leads/${leadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'audio', mediaUrl: att.url, fileName: att.fileName }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error((j as { error?: string })?.error ?? `HTTP ${res.status}`);
    }
    await loadMessages();
    onActivity?.();
  }

  /** Insere o emoji na posição atual do cursor do textarea (ou no fim, se sem
   * foco), preservando o resto do texto e reposicionando o caret depois dele.
   * Não fecha o picker — dá pra inserir vários seguidos. */
  function insertEmoji(emoji: string) {
    const ta = textareaRef.current;
    if (!ta) {
      setText((prev) => prev + emoji);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      const pos = start + emoji.length;
      node.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="flex h-full flex-col">
      <ConversationFilterBar
        open={filterOpen}
        onToggle={() => setFilterOpen((v) => !v)}
        filter={filter}
        onChange={setFilter}
        filterActive={filterActive}
        matchCount={filterActive ? filteredMessages.length : null}
        totalCount={messages.length}
      />
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-3 sm:px-5 sm:py-4"
        style={{ background: '#09090B' }}
      >
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12.5px] text-text-muted italic">
            Nenhuma mensagem ainda. Envie a primeira abaixo.
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12.5px] text-text-muted italic">
            Nenhuma mensagem bate com o filtro.
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-2">
            {loadingOlder && (
              <div className="flex justify-center py-1.5 text-text-muted">
                <Loader2 size={14} strokeWidth={1.7} className="animate-spin" />
              </div>
            )}
            {renderGroups.map((g) => (
              <MessageBubble key={g.head.id} m={g.head} galleryPeers={g.peers} onChanged={loadMessages} onReply={setReplyingTo} />
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      <form
        onSubmit={handleSend}
        className="border-t px-3 py-2 sm:px-5 sm:py-3"
        style={{ borderColor: 'var(--border-subtle)', background: '#0D0D12' }}
      >
        {error && (
          <div className="mb-2 rounded-md px-3 py-2 text-[11.5px]"
            style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}>
            {error}
          </div>
        )}

        {replyingTo && (
          <div className="mb-2 flex items-start gap-2 rounded-md border-l-2 px-2 py-1.5 text-[11.5px]"
            style={{ borderColor: 'var(--accent-light)', background: 'rgba(var(--accent-light-rgb),0.08)' }}>
            <CornerDownRight size={12} strokeWidth={1.7} className="mt-0.5 shrink-0 text-[var(--accent-light)]" />
            <div className="min-w-0 flex-1">
              <div className="text-[10.5px] font-semibold text-blue-light">
                Respondendo {replyingTo.direction === 'inbound' ? 'mensagem do lead' : 'sua mensagem'}
              </div>
              <div className="line-clamp-2 italic text-text-secondary">
                {(replyingTo.body ?? replyingTo.mediaCaption ?? `(${replyingTo.type})`).slice(0, 200)}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setReplyingTo(null)}
              aria-label="Cancelar resposta"
              className="text-text-muted hover:text-[#F87171]"
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </div>
        )}

        {attachment && (
          <div className="mb-2 flex items-center gap-2 rounded-md border px-2 py-1.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', background: '#111116' }}>
            {attachment.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={attachment.previewUrl} alt="" className="h-9 w-9 rounded object-cover" />
            ) : (
              <div className="flex h-9 w-9 items-center justify-center rounded text-text-muted"
                style={{ background: 'rgba(255,255,255,0.05)' }}>
                <FileText size={14} strokeWidth={1.7} />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-text-primary">{attachment.fileName}</div>
              <div className="text-[10px] text-text-muted">{attachment.type} · {attachment.mimeType}</div>
            </div>
            <button
              type="button"
              onClick={() => setAttachment(null)}
              aria-label="Remover anexo"
              className="text-text-muted hover:text-[#F87171]"
            >
              <X size={13} strokeWidth={1.8} />
            </button>
          </div>
        )}

        {repetition && repetition.count >= REPETITION_ALERT_AT && (
          <div className="mb-2 flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11.5px]"
            style={{ borderColor: 'rgba(245,158,11,0.4)', background: 'rgba(245,158,11,0.08)', color: '#FBBF24' }}>
            <AlertTriangle size={13} strokeWidth={1.8} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1 leading-relaxed">
              Essa mensagem já saiu <strong>{repetition.count}×</strong> nas últimas {repetition.windowHours}h.
              Enviar texto idêntico pra muitos contatos aumenta o risco de bloqueio do WhatsApp —
              vale variar a redação ou usar um atalho com variações.
            </div>
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept={fileAccept}
            onChange={handleFilePick}
            className="hidden"
          />
          <div ref={attachWrapRef} className="relative">
            <button
              type="button"
              onClick={() => setAttachOpen((v) => !v)}
              disabled={uploading || sending}
              aria-label="Anexar"
              title="Anexar"
              className="flex h-9 w-9 items-center justify-center rounded-lg border text-text-muted transition hover:bg-[rgba(var(--accent-light-rgb),0.08)] hover:text-blue-light disabled:opacity-40"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              {uploading ? <Loader2 size={14} strokeWidth={1.7} className="animate-spin" /> : <Paperclip size={15} strokeWidth={1.7} />}
            </button>
            {attachOpen && (
              <div
                className="absolute bottom-12 left-0 z-30 flex flex-row gap-2 whitespace-nowrap rounded-2xl border p-2 shadow-2xl"
                style={{ background: '#0F0F14', borderColor: 'var(--border-subtle)' }}
              >
                <AttachOption
                  label="Fotos"
                  icon={<Camera size={20} strokeWidth={1.7} />}
                  color="#EC4899"
                  onClick={() => {
                    setAttachOpen(false);
                    setFileAccept('image/*,video/*');
                    setTimeout(() => fileInputRef.current?.click(), 0);
                  }}
                />
                <AttachOption
                  label="Arquivo"
                  icon={<FileIcon size={20} strokeWidth={1.7} />}
                  color="var(--accent-light)"
                  onClick={() => {
                    setAttachOpen(false);
                    setFileAccept('image/*,video/*,audio/*,application/pdf');
                    setTimeout(() => fileInputRef.current?.click(), 0);
                  }}
                />
              </div>
            )}
          </div>

          <AudioRecorder onSend={handleSendAudio} disabled={uploading || sending} />

          <div className="relative">
            <button
              type="button"
              ref={emojiBtnRef}
              onClick={() => setEmojiOpen((v) => !v)}
              disabled={uploading || sending}
              aria-label="Emojis"
              title="Emojis"
              className={`flex h-9 w-9 items-center justify-center rounded-lg border transition hover:bg-[rgba(250,204,21,0.10)] hover:text-yellow-300 disabled:opacity-40 ${
                emojiOpen ? 'text-yellow-300' : 'text-text-muted'
              }`}
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <Smile size={16} strokeWidth={1.7} />
            </button>
            {emojiOpen && (
              <EmojiPicker onPick={insertEmoji} onClose={() => setEmojiOpen(false)} triggerRef={emojiBtnRef} />
            )}
          </div>

          <div className="relative flex-1">
            {pickerOpen && (
              <div
                className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-lg border shadow-xl"
                style={{ background: '#15151B', borderColor: 'var(--border-subtle)' }}
              >
                <div className="border-b px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-text-muted"
                  style={{ borderColor: 'var(--border-subtle)' }}>
                  Textos rápidos — ↑↓ navegar · Tab/Enter inserir · Esc fechar
                </div>
                {pickerOptions.map((q, i) => (
                  <button
                    key={q.id}
                    type="button"
                    onMouseEnter={() => setPickerIndex(i)}
                    onClick={() => applyQuickReply(q)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left transition ${
                      i === pickerIndex ? 'bg-blue-500/10' : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="flex w-full items-center gap-2">
                      <code className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-blue-light">
                        /{q.shortcut}
                      </code>
                      {q.label && <span className="text-[11.5px] text-text-secondary">{q.label}</span>}
                    </div>
                    <div className="line-clamp-2 text-[11.5px] text-text-muted whitespace-pre-wrap">
                      {q.body}
                    </div>
                  </button>
                ))}
                {pickerOptions.length === 0 && (
                  <div className="px-3 py-2.5 text-[11.5px] text-text-muted">
                    {quickReplies.length === 0
                      ? 'Nenhum texto rápido ainda. Crie o primeiro abaixo.'
                      : 'Nenhum atalho bate com o que você digitou.'}
                  </div>
                )}
                {/* Rodapé: gerenciar (criar/editar) abre a página em nova aba pra
                    não perder a conversa. Visível até no estado vazio. */}
                <a
                  href="/textos-rapidos"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="sticky bottom-0 flex items-center gap-1.5 border-t bg-[#15151B] px-3 py-2 text-[11.5px] font-medium text-blue-light transition hover:bg-blue-500/10"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <Plus size={13} strokeWidth={2} />
                  Gerenciar textos rápidos
                </a>
              </div>
            )}
            {/*
              Assunto — só no lead de e-mail. Fica ACIMA do corpo porque é a
              ordem em que se escreve um e-mail, e porque quem atende precisa
              ver que está mandando um e-mail antes de começar a digitar.
            */}
            {isEmail && (
              <input
                type="text"
                value={assunto}
                onChange={e => setAssunto(e.target.value)}
                placeholder="Assunto"
                maxLength={200}
                disabled={sending}
                className="mb-2 w-full rounded-lg border bg-[#18181F] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-blue-mid"
                style={{ borderColor: 'var(--border-subtle)' }}
              />
            )}
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              onPaste={handlePaste}
              onKeyDown={e => {
                // Picker tem prioridade sobre Enter envia / navegação normal.
                if (pickerOpen && pickerOptions.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setPickerIndex(i => Math.min(i + 1, pickerOptions.length - 1));
                    return;
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setPickerIndex(i => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                    e.preventDefault();
                    const chosen = pickerOptions[pickerIndex];
                    if (chosen) applyQuickReply(chosen);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    setText('');
                    return;
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder={attachment ? 'Caption (opcional)…' : compactUi ? 'Mensagem…' : 'Escreva uma mensagem… (Enter envia, Shift+Enter quebra linha, / atalhos)'}
              rows={1}
              className="w-full resize-none rounded-lg border bg-[#111116] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
              style={{ borderColor: 'var(--border-subtle)', maxHeight: maxTextareaPx, overflowY: 'auto' }}
            />
          </div>
          <button
            type="submit"
            disabled={(!text.trim() && !attachment) || sending}
            aria-label="Enviar"
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-blue-500 px-3 text-[13px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 hover:bg-blue-600 sm:px-4"
          >
            {sending ? (
              <Loader2 size={14} strokeWidth={1.7} className="animate-spin" />
            ) : (
              <Send size={14} strokeWidth={1.7} />
            )}
            {/* Rótulo some no celular: o ícone já diz, e o texto roubava a
                largura do campo de escrita, que é o que estava apertado. */}
            <span className="hidden sm:inline">Enviar</span>
          </button>
        </div>
      </form>
    </div>
  );
}

function AttachOption({
  label,
  icon,
  color,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center justify-center gap-1 rounded-xl border text-[11px] font-medium transition hover:brightness-125"
      style={{
        background: `${color}1a`,
        borderColor: `${color}55`,
        color,
        width: 76,
        height: 76,
        flexShrink: 0,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────

interface RenderGroup { head: Message; peers: Message[] }

function buildGroups(messages: Message[]): RenderGroup[] {
  const groups: RenderGroup[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (isEmptyMessage(m)) { i++; continue; }
    const isMedia = m.type === 'image' || m.type === 'video';
    if (!isMedia) {
      groups.push({ head: m, peers: [] });
      i++;
      continue;
    }
    const peers: Message[] = [];
    let j = i + 1;
    while (j < messages.length) {
      const next = messages[j];
      if (isEmptyMessage(next)) { j++; continue; }
      const sameDir = next.direction === m.direction;
      const isMediaPeer = next.type === 'image' || next.type === 'video';
      const sameSender = next.sender === m.sender;
      const sameStatus = next.status === m.status;
      if (!sameDir || !isMediaPeer || !sameSender || !sameStatus) break;
      peers.push(next);
      j++;
    }
    groups.push({ head: m, peers });
    i = j;
  }
  return groups;
}

function isEmptyMessage(m: Message): boolean {
  const hasBody = !!m.body && m.body.trim().length > 0;
  const hasMedia = !!m.mediaUrl;
  const hasQuote = !!m.quotedContent;
  return !hasBody && !hasMedia && !hasQuote;
}

function detectMessageType(mimeType: string, fileName: string): MessageType {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf' || /\.(pdf|docx?|xlsx?|pptx?|txt)$/i.test(fileName)) return 'document';
  return 'document';
}

function extFromMime(mime: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'bin';
}

// ─── Filtro interno da conversa ──────────────────────────────────────────
// Diferente do filtro do pipeline (escopo: leads), esse filtra MENSAGENS da
// conversa aberta — por palavra-chave, intervalo de data e intervalo de hora.

interface ConversationFilter {
  keyword: string;
  fromDate: string; // YYYY-MM-DD
  toDate: string;
  fromTime: string; // HH:mm
  toTime: string;
}

function emptyFilter(): ConversationFilter {
  return { keyword: '', fromDate: '', toDate: '', fromTime: '', toTime: '' };
}

function isFilterActive(f: ConversationFilter): boolean {
  return !!(f.keyword.trim() || f.fromDate || f.toDate || f.fromTime || f.toTime);
}

function applyConversationFilter(msgs: Message[], f: ConversationFilter): Message[] {
  if (!isFilterActive(f)) return msgs;
  const kw = f.keyword.trim().toLowerCase();
  const fromTs = f.fromDate ? new Date(`${f.fromDate}T00:00:00`).getTime() : null;
  const toTs = f.toDate ? new Date(`${f.toDate}T23:59:59`).getTime() : null;
  const fromMin = parseHHmm(f.fromTime);
  const toMin = parseHHmm(f.toTime);
  return msgs.filter((m) => {
    if (kw) {
      const haystack = (m.body ?? '') + ' ' + (m.mediaCaption ?? '') + ' ' + (m.quotedContent ?? '');
      if (!haystack.toLowerCase().includes(kw)) return false;
    }
    const ts = new Date(m.timestamp ?? m.createdAt).getTime();
    if (fromTs !== null && ts < fromTs) return false;
    if (toTs !== null && ts > toTs) return false;
    if (fromMin !== null || toMin !== null) {
      const d = new Date(ts);
      const minute = d.getHours() * 60 + d.getMinutes();
      if (fromMin !== null && minute < fromMin) return false;
      if (toMin !== null && minute > toMin) return false;
    }
    return true;
  });
}

function parseHHmm(value: string): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function ConversationFilterBar({
  open, onToggle, filter, onChange, filterActive, matchCount, totalCount,
}: {
  open: boolean;
  onToggle: () => void;
  filter: ConversationFilter;
  onChange: (f: ConversationFilter) => void;
  filterActive: boolean;
  matchCount: number | null;
  totalCount: number;
}) {
  return (
    <div className="border-b" style={{ borderColor: 'var(--border-subtle)', background: '#0D0D12' }}>
      <div className="flex items-center justify-between gap-2 px-5 py-2">
        <button
          type="button"
          onClick={onToggle}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] transition ${
            open || filterActive ? 'text-white' : 'text-text-muted hover:text-text-secondary'
          }`}
          style={
            open || filterActive
              ? { background: 'var(--accent-deep)', border: '1px solid rgba(var(--accent-light-rgb),0.4)' }
              : { background: '#111116', border: '1px solid var(--border-subtle)' }
          }
        >
          <FilterIcon size={12} strokeWidth={1.7} />
          Filtrar conversa
          {filterActive && (
            <span className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9.5px] font-bold"
              style={{ background: 'var(--accent-light)', color: '#0D0D12' }}>
              on
            </span>
          )}
        </button>
        {filterActive && matchCount !== null && (
          <div className="flex items-center gap-2 text-[11px] text-text-muted">
            <span>{matchCount} de {totalCount} mensagens</span>
            <button
              type="button"
              onClick={() => onChange(emptyFilter())}
              className="text-text-muted underline-offset-2 hover:text-text-secondary hover:underline"
            >
              limpar
            </button>
          </div>
        )}
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-2 px-5 pb-3 md:grid-cols-5">
          <FilterField label="Palavra-chave" icon={<Search size={11} strokeWidth={1.7} />} className="md:col-span-2">
            <input
              type="text"
              value={filter.keyword}
              onChange={(e) => onChange({ ...filter, keyword: e.target.value })}
              placeholder='ex: "piscina", "amanhã"'
              className="conv-filter-input"
            />
          </FilterField>
          <FilterField label="De (data)" icon={<Calendar size={11} strokeWidth={1.7} />}>
            <input
              type="date"
              value={filter.fromDate}
              onChange={(e) => onChange({ ...filter, fromDate: e.target.value })}
              className="conv-filter-input"
            />
          </FilterField>
          <FilterField label="Até (data)" icon={<Calendar size={11} strokeWidth={1.7} />}>
            <input
              type="date"
              value={filter.toDate}
              onChange={(e) => onChange({ ...filter, toDate: e.target.value })}
              className="conv-filter-input"
            />
          </FilterField>
          <FilterField label="Horário" icon={<Clock size={11} strokeWidth={1.7} />}>
            <div className="flex items-center gap-1">
              <input
                type="time"
                value={filter.fromTime}
                onChange={(e) => onChange({ ...filter, fromTime: e.target.value })}
                className="conv-filter-input"
              />
              <span className="text-text-muted">–</span>
              <input
                type="time"
                value={filter.toTime}
                onChange={(e) => onChange({ ...filter, toTime: e.target.value })}
                className="conv-filter-input"
              />
            </div>
          </FilterField>
        </div>
      )}
      <style jsx>{`
        :global(.conv-filter-input) {
          width: 100%;
          border-radius: 0.375rem;
          border: 1px solid var(--border-subtle);
          background: #18181F;
          padding: 0.3rem 0.55rem;
          font-size: 11.5px;
          color: var(--text-primary, #fff);
          color-scheme: dark;
        }
        :global(.conv-filter-input:focus) { outline: none; border-color: var(--accent-light); }
      `}</style>
    </div>
  );
}

function FilterField({
  label, icon, children, className,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className ?? ''}`}>
      <span className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted">
        {icon} {label}
      </span>
      {children}
    </label>
  );
}
