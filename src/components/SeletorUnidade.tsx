'use client';

/**
 * Seletor de unidade — só aparece para quem pode alternar.
 *
 * Ele é PREFERÊNCIA DE VISUALIZAÇÃO, não permissão. Quem está preso a uma
 * filial nem vê este componente, e mesmo que forjasse o cabeçalho o servidor
 * ignoraria: o recorte sai da sessão (ver `lib/units.ts` e
 * `units-escopo.test.ts`). Aqui é conveniência do dono, e nada mais.
 *
 * A escolha vive em `localStorage` e é enviada no cabeçalho `x-unit-id` por
 * `fetchComUnidade`. Guardar no navegador e não na URL é deliberado: o dono
 * abre o CRM já na filial em que trabalha, sem refazer a escolha a cada
 * navegação — e um link colado no WhatsApp não carrega o recorte de quem
 * copiou.
 */
import { useEffect, useState } from 'react';
import { ChevronDown, Building2 } from 'lucide-react';
import { useDados } from '@/lib/useDados';

export const CHAVE_UNIDADE = 'unidade-selecionada';
const TODAS = 'todas';

interface Unidade {
  id: string;
  name: string;
}

/** Lê a unidade escolhida. Fora do navegador devolve null. */
export function unidadeEscolhida(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(CHAVE_UNIDADE);
    return v && v !== TODAS ? v : null;
  } catch {
    return null;
  }
}

export default function SeletorUnidade({ podeAlternar }: { podeAlternar: boolean }) {
  const { dado } = useDados<{ units: Unidade[] }>(podeAlternar ? '/api/admin/units' : null);
  const [escolhida, setEscolhida] = useState<string>(TODAS);
  const [aberto, setAberto] = useState(false);

  useEffect(() => {
    try {
      setEscolhida(localStorage.getItem(CHAVE_UNIDADE) ?? TODAS);
    } catch { /* localStorage indisponível */ }
  }, []);

  const unidades = dado?.units ?? [];

  // Sem o módulo, sem permissão de alternar, ou com uma filial só: o seletor
  // não tem função. Mostrar um menu de um item é ruído.
  if (!podeAlternar || unidades.length < 2) return null;

  function escolher(valor: string) {
    setEscolhida(valor);
    setAberto(false);
    try {
      localStorage.setItem(CHAVE_UNIDADE, valor);
    } catch { /* ignora */ }
    // Recarrega a página inteira de propósito: o recorte muda TODA consulta da
    // tela, e revalidar cada uma na mão deixaria pedaços da filial anterior
    // visíveis por alguns instantes — o pior estado possível num painel que
    // separa dados por filial.
    window.location.reload();
  }

  const nomeAtual =
    escolhida === TODAS ? 'Todas as unidades' : unidades.find(u => u.id === escolhida)?.name ?? 'Todas as unidades';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setAberto(v => !v)}
        className="flex items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition-colors"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--color-card)' }}
        aria-haspopup="listbox"
        aria-expanded={aberto}
      >
        <Building2 size={15} style={{ color: 'var(--brand-purple)' }} />
        <span className="max-w-[160px] truncate text-text-primary">{nomeAtual}</span>
        <ChevronDown size={14} className="text-text-muted" />
      </button>

      {aberto && (
        <>
          {/* Fecha ao clicar fora, sem listener global no documento. */}
          <div className="fixed inset-0 z-40" onClick={() => setAberto(false)} />
          <ul
            role="listbox"
            className="absolute right-0 z-50 mt-1 min-w-[220px] overflow-hidden rounded-lg border py-1 shadow-xl"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--color-card)' }}
          >
            <ItemUnidade
              rotulo="Todas as unidades"
              ativo={escolhida === TODAS}
              onClick={() => escolher(TODAS)}
            />
            {unidades.map(u => (
              <ItemUnidade
                key={u.id}
                rotulo={u.name}
                ativo={escolhida === u.id}
                onClick={() => escolher(u.id)}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ItemUnidade({
  rotulo,
  ativo,
  onClick,
}: {
  rotulo: string;
  ativo: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={ativo}
        onClick={onClick}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] transition-colors hover:bg-[rgba(255,255,255,0.04)]"
        style={ativo ? { background: 'var(--brand-gradient-soft)', color: '#fff' } : { color: 'var(--color-text-secondary)' }}
      >
        {rotulo}
      </button>
    </li>
  );
}
