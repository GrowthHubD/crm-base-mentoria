'use client';

/**
 * Menu de uma coluna do quadro: mover, esconder e excluir.
 *
 * O arraste do cabeçalho é o caminho principal de reordenar; estas setas são o
 * caminho que sempre funciona. A API de drag-and-drop do navegador não dispara
 * com o dedo, e sem elas não haveria como mexer na ordem pelo celular — o mesmo
 * motivo pelo qual o card tem os atalhos de mover.
 *
 * A confirmação de exclusão é INLINE, e não `confirm()` do navegador: o diálogo
 * nativo trava a aba inteira, e esta tela tem um poll de 2 segundos rodando
 * atrás. Além disso a pergunta precisa caber a explicação de que nenhum lead é
 * apagado, o que um `confirm()` diz mal.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, EyeOff, MoreVertical, Trash2 } from 'lucide-react';
import type { StageColumn } from '../types';

export interface ColumnMenuProps {
  stage: StageColumn;
  /** Cor da coluna, para o botão não destoar do cabeçalho. */
  cor: string;
  podeMoverEsquerda: boolean;
  podeMoverDireita: boolean;
  ocupado: boolean;
  onMoverPasso: (direcao: -1 | 1) => void;
  onOcultar: () => void;
  onExcluir: () => void;
}

export default function ColumnMenu({
  stage, cor, podeMoverEsquerda, podeMoverDireita, ocupado,
  onMoverPasso, onOcultar, onExcluir,
}: ColumnMenuProps) {
  const [aberto, setAberto] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const caixa = useRef<HTMLDivElement | null>(null);

  // Fecha ao clicar fora ou apertar Esc. Sem isso o menu fica aberto por cima
  // dos cards enquanto a pessoa tenta arrastar um.
  useEffect(() => {
    if (!aberto) return;
    function fora(e: MouseEvent) {
      if (!caixa.current?.contains(e.target as Node)) fechar();
    }
    function tecla(e: KeyboardEvent) {
      if (e.key === 'Escape') fechar();
    }
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', tecla);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('keydown', tecla);
    };
  }, [aberto]);

  function fechar() {
    setAberto(false);
    setConfirmando(false);
  }

  function agir(fn: () => void) {
    fn();
    fechar();
  }

  return (
    // `draggable={false}` porque este menu vive DENTRO do cabeçalho, que é a
    // alça de arrastar a coluna. Sem isso, apertar o botão e mexer o mouse um
    // milímetro começaria a arrastar a coluna em vez de abrir o menu.
    <div ref={caixa} draggable={false} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-label={`Opções da coluna ${stage.label}`}
        title="Opções da coluna"
        className="flex h-6 w-6 items-center justify-center rounded-md opacity-70 transition hover:opacity-100"
        style={{ color: cor }}
      >
        <MoreVertical size={14} strokeWidth={2} />
      </button>

      {aberto && (
        <div
          className="absolute right-0 top-full z-30 mt-1 w-[210px] overflow-hidden rounded-xl border py-1 shadow-lg"
          style={{
            background: '#0F0F14',
            borderColor: 'var(--border-subtle)',
            boxShadow: '0 10px 24px rgba(0,0,0,0.45)',
          }}
        >
          <ItemMenu
            icone={<ArrowLeft size={13} strokeWidth={1.9} />}
            texto="Mover para a esquerda"
            desabilitado={!podeMoverEsquerda || ocupado}
            onClick={() => agir(() => onMoverPasso(-1))}
          />
          <ItemMenu
            icone={<ArrowRight size={13} strokeWidth={1.9} />}
            texto="Mover para a direita"
            desabilitado={!podeMoverDireita || ocupado}
            onClick={() => agir(() => onMoverPasso(1))}
          />

          <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />

          <ItemMenu
            icone={<EyeOff size={13} strokeWidth={1.9} />}
            texto="Ocultar do quadro"
            desabilitado={ocupado}
            onClick={() => agir(onOcultar)}
          />
          <p className="px-3 pb-1 pt-0.5 text-[10.5px] leading-snug text-text-muted">
            Esconder não apaga nem move lead: os cards voltam a aparecer quando
            a coluna for reativada.
          </p>

          {stage.isCustom ? (
            <>
              <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
              {confirmando ? (
                <div className="px-3 py-2">
                  <p className="mb-2 text-[11px] leading-snug text-text-secondary">
                    Excluir <strong className="text-text-primary">{stage.label}</strong>? Os cards
                    voltam para a coluna de origem. Nenhum lead é apagado.
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => agir(onExcluir)}
                      disabled={ocupado}
                      className="rounded-lg px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-40"
                      style={{ background: 'rgba(255,96,96,0.14)', color: '#ff6060', border: '1px solid rgba(255,96,96,0.45)' }}
                    >
                      Excluir
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmando(false)}
                      className="rounded-lg border px-2.5 py-1 text-[11px] text-text-muted transition hover:text-text-primary"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <ItemMenu
                  icone={<Trash2 size={13} strokeWidth={1.9} />}
                  texto="Excluir coluna"
                  perigo
                  desabilitado={ocupado}
                  onClick={() => setConfirmando(true)}
                />
              )}
            </>
          ) : (
            <>
              <div className="my-1 border-t" style={{ borderColor: 'var(--border-subtle)' }} />
              <p className="px-3 py-1.5 text-[10.5px] leading-snug text-text-muted">
                Esta é uma coluna de fábrica: ela carrega a regra de escalação,
                de SLA e de conversão, por isso se esconde em vez de ser
                apagada.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ItemMenu({
  icone, texto, onClick, desabilitado, perigo,
}: {
  icone: React.ReactNode;
  texto: string;
  onClick: () => void;
  desabilitado?: boolean;
  perigo?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={desabilitado}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition hover:bg-[rgba(255,255,255,0.05)] disabled:opacity-30 disabled:hover:bg-transparent"
      style={{ color: perigo ? '#ff6060' : 'var(--text-secondary)' }}
    >
      {icone}
      {texto}
    </button>
  );
}
