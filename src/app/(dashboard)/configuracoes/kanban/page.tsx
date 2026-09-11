'use client';

/**
 * Configuração das colunas do kanban.
 *
 * Duas naturezas convivem na mesma lista:
 *
 *   - as CINCO de fábrica, que carregam a regra (escalação por tempo, SLA,
 *     conversão). Podem ser renomeadas, recoloridas, reordenadas e escondidas,
 *     mas não apagadas — apagá-las deixaria sem lugar os leads que não estão em
 *     nenhuma coluna personalizada;
 *   - as PERSONALIZADAS, criadas aqui. Cada uma se ancora numa das cinco: um
 *     card em "Proposta enviada" ancorada em Respondidos continua sendo, para o
 *     sistema, um lead respondido.
 *
 * Salva o quadro inteiro de uma vez porque posição é relativa.
 */
import { useEffect, useState } from 'react';
import {
  AlertCircle, Check, Eye, EyeOff, Loader2, RotateCcw, ArrowUp, ArrowDown, Plus, Trash2, X,
} from 'lucide-react';
import Card from '@/components/Card';
import Loading from '@/components/Loading';

type BaseStatus = 'new' | 'priority' | 'urgency' | 'attending' | 'converted';

interface Stage {
  id: string;
  status: BaseStatus;
  isCustom: boolean;
  label: string;
  color: string;
  position: number;
  visible: boolean;
  escalateAfterMinutes: number | null;
  escalateToStageId: string | null;
}

/** O papel de cada etapa de fábrica — o nome é do cliente, o papel é do sistema. */
const PAPEL: Record<BaseStatus, string> = {
  new: 'Lead que chegou e ninguém respondeu ainda',
  priority: 'Escalou por tempo de espera',
  urgency: 'Escalou de novo — estourou o tempo',
  attending: 'Já respondemos, aguardando o cliente',
  converted: 'Fechado. Volta ao funil se o cliente escrever',
};

const BASES: Array<{ v: BaseStatus; l: string }> = [
  { v: 'new', l: 'Novos' },
  { v: 'priority', l: 'Prioridade' },
  { v: 'urgency', l: 'Urgência' },
  { v: 'attending', l: 'Respondidos' },
  { v: 'converted', l: 'Convertidos' },
];

export default function KanbanConfigPage() {
  const [stages, setStages] = useState<Stage[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [salvo, setSalvo] = useState(false);
  const [criando, setCriando] = useState(false);
  const [nova, setNova] = useState({ label: '', color: '#8B5CF6', baseStatus: 'attending' as BaseStatus });

  useEffect(() => {
    carregar();
  }, []);

  async function carregar() {
    try {
      const r = await fetch('/api/admin/pipeline-stages', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setStages(j.stages);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao carregar');
    }
  }

  function editar(id: string, patch: Partial<Stage>) {
    setSalvo(false);
    setStages((s) => s?.map((x) => (x.id === id ? { ...x, ...patch } : x)) ?? null);
  }

  /** Troca com o vizinho e renumera — evita posição duplicada ou com buraco. */
  function mover(indice: number, direcao: -1 | 1) {
    setSalvo(false);
    setStages((s) => {
      if (!s) return s;
      const alvo = indice + direcao;
      if (alvo < 0 || alvo >= s.length) return s;
      const c = [...s];
      [c[indice], c[alvo]] = [c[alvo], c[indice]];
      return c.map((x, i) => ({ ...x, position: i }));
    });
  }

  async function salvar(reset = false) {
    setSalvando(true);
    setErro(null);
    setAviso(null);
    try {
      const r = await fetch('/api/admin/pipeline-stages', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          reset ? { reset: true } : { stages: stages?.map(({ id, label, color, position, visible, escalateAfterMinutes, escalateToStageId }) => ({ id, label, color, position, visible, escalateAfterMinutes, escalateToStageId })) }
        ),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setStages(j.stages);
      setSalvo(true);
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao salvar');
    } finally {
      setSalvando(false);
    }
  }

  async function criar() {
    setSalvando(true);
    setErro(null);
    try {
      const r = await fetch('/api/admin/pipeline-stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nova),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setStages(j.stages);
      setCriando(false);
      setNova({ label: '', color: '#8B5CF6', baseStatus: 'attending' });
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao criar');
    } finally {
      setSalvando(false);
    }
  }

  async function remover(s: Stage) {
    if (!confirm(`Remover a coluna "${s.label}"? Os cards voltam para a coluna de origem — nenhum lead é apagado.`)) return;
    setSalvando(true);
    setErro(null);
    try {
      const r = await fetch(`/api/admin/pipeline-stages?id=${encodeURIComponent(s.id)}`, { method: 'DELETE' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setStages(j.stages);
      setAviso(
        j.leadsMovidos > 0
          ? `${j.leadsMovidos} ${j.leadsMovidos === 1 ? 'card voltou' : 'cards voltaram'} para a coluna de origem.`
          : 'Coluna removida.'
      );
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Erro ao remover');
    } finally {
      setSalvando(false);
    }
  }

  const visiveis = stages?.filter((s) => s.visible).length ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-[19px] font-semibold text-text-primary">Colunas do funil</h1>
      <p className="mb-5 mt-1 text-[12px] text-text-muted">
        Renomeie, recolora, reordene e crie colunas próprias. Esconder ou remover uma coluna
        não apaga lead nenhum — os cards voltam para a coluna de origem.
      </p>

      {erro && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border p-3 text-[12px]"
          style={{ background: 'rgba(248,113,113,0.06)', borderColor: 'rgba(248,113,113,0.3)', color: '#F87171' }}>
          <AlertCircle size={14} strokeWidth={1.8} className="mt-[1px] shrink-0" />
          {erro}
        </div>
      )}
      {aviso && (
        <div className="mb-4 rounded-lg border p-3 text-[12px]"
          style={{ background: 'rgba(34,197,94,0.06)', borderColor: 'rgba(34,197,94,0.3)', color: '#22C55E' }}>
          {aviso}
        </div>
      )}

      {!stages && !erro && (
        <div className="flex items-center gap-2 text-[13px] text-text-muted">
          <Loading size="sm" />
        </div>
      )}

      {stages && (
        <>
          <div className="flex flex-col gap-2">
            {stages.map((s, i) => (
              <Card key={s.id} padding={14}>
                <div className="flex items-center gap-3">
                  <div className="flex flex-col gap-1">
                    <button onClick={() => mover(i, -1)} disabled={i === 0 || salvando}
                      className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary disabled:opacity-25"
                      aria-label="Subir">
                      <ArrowUp size={13} strokeWidth={1.9} />
                    </button>
                    <button onClick={() => mover(i, 1)} disabled={i === stages.length - 1 || salvando}
                      className="rounded p-0.5 text-text-muted transition-colors hover:text-text-primary disabled:opacity-25"
                      aria-label="Descer">
                      <ArrowDown size={13} strokeWidth={1.9} />
                    </button>
                  </div>

                  <input type="color" value={s.color} onChange={(e) => editar(s.id, { color: e.target.value })}
                    disabled={salvando}
                    className="h-8 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0"
                    aria-label={`Cor de ${s.label}`} />

                  <div className="min-w-0 flex-1">
                    <input type="text" value={s.label} maxLength={40}
                      onChange={(e) => editar(s.id, { label: e.target.value })} disabled={salvando}
                      className="w-full rounded-lg border bg-[#18181F] px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-mid"
                      style={{ borderColor: 'var(--border-subtle)' }} />
                    <p className="mt-1 truncate text-[11px] text-text-muted">
                      {s.isCustom
                        ? `Personalizada · cards saem de "${BASES.find((b) => b.v === s.status)?.l}"`
                        : PAPEL[s.status]}
                    </p>
                  </div>

                  <button onClick={() => editar(s.id, { visible: !s.visible })} disabled={salvando}
                    className="shrink-0 rounded-lg border px-2.5 py-2 transition-colors"
                    style={{ borderColor: 'var(--border-subtle)', color: s.visible ? 'var(--text-primary)' : 'var(--text-muted)' }}
                    title={s.visible ? 'Ocultar do quadro' : 'Mostrar no quadro'}>
                    {s.visible ? <Eye size={14} strokeWidth={1.8} /> : <EyeOff size={14} strokeWidth={1.8} />}
                  </button>

                  {/* Escalação: some quando a coluna está oculta — coluna que
                      não aparece não deveria mover card por baixo. */}
                  {/* eslint-disable-next-line @typescript-eslint/no-unused-expressions */}
                  {null}
                  {/* Só as personalizadas podem ser apagadas. As de fábrica se escondem. */}
                  {s.isCustom && (
                    <button onClick={() => remover(s)} disabled={salvando}
                      className="shrink-0 rounded-lg border px-2.5 py-2 text-text-muted transition-colors hover:text-[#F87171]"
                      style={{ borderColor: 'var(--border-subtle)' }} title="Remover coluna">
                      <Trash2 size={14} strokeWidth={1.8} />
                    </button>
                  )}
                </div>
                {s.visible && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-[12px]"
                    style={{ borderColor: 'var(--border-subtle)' }}>
                    <span className="text-text-muted">Depois de</span>
                    <input
                      type="number"
                      min={0}
                      max={43200}
                      placeholder="—"
                      value={s.escalateAfterMinutes ?? ''}
                      onChange={(e) =>
                        editar(s.id, {
                          escalateAfterMinutes: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                      disabled={salvando}
                      className="w-20 rounded-lg border bg-[#18181F] px-2 py-1 text-[12px] text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-mid"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    />
                    <span className="text-text-muted">min parado, vai para</span>
                    <select
                      value={s.escalateToStageId ?? ''}
                      onChange={(e) =>
                        editar(s.id, { escalateToStageId: e.target.value || null })
                      }
                      disabled={salvando}
                      className="min-w-[9rem] rounded-lg border bg-[#18181F] px-2 py-1 text-[12px] text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-mid"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <option value="">— não escala —</option>
                      {stages
                        .filter((o) => o.id !== s.id)
                        .map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                    </select>
                  </div>
                )}
              </Card>
            ))}
          </div>

          {criando ? (
            <Card padding={14} className="mt-2">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-text-primary">Nova coluna</span>
                <button onClick={() => setCriando(false)} className="text-text-muted hover:text-text-primary">
                  <X size={15} strokeWidth={1.8} />
                </button>
              </div>
              <div className="flex items-center gap-3">
                <input type="color" value={nova.color} onChange={(e) => setNova({ ...nova, color: e.target.value })}
                  className="h-8 w-8 shrink-0 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Cor" />
                <input type="text" value={nova.label} maxLength={40} autoFocus
                  placeholder="Ex: Proposta enviada"
                  onChange={(e) => setNova({ ...nova, label: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Enter' && nova.label.trim()) criar(); }}
                  className="min-w-0 flex-1 rounded-lg border bg-[#18181F] px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-mid"
                  style={{ borderColor: 'var(--border-subtle)' }} />
              </div>
              <label className="mt-3 mb-1 block text-[11px] uppercase tracking-wider text-text-muted">
                De qual fila os cards saem
              </label>
              <select value={nova.baseStatus}
                onChange={(e) => setNova({ ...nova, baseStatus: e.target.value as BaseStatus })}
                className="w-full rounded-lg border bg-[#18181F] px-2.5 py-1.5 text-[13px] text-text-primary focus:outline-none focus:ring-2 focus:ring-blue-mid"
                style={{ borderColor: 'var(--border-subtle)' }}>
                {BASES.map((b) => <option key={b.v} value={b.v}>{b.l}</option>)}
              </select>
              <p className="mt-1.5 text-[11px] text-text-muted">
                O card continua contando como {BASES.find((b) => b.v === nova.baseStatus)?.l.toLowerCase()} para
                escalação, SLA e relatórios — muda só onde ele aparece no quadro.
              </p>
              <button onClick={criar} disabled={salvando || !nova.label.trim()} className="btn-primary mt-3">
                {salvando ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} strokeWidth={1.9} />}
                Criar coluna
              </button>
            </Card>
          ) : (
            <button onClick={() => setCriando(true)} disabled={salvando}
              className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-3 text-[12.5px] text-text-muted transition-colors hover:text-text-primary"
              style={{ borderColor: 'var(--border-subtle)' }}>
              <Plus size={14} strokeWidth={1.9} />
              Adicionar coluna
            </button>
          )}

          <p className="mt-3 text-[11px] text-text-muted">
            {visiveis} de {stages.length} colunas visíveis
            {visiveis === 0 && ' — o quadro ficaria vazio, deixe ao menos uma.'}
          </p>

          <div className="mt-5 flex items-center gap-2">
            <button onClick={() => salvar(false)} disabled={salvando || visiveis === 0} className="btn-primary">
              {salvando ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={1.9} />}
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
            <button onClick={() => salvar(true)} disabled={salvando}
              className="flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12px] text-text-muted transition-colors hover:text-text-primary"
              style={{ borderColor: 'var(--border-subtle)' }}
              title="Restaura nome, cor e ordem das cinco de fábrica. Não apaga as personalizadas.">
              <RotateCcw size={13} strokeWidth={1.8} />
              Restaurar padrão
            </button>
            {salvo && (
              <span className="flex items-center gap-1 text-[12px]" style={{ color: '#22C55E' }}>
                <Check size={13} strokeWidth={2} /> salvo
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
