'use client';

import { useEffect, useRef, useState } from 'react';
import { Mic, Square, Send, Trash2, Loader2 } from 'lucide-react';

type Props = {
  onSend: (blob: Blob, mimeType: string) => Promise<void> | void;
  disabled?: boolean;
};

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Gravação de voice note via MediaRecorder API.
 * Estados: idle → recording → review → sending.
 *
 * Output formato: webm/opus (browser nativo). O backend (sendAudio) precisa
 * converter pra ogg/opus antes de mandar pra uazapi com `ptt=true` — usamos
 * `ensureOggDataUri` em audio-convert.ts no worker outbound. Aqui só
 * capturamos e mandamos como está.
 */
export default function AudioRecorder({ onSend, disabled }: Props) {
  const [state, setState] = useState<'idle' | 'recording' | 'review' | 'sending'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const mimeOptions = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg'];
      const mime = mimeOptions.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRef.current = mr;
      chunksRef.current = [];

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const finalMime = mr.mimeType || 'audio/webm';
        const finalBlob = new Blob(chunksRef.current, { type: finalMime });
        setBlob(finalBlob);
        setPreviewUrl(URL.createObjectURL(finalBlob));
        setState('review');
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      };

      mr.start(250);
      startedAtRef.current = Date.now();
      setElapsed(0);
      setState('recording');

      tickRef.current = setInterval(() => {
        setElapsed(Date.now() - startedAtRef.current);
      }, 200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao acessar microfone');
    }
  }

  function stop() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    mediaRef.current?.stop();
  }

  function discard() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setBlob(null);
    setPreviewUrl(null);
    setState('idle');
    setElapsed(0);
  }

  async function send() {
    if (!blob) return;
    setState('sending');
    try {
      await onSend(blob, blob.type || 'audio/webm');
      discard();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao enviar');
      setState('review');
    }
  }

  if (state === 'idle') {
    return (
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        aria-label="Gravar áudio"
        title="Gravar áudio"
        className="flex h-9 w-9 items-center justify-center rounded-lg border text-text-muted transition hover:bg-[rgba(74,222,128,0.08)] hover:text-[#4ADE80] disabled:opacity-40"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <Mic size={15} strokeWidth={1.7} />
      </button>
    );
  }

  if (state === 'recording') {
    return (
      <div className="flex h-9 items-center gap-2 rounded-lg border px-2"
        style={{ borderColor: 'rgba(248,113,113,0.4)', background: 'rgba(248,113,113,0.06)' }}>
        <span className="inline-flex h-2 w-2 animate-pulse rounded-full" style={{ background: '#F87171' }} />
        <span className="text-[11.5px] tabular-nums text-[#F87171]">{formatTime(elapsed)}</span>
        <button
          type="button"
          onClick={stop}
          aria-label="Parar gravação"
          className="flex h-6 w-6 items-center justify-center rounded-full"
          style={{ background: '#F87171', color: '#0B0B10' }}
        >
          <Square size={11} strokeWidth={2.2} />
        </button>
      </div>
    );
  }

  // state === 'review' || 'sending'
  return (
    <div className="flex h-9 items-center gap-1.5 rounded-lg border px-2"
      style={{ borderColor: 'var(--border-subtle)', background: '#18181F' }}>
      {previewUrl && <audio src={previewUrl} controls className="h-7 max-w-[160px]" />}
      <button
        type="button"
        onClick={discard}
        disabled={state === 'sending'}
        aria-label="Descartar"
        className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:text-[#F87171] disabled:opacity-40"
      >
        <Trash2 size={12} strokeWidth={1.7} />
      </button>
      <button
        type="button"
        onClick={send}
        disabled={state === 'sending'}
        aria-label="Enviar áudio"
        className="flex h-7 w-7 items-center justify-center rounded-full disabled:opacity-50"
        style={{ background: '#4ADE80', color: '#0B0B10' }}
      >
        {state === 'sending' ? <Loader2 size={12} strokeWidth={2.2} className="animate-spin" /> : <Send size={11} strokeWidth={2.2} />}
      </button>
      {error && <span className="text-[10px] text-[#F87171]">{error}</span>}
    </div>
  );
}
