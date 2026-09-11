'use client';

/**
 * Gatilho de "Nova coluna" na barra do CRM, ao lado dos Filtros.
 *
 * Mora na barra, e não no fim da faixa de colunas: num funil de quinze etapas o
 * fim da faixa está a três telas de rolagem à direita, e a ação sumiria
 * justamente para quem tem mais colunas.
 *
 * Veste o botão de AÇÃO do sistema — fundo `blue-primary`, texto branco,
 * ícone de mais —, o mesmo de "Novo usuário" no painel de usuários. O token
 * troca sozinho com a marca do deploy (`html[data-marca]`), então na Acme ele
 * sai vermelho sem uma linha de condicional. Diferente de propósito do botão
 * de Filtros ao lado, que é um alternador e por isso é neutro: criar coluna não
 * é filtro, e dois pílulas cinzas idênticas na mesma barra leriam como par.
 *
 * Só o gatilho: o formulário abre num painel abaixo da barra, igual ao de
 * filtros. Ver `NewColumnPanel`.
 */
import { Plus } from 'lucide-react';

export interface NewColumnButtonProps {
  aberto: boolean;
  onToggle: () => void;
  /** Quantas colunas estão fora do quadro. 0 esconde o contador. */
  ocultas: number;
}

export default function NewColumnButton({ aberto, onToggle, ocultas }: NewColumnButtonProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={aberto}
      title="Criar coluna, ou trazer de volta uma que está oculta"
      className="inline-flex h-full items-center gap-1.5 whitespace-nowrap rounded-xl bg-blue-primary px-3 text-[12px] font-semibold text-white transition hover:bg-blue-mid"
    >
      <Plus size={13} strokeWidth={2} />
      {/* No celular fica só o "+": a barra tem as abas de conexão do lado, que
          são a navegação principal ali, e o rótulo inteiro comia metade da
          largura delas. */}
      <span className="hidden sm:inline">Nova coluna</span>
      {/* Único aviso de que existe coluna fora do quadro — sem ele, "sumiu uma
          coluna" não tem para onde apontar. Discreto de propósito: é um aviso
          dentro de um botão, não um segundo botão. */}
      {ocultas > 0 && (
        <span
          className="inline-flex h-4 min-w-[16px] items-center justify-center rounded-full bg-white/30 px-1 text-[9.5px] font-bold"
          title={`${ocultas} ${ocultas === 1 ? 'coluna oculta' : 'colunas ocultas'}`}
        >
          {ocultas}
        </span>
      )}
    </button>
  );
}
