'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Seletor de emojis self-contained — sem dependência externa. Grid com abas de
 * categoria (estilo WhatsApp). Mantém-se aberto após escolher (dá pra inserir
 * vários seguidos); fechamento fica a cargo do pai (clique fora / Esc / toggle).
 *
 * Conjunto curado pro contexto de atendimento por WhatsApp: rostos, gestos,
 * comemoração, negócios e símbolos comuns. Não é a lista Unicode inteira de
 * propósito — é o que de fato se usa atendendo cliente.
 */

interface EmojiCategory {
  id: string;
  label: string;
  /** Ícone da aba (o próprio emoji representativo). */
  tab: string;
  emojis: string[];
}

const CATEGORIES: EmojiCategory[] = [
  {
    id: 'smileys',
    label: 'Rostos',
    tab: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🙂', '🙃',
      '😊', '😇', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚',
      '😋', '😛', '😝', '😜', '🤪', '🤗', '🤭', '🤫', '🤔', '😏',
      '😶', '😐', '😑', '😬', '🙄', '😮', '😯', '😲', '😳', '🥺',
      '😢', '😭', '😤', '😠', '😡', '🤯', '😱', '😨', '😰', '😥',
      '😎', '🤓', '🥳', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤥',
    ],
  },
  {
    id: 'gestos',
    label: 'Gestos',
    tab: '👍',
    emojis: [
      '👍', '👎', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙',
      '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️', '🖖', '👋',
      '🤝', '🙏', '✍️', '💪', '🙌', '👏', '🤲', '👐', '🫶', '🫰',
      '🙆', '🙅', '🤷', '🤦', '💁', '🙋', '🧏', '🙇', '🫡', '🤳',
    ],
  },
  {
    id: 'amor',
    label: 'Amor',
    tab: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '♥️',
      '😍', '🥰', '😘', '😻', '💋', '💌', '🫂', '👨‍❤️‍👨', '💑', '💐',
    ],
  },
  {
    id: 'festa',
    label: 'Festa',
    tab: '🎉',
    emojis: [
      '🎉', '🎊', '🥳', '🎈', '🎁', '🎂', '🍾', '🥂', '🍻', '🍹',
      '✨', '🌟', '⭐', '💫', '🔥', '💥', '🎆', '🎇', '🪅', '🎀',
      '🏆', '🥇', '🎯', '👑', '💎', '🌹', '🌸', '🌺', '🍓', '🍫',
    ],
  },
  {
    id: 'negocios',
    label: 'Negócios',
    tab: '💼',
    emojis: [
      '💼', '📅', '🗓️', '🕐', '⏰', '📍', '🏠', '🚗', '📦', '🛒',
      '💳', '💰', '💵', '🧾', '📊', '📈', '📝', '✍️', '📎', '🔑',
      '📲', '📞', '📧', '💬', '✅', '📸', '🔔', '⚡', '🎯', '🤝',
    ],
  },
  {
    id: 'simbolos',
    label: 'Símbolos',
    tab: '✅',
    emojis: [
      '✅', '☑️', '✔️', '❌', '⭕', '❗', '❓', '⚠️', '🚫', '💯',
      '➕', '➖', '✖️', '➗', '🔝', '🔜', '🆗', '🆕', '🔴', '🟢',
      '🟡', '🔵', '⚫', '⚪', '👀', '💬', '💭', '🗨️', '📌', '🔔',
    ],
  },
];

export default function EmojiPicker({
  onPick,
  onClose,
  triggerRef,
}: {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Botão que abre o picker. Precisa ser ignorado no clique-fora: sem isso o
   *  toque nele FECHA (pelo listener) e o clique seguinte REABRE, e o picker
   *  parece que nunca fecha — foi o que aconteceu no celular. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}) {
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Fecha ao tocar/clicar fora ou apertar Esc.
  useEffect(() => {
    const onDoc = (e: Event) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // `pointerdown` e não `mousedown`: em toque o mousedown só chega depois
    // (ou não chega), então no celular o picker abria e não fechava mais.
    document.addEventListener('pointerdown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, triggerRef]);

  const category = CATEGORIES[active];

  return (
    <div
      ref={rootRef}
      // Mobile: folha ancorada na base, largura total — um popover de 300px
      // flutuando sobre a conversa cobria justamente o que a pessoa quer ler.
      // Desktop (sm+): volta a ser popover acima do botão.
      className="fixed inset-x-0 bottom-0 z-50 w-full rounded-t-2xl border-t shadow-2xl sm:absolute sm:inset-x-auto sm:bottom-full sm:left-0 sm:mb-2 sm:w-[300px] sm:rounded-2xl sm:border sm:border-t"
      style={{ background: '#0F0F14', borderColor: 'var(--border-subtle)' }}
    >
      {/* Abas de categoria */}
      <div
        className="flex items-center gap-0.5 border-b px-1.5 py-1"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        {CATEGORIES.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setActive(i)}
            aria-label={c.label}
            title={c.label}
            className={`flex h-8 w-8 items-center justify-center rounded-lg text-[17px] leading-none transition ${
              i === active ? 'bg-[rgba(var(--accent-light-rgb),0.16)]' : 'hover:bg-white/5'
            }`}
          >
            {c.tab}
          </button>
        ))}
      </div>

      {/* Grid de emojis */}
      <div className="max-h-[212px] overflow-y-auto p-2">
        <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
          {category.label}
        </div>
        <div className="grid grid-cols-8 gap-0.5">
          {category.emojis.map((emoji, i) => (
            <button
              key={`${category.id}-${i}`}
              type="button"
              onClick={() => onPick(emoji)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-[19px] leading-none transition hover:bg-white/10"
            >
              {emoji}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
