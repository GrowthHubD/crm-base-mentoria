'use client';

type Props = {
  src: string;
  mimeType?: string | null;
};

/**
 * Renderiza sticker estático (webp/png) ou animado (webm/mp4).
 * Stickers animados do WhatsApp vêm em webm sem som.
 */
export default function StickerView({ src, mimeType }: Props) {
  const isVideo = (mimeType?.startsWith('video/') ?? false)
    || /\.(webm|mp4)(\?|#|$)/i.test(src);

  if (isVideo) {
    return (
      <video
        src={src}
        autoPlay
        loop
        muted
        playsInline
        className="max-h-40 max-w-[160px] rounded"
      />
    );
  }

  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="sticker" className="max-h-40 max-w-[160px]" />;
}
