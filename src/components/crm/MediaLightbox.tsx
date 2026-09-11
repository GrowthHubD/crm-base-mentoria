'use client';

import { useEffect } from 'react';
import { X, Download } from 'lucide-react';

type Props = {
  src: string;
  type: 'image' | 'video';
  fileName?: string | null;
  onClose: () => void;
};

export default function MediaLightbox({ src, type, fileName, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.92)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div className="absolute right-4 top-4 flex items-center gap-2">
        <a
          href={src}
          download={fileName ?? undefined}
          onClick={(e) => e.stopPropagation()}
          aria-label="Baixar"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[rgba(255,255,255,0.1)] text-white hover:bg-[rgba(255,255,255,0.18)]"
        >
          <Download size={16} strokeWidth={1.7} />
        </a>
        <button
          onClick={onClose}
          aria-label="Fechar"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-[rgba(255,255,255,0.1)] text-white hover:bg-[rgba(255,255,255,0.18)]"
        >
          <X size={16} strokeWidth={1.8} />
        </button>
      </div>

      <div className="max-h-[90vh] max-w-[90vw]" onClick={(e) => e.stopPropagation()}>
        {type === 'image' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="" className="max-h-[90vh] max-w-[90vw] object-contain" />
        ) : (
          <video src={src} controls autoPlay className="max-h-[90vh] max-w-[90vw]" />
        )}
      </div>
    </div>
  );
}
