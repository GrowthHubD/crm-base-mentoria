'use client';

/**
 * Painel de nova coluna, abaixo da barra do CRM.
 *
 * É um painel inline, e não um menu flutuante, porque a barra já tem um: o de
 * filtros abre exatamente assim, no mesmo lugar e com a mesma pele
 * (`#111116`, borda sutil, grade de três colunas). Um dropdown com sombra ao
 * lado dele seria um segundo idioma na mesma barra.
 *
 * As colunas ocultas voltam por aqui. Esconder uma coluna pelo menu é fácil; se
 * o caminho de volta ficasse só na tela de configuração, o board teria uma
 * porta de mão única e a pessoa concluiria que perdeu a coluna.
 *
 * A etapa base é perguntada, e não assumida: um card numa coluna ancorada em
 * Respondidos continua sendo, para o sistema, um lead respondido — escala
 * igual, conta igual no dashboard, obedece o mesmo SLA. Escolher errado é um
 * erro silencioso que aparece semanas depois.
 */
import { useState } from 'react';
import { Columns3, Eye, Loader2, Palette, Plus, Type } from 'lucide-react';
import { ETAPAS_BASE, type StageColumn, type StageStatus } from '../types';
import type { NovaColuna } from '../hooks/useBoardColumns';

export interface NewColumnPanelProps {
  stages: StageColumn[];
  ocupado: boolean;
  onCriar: (nova: NovaColuna) => Promise<boolean>;
  onMostrar: (id: string) => void;
  onFechar: () => void;
}

const COR_INICIAL = '#8B5CF6';

const CAMPO =
  'w-full rounded-md border bg-[#18181F] px-2.5 py-1.5 text-[12px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none';
const ROTULO =
  'mb-1 flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-text-muted';

export default function NewColumnPanel({
  stages, ocupado, onCriar, onMostrar, onFechar,
}: NewColumnPanelProps) {
  const [nova, setNova] = useState<NovaColuna>({
    label: '',
    color: COR_INICIAL,
    baseStatus: 'attending' as StageStatus,
  });

  const ocultas = stages.filter((s) => !s.visible).sort((a, b) => a.position - b.position);
  const baseEscolhida = ETAPAS_BASE.find((b) => b.status === nova.baseStatus);

  async function criar() {
    if (!nova.label.trim()) return;
    const ok = await onCriar({ ...nova, label: nova.label.trim() });
    if (!ok) return;
    setNova({ label: '', color: COR_INICIAL, baseStatus: 'attending' });
    onFechar();
  }

  return (
    <div
      className="mb-5 rounded-xl border p-4"
      style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label className={ROTULO}>
            <Type size={12} strokeWidth={1.7} /> Nome da coluna
          </label>
          <input
            type="text"
            value={nova.label}
            maxLength={40}
            autoFocus
            placeholder="Ex: Proposta enviada"
            onChange={(e) => setNova({ ...nova, label: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') void criar(); }}
            className={CAMPO}
            style={{ borderColor: 'var(--border-subtle)' }}
          />
        </div>

        <div>
          <label className={ROTULO}>
            <Palette size={12} strokeWidth={1.7} /> Cor
          </label>
          {/* O seletor nativo é uma caixinha sem borda que destoa dos campos ao
              lado. Envolvê-lo num campo de verdade, com a amostra ocupando a
              altura toda, o deixa da mesma família visual. */}
          <div
            className="flex items-center gap-2 rounded-md border bg-[#18181F] px-2 py-1"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <input
              type="color"
              value={nova.color}
              onChange={(e) => setNova({ ...nova, color: e.target.value })}
              aria-label="Cor da coluna"
              className="h-[22px] w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
            />
            <span className="text-[12px] uppercase tabular-nums text-text-muted">{nova.color}</span>
          </div>
        </div>

        <div>
          <label className={ROTULO}>
            <Columns3 size={12} strokeWidth={1.7} /> De qual fila os cards saem
          </label>
          <select
            value={nova.baseStatus}
            onChange={(e) => setNova({ ...nova, baseStatus: e.target.value as StageStatus })}
            className={CAMPO}
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            {ETAPAS_BASE.map((b) => (
              <option key={b.status} value={b.status}>{b.label}</option>
            ))}
          </select>
          <div className="mt-1 text-[10px] text-text-muted">
            Conta como {baseEscolhida?.label.toLowerCase()} para escalação, SLA e relatórios. Muda só
            onde o card aparece no quadro.
          </div>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void criar()}
          disabled={ocupado || !nova.label.trim()}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {ocupado ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} strokeWidth={1.9} />}
          Criar coluna
        </button>
        <button
          type="button"
          onClick={onFechar}
          className="text-[11px] text-text-muted transition hover:text-text-secondary"
        >
          cancelar
        </button>
      </div>

      {ocultas.length > 0 && (
        <div className="mt-4 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="mb-1.5 text-[10.5px] uppercase tracking-wider text-text-muted">
            Ocultas do quadro
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ocultas.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onMostrar(s.id)}
                disabled={ocupado}
                title={`Mostrar ${s.label} no quadro`}
                className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition hover:brightness-125 disabled:opacity-40"
                style={{ background: `${s.color}1A`, color: s.color, border: `1px solid ${s.color}55` }}
              >
                <Eye size={11} strokeWidth={2} />
                {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
