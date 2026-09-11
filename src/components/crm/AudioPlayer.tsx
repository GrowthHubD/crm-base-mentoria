'use client';

import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Download } from 'lucide-react';

const SPEEDS = [1, 1.5, 2] as const;
type Speed = (typeof SPEEDS)[number];

function formatTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

type Props = {
  src: string;
  isOutbound?: boolean;
};

export default function AudioPlayer({ src, isOutbound }: Props) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrent(a.currentTime);
    const onMeta = () => setDuration(a.duration);
    const onEnd = () => setPlaying(false);
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('ended', onEnd);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('ended', onEnd);
    };
  }, []);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    } else {
      a.pause();
      setPlaying(false);
    }
  }

  function cycleSpeed() {
    const idx = SPEEDS.indexOf(speed);
    const next = SPEEDS[(idx + 1) % SPEEDS.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    const value = parseFloat(e.target.value);
    a.currentTime = value;
    setCurrent(value);
  }

  const accent = isOutbound ? 'var(--accent-light)' : '#4ADE80';
  const trackBg = 'rgba(255,255,255,0.12)';

  return (
    <div className="flex items-center gap-2 min-w-[220px]">
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? 'Pausar' : 'Reproduzir'}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={{ background: accent, color: '#0B0B10' }}
      >
        {playing ? <Pause size={14} strokeWidth={2.2} /> : <Play size={14} strokeWidth={2.2} className="ml-[1px]" />}
      </button>

      <div className="flex flex-1 flex-col gap-0.5">
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="0.1"
          value={current}
          onChange={seek}
          className="h-1 w-full appearance-none rounded-full"
          style={{
            background: `linear-gradient(to right, ${accent} ${duration ? (current / duration) * 100 : 0}%, ${trackBg} ${duration ? (current / duration) * 100 : 0}%)`,
            accentColor: accent,
          }}
        />
        <div className="flex justify-between text-[10px] text-text-muted tabular-nums">
          <span>{formatTime(current)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={cycleSpeed}
        className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold tabular-nums"
        style={{ background: 'rgba(255,255,255,0.08)', color: accent }}
        title="Velocidade"
      >
        {speed}x
      </button>

      <a
        href={src}
        download
        aria-label="Baixar áudio"
        title="Baixar"
        className="text-text-muted hover:text-text-primary"
      >
        <Download size={12} strokeWidth={1.7} />
      </a>

      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
    </div>
  );
}
