'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  MessageSquare, Bot, Calendar, X, TrendingUp, Zap, Phone, Mail, Loader2, RotateCcw, Radio, Trash2, CheckCircle2,
  KeyRound, Copy, Check, NotebookPen,
} from 'lucide-react';
import type { Lead, LeadStatus, LeadAttributedChannel } from '@/modules/leads/types';
import ChatPanel from './ChatPanel';
import { leadDisplayName, leadDisplaySubtitle, leadInitials } from '@/lib/lead-display';
import Loading from '@/components/Loading';
import { useAuthScope } from '@/modules/auth/client-scope';

const ObservacoesTab = dynamic(() => import('./ObservacoesTab'));
const SuporteIaTab = dynamic(() => import('./SuporteIaTab'));
const AgendamentosTab = dynamic(() => import('./AgendamentosTab'));

type Tab = 'conversa' | 'observacoes' | 'suporte' | 'agendamentos';

/** Chave PIX manual da unidade — pro atendente enviar na mão quando o gateway
 *  automático (Asaas) cai. Vem do GET /api/leads/[id] (campos públicos). */
type UnitPix = {
  holder: string | null;
  keyType: string | null;
  key: string | null;
  bank: string | null;
  message: string | null;
};

const STATUS_PILL: Record<LeadStatus, { bg: string; text: string; label: string }> = {
  new:        { bg: 'rgba(0,212,146,0.12)',  text: '#00d492', label: 'Novo' },
  priority:   { bg: 'rgba(217,157,0,0.12)',  text: '#d99d00', label: 'Prioridade' },
  urgency:    { bg: 'rgba(255,96,96,0.12)',  text: '#ff6060', label: 'Urgência' },
  attending:  { bg: 'rgba(34,211,238,0.12)', text: '#22D3EE', label: 'Atendendo' },
  converted:  { bg: 'rgba(34,197,94,0.14)',  text: '#4ADE80', label: 'Convertido' },
  lost:       { bg: 'rgba(148,163,184,0.12)', text: '#94A3B8', label: 'Perdido' },
};

/**
 * Selo do canal no cabeçalho da conversa.
 *
 * Era um "WhatsApp" fixo — sobrou da época em que só existia um canal, e um
 * lead de e-mail abria com o selo errado em cima. Mapa fechado por canal:
 * canal novo sem selo é erro de compilação, não etiqueta errada.
 */
const CANAL_MODAL: Record<'whatsapp' | 'email' | 'manual', { label: string; cor: string; fundo: string }> = {
  whatsapp: { label: 'WhatsApp', cor: '#4ADE80', fundo: 'rgba(34,197,94,0.15)' },
  email: { label: 'E-mail', cor: '#7DD3FC', fundo: 'rgba(56,189,248,0.15)' },
  manual: { label: 'Manual', cor: '#C4B5FD', fundo: 'rgba(167,139,250,0.15)' },
};

export default function LeadModal({
  leadId,
  onClose,
  onChange,
}: {
  leadId: string;
  onClose: () => void;
  onChange?: () => void;
}) {
  const { role, kanbanManual } = useAuthScope();
  const [lead, setLead] = useState<Lead | null>(null);
  const [tab, setTab] = useState<Tab>('conversa');
  const [error, setError] = useState<string | null>(null);
  // Rascunho transferido do Suporte IA pro composer da aba Conversa. O ChatPanel
  // consome via injectedDraft e zera via onDraftConsumed (precisa sobreviver à
  // troca de aba, que desmonta o ChatPanel — por isso vive aqui no modal).
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  const [unitPix, setUnitPix] = useState<UnitPix | null>(null);
  const canDelete = role === 'admin';

  async function loadLead() {
    try {
      const res = await fetch(`/api/leads/${leadId}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { lead: Lead; unitPix?: UnitPix | null };
      setLead(j.lead);
      setUnitPix(j.unitPix ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    }
  }

  useEffect(() => {
    void loadLead();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  // ESC fecha
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

  async function changeStatus(newStatus: LeadStatus, confirmMessage?: string) {
    if (!lead) return;
    if (confirmMessage && !confirm(confirmMessage)) return;
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Erro: ${j.error ?? res.status}`);
        return;
      }
      setLead(j.lead);
      onChange?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function resolveLead() {
    if (!lead) return;
    // Trava só quando JÁ está parado em Respondidos. Se o lead voltou pra uma
    // fila ativa (cliente reengajou / re-escalou) mas o resolvedAt ficou velho,
    // o clique deve re-resolver normalmente — senão o botão fica morto.
    if (lead.status === 'attending' && lead.resolvedAt) return;
    // Sem confirmação: o cliente pediu pra ir direto pra "Respondidos" num clique.
    // É reversível (botão Reabrir) e os follow-ups voltam sozinhos se o lead falar.
    try {
      const res = await fetch(`/api/leads/${leadId}/resolve`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Erro: ${j.error ?? res.status}`);
        return;
      }
      setLead(j.lead);
      onChange?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function reopenLead() {
    if (!lead) return;
    if (!confirm(`Reabrir "${lead.name ?? 'este lead'}"? Volta pra fila Novos.`)) return;
    try {
      const res = await fetch(`/api/leads/${leadId}/reopen`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Erro: ${j.error ?? res.status}`);
        return;
      }
      setLead(j.lead);
      onChange?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro');
    }
  }

  /**
   * Hard delete — apaga lead, mensagens, agendamentos, follow-ups.
   * Restrito a admin no backend. Confirmação dupla com nome do lead.
   */
  async function removeLead() {
    if (!lead) return;
    const name = lead.name ?? lead.phone ?? 'este lead';
    const confirm1 = confirm(
      `Excluir DEFINITIVAMENTE "${name}"?\n\n` +
        `Isso apaga o lead + TODO o histórico (mensagens, agendamentos, follow-ups).\n` +
        `Ação irreversível. Pra só tirar do funil mantendo histórico, use "Perdido" no menu de status.`
    );
    if (!confirm1) return;
    try {
      const res = await fetch(`/api/leads/${leadId}`, { method: 'DELETE' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(`Erro: ${j.error ?? res.status}`);
        return;
      }
      onChange?.();
      onClose();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Erro');
    }
  }

  async function toggleAi() {
    if (!lead) return;
    const next = !lead.aiAgentActive;
    setLead({ ...lead, aiAgentActive: next });
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiAgentActive: next }),
      });
      if (!res.ok) throw new Error('Falha');
      const j = (await res.json()) as { lead: Lead; unitPix?: UnitPix | null };
      setLead(j.lead);
      setUnitPix(j.unitPix ?? null);
      onChange?.();
    } catch {
      setLead({ ...lead });
    }
  }

  /**
   * Limpa aiPausedUntil — IA volta a responder imediatamente.
   * Antes desse handler, lead pausado por cancellation_trigger / human_message
   * só voltava sozinho quando o timer expirava (até 20 min). Atendente que
   * quisesse "rebootar" a IA antes do tempo precisava entender o schema.
   */
  async function resumeAi() {
    if (!lead) return;
    if (!confirm('Retomar a IA agora? Ela responde a próxima mensagem do cliente.')) return;
    setLead({ ...lead, aiPausedUntil: null });
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiPausedUntil: null }),
      });
      if (!res.ok) throw new Error('Falha');
      const j = (await res.json()) as { lead: Lead; unitPix?: UnitPix | null };
      setLead(j.lead);
      setUnitPix(j.unitPix ?? null);
      onChange?.();
    } catch {
      setLead({ ...lead });
    }
  }

  /**
   * Sobrescreve o canal "atribuído" do lead (origem real na dashboard).
   * Diferente de `channel` (técnico — whatsapp/instagram), `attributedChannel`
   * indica de onde o lead veio (Meta Ads, Google etc.). Atendente decide quando
   * a IA não detectou keyword ou marcou errado.
   */
  async function changeAttribution(value: LeadAttributedChannel | null) {
    if (!lead) return;
    setLead({ ...lead, attributedChannel: value });
    try {
      const res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributedChannel: value }),
      });
      if (!res.ok) throw new Error('Falha');
      const j = (await res.json()) as { lead: Lead; unitPix?: UnitPix | null };
      setLead(j.lead);
      setUnitPix(j.unitPix ?? null);
      onChange?.();
    } catch {
      setLead({ ...lead });
    }
  }

  const statusPill = lead ? STATUS_PILL[lead.status] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="relative flex h-dvh w-full max-w-full flex-col overflow-hidden border lead-modal-enter sm:h-[88vh] sm:max-h-[920px] sm:max-w-5xl sm:rounded-2xl"
        style={{
          background: '#0B0B10',
          borderColor: 'var(--border-subtle)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          // Celular: DUAS linhas — identidade em cima, ações embaixo. Cinco
          // botões + nome + telefone + selo de canal na mesma linha de ~360px
          // se sobrepunham (o "WhatsApp" cobria os botões). Espremer mais não
          // resolvia; o que faltava era espaço, e a segunda linha dá.
          className="flex flex-col gap-2 border-b px-3 py-3 sm:flex-row sm:flex-nowrap sm:items-center sm:gap-4 sm:px-5 sm:py-4"
          style={{ borderColor: 'var(--border-subtle)', background: '#0D0D12' }}
        >
          {!lead ? (
            <div className="flex flex-1 items-center gap-3">
              <Loader2 size={18} strokeWidth={1.6} className="animate-spin text-text-muted" />
              <Loading size="sm" />
            </div>
          ) : (
            <>
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:contents">
              <Avatar id={lead.id} lead={lead} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[15px] font-semibold text-text-primary">
                    {leadDisplayName(lead)}
                  </span>
                  {statusPill && (
                    <span
                      className="rounded-md px-2 py-0.5 text-[10.5px] font-semibold"
                      style={{ background: statusPill.bg, color: statusPill.text }}
                    >
                      {statusPill.label}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px] text-text-muted">
                  {/* O contato da conversa: telefone no WhatsApp, endereço no
                      e-mail. O truncate protege endereços longos. */}
                  {lead.channel === 'email' && lead.email ? (
                    <>
                      <Mail size={11} strokeWidth={1.6} className="shrink-0" />
                      <span className="truncate">{lead.email}</span>
                    </>
                  ) : leadDisplaySubtitle(lead) ? (
                    <>
                      <Phone size={11} strokeWidth={1.6} />
                      {leadDisplaySubtitle(lead)}
                    </>
                  ) : null}
                  {(() => {
                    const c = CANAL_MODAL[lead.channel] ?? CANAL_MODAL.manual;
                    return (
                      <span className="ml-1 inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold"
                        style={{ background: c.fundo, color: c.cor }}>
                        <span className="h-1 w-1 rounded-full" style={{ background: c.cor }} />
                        {c.label}
                      </span>
                    );
                  })()}
                </div>
              </div>

              </div>

              {/* Ações: linha própria no celular, alinhadas à direita no
                  desktop. Rolam horizontalmente se ainda assim não couberem. */}
              <div className="-mx-1 flex shrink-0 items-center gap-1.5 overflow-x-auto px-1 sm:mx-0 sm:gap-2 sm:px-0">
                {/* Ações de ATENDIMENTO (IA/Resolvido/Converti!/Urgência) só no
                    modo fila. No funil de prospecção o card anda por arraste e
                    essas ações não se aplicam — some a barra inteira, ficam só
                    excluir (admin) e fechar. */}
                {!kanbanManual && ((lead.status === 'converted' || lead.status === 'lost') ? (
                  <ActionButton
                    icon={<RotateCcw size={13} strokeWidth={1.8} />}
                    label="Reabrir"
                    tone="info"
                    onClick={reopenLead}
                  />
                ) : (
                  <>
                    {(() => {
                      // 3 estados: paused (amarelo, clicar retoma), on (azul, clicar desliga),
                      // off (cinza, clicar liga). aiPausedUntil pode chegar como string ISO
                      // do JSON — comparar via getTime após new Date().
                      const pausedUntilMs = lead.aiPausedUntil
                        ? new Date(lead.aiPausedUntil).getTime()
                        : 0;
                      const isPaused = lead.aiAgentActive && pausedUntilMs > Date.now();
                      const pausedHhmm = isPaused
                        ? new Date(pausedUntilMs).toLocaleTimeString('pt-BR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '';
                      const label = isPaused
                        ? `IA PAUSADA até ${pausedHhmm}`
                        : lead.aiAgentActive
                          ? 'IA ON'
                          : 'IA OFF';
                      const shortLabel = isPaused
                        ? `Pausada ${pausedHhmm}`
                        : lead.aiAgentActive
                          ? 'IA ON'
                          : 'IA OFF';
                      const title = isPaused
                        ? `IA em pausa silenciosa até ${pausedHhmm}. Clique pra retomar agora.`
                        : lead.aiAgentActive
                          ? 'IA ON — clique pra desligar pra este chat'
                          : 'IA OFF — clique pra ligar';
                      const style = isPaused
                        ? { background: 'rgba(250,204,21,0.15)', borderColor: 'rgba(250,204,21,0.5)', color: '#FACC15' }
                        : lead.aiAgentActive
                          ? { background: 'rgba(var(--accent-light-rgb),0.15)', borderColor: 'rgba(var(--accent-light-rgb),0.5)', color: 'var(--accent-light)' }
                          : { background: '#18181F', borderColor: 'var(--border-subtle)', color: '#94A3B8' };
                      return (
                    <button
                      type="button"
                      onClick={isPaused ? resumeAi : toggleAi}
                      title={title}
                      aria-label={label}
                      className="flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11.5px] font-semibold transition-all sm:px-2.5"
                      style={style}
                    >
                      <Bot size={12} strokeWidth={1.7} />
                      <span className="hidden sm:inline">{shortLabel}</span>
                    </button>
                      );
                    })()}
                    <ActionButton
                      icon={<CheckCircle2 size={13} strokeWidth={1.8} />}
                      label={lead.status === 'attending' && lead.resolvedAt ? 'Resolvido ✓' : 'Resolvido'}
                      tone="info"
                      onClick={resolveLead}
                      disabled={lead.status === 'attending' && !!lead.resolvedAt}
                    />
                    <ActionButton
                      icon={<TrendingUp size={13} strokeWidth={1.8} />}
                      label="Converti!"
                      tone="success"
                      onClick={() => changeStatus('converted', `Marcar "${lead.name ?? 'este lead'}" como CONVERTIDO? O lead sai do funil ativo (mas pode ser reaberto depois).`)}
                    />
                    <ActionButton
                      icon={<Zap size={13} strokeWidth={1.8} />}
                      label="Urgência"
                      tone="danger"
                      onClick={() => changeStatus('urgency', `Mover "${lead.name ?? 'este lead'}" pra URGÊNCIA?`)}
                      disabled={lead.status === 'urgency'}
                    />
                  </>
                ))}
                {canDelete && (
                  <button
                    onClick={removeLead}
                    aria-label="Excluir lead"
                    title="Excluir lead (apaga histórico)"
                    className="flex h-8 w-8 items-center justify-center rounded-lg border text-[#F87171] transition-colors hover:bg-[rgba(248,113,113,0.1)]"
                    style={{ borderColor: 'rgba(248,113,113,0.3)' }}
                  >
                    <Trash2 size={14} strokeWidth={1.8} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  aria-label="Fechar"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-text-muted hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary"
                >
                  <X size={16} strokeWidth={1.7} />
                </button>
              </div>
            </>
          )}
        </div>

        {/* Atribuição de origem — atendente classifica de onde o lead veio.
            Sobrescreve o canal detectado por keyword da IA. */}
        {lead && (
          <div
            className="flex items-center gap-2 overflow-x-auto border-b px-3 py-2 text-[11.5px] sm:px-5"
            style={{ borderColor: 'var(--border-subtle)', background: '#0A0A0F' }}
          >
            <span className="inline-flex items-center gap-1.5 text-text-muted">
              <Radio size={12} strokeWidth={1.7} /> Origem:
            </span>
            <AttributionPill
              active={!lead.attributedChannel}
              label="Automático"
              onClick={() => changeAttribution(null)}
            />
            <AttributionPill
              active={lead.attributedChannel === 'whatsapp'}
              label="WhatsApp"
              color="#22C55E"
              onClick={() => changeAttribution('whatsapp')}
            />
            <AttributionPill
              active={lead.attributedChannel === 'instagram'}
              label="Instagram"
              color="#F472B6"
              onClick={() => changeAttribution('instagram')}
            />
            <AttributionPill
              active={lead.attributedChannel === 'google'}
              label="Google Ads"
              color="var(--accent-mid)"
              onClick={() => changeAttribution('google')}
            />
            <AttributionPill
              active={lead.attributedChannel === 'email'}
              label="E-mail"
              color="var(--accent-light)"
              onClick={() => changeAttribution('email')}
            />
          </div>
        )}

        {/* Chave PIX manual da unidade — pro atendente enviar na mão quando o
            gateway automático (Asaas) cair. Só aparece se houver chave cadastrada. */}
        {unitPix?.key && <PixManualBar pix={unitPix} />}

        {/* Tabs */}
        <div
          className="flex items-center gap-0 overflow-x-auto border-b px-2 sm:px-5"
          style={{ borderColor: 'var(--border-subtle)', background: '#0D0D12' }}
        >
          <TabButton active={tab === 'conversa'} onClick={() => setTab('conversa')}
            icon={<MessageSquare size={13} strokeWidth={1.7} />} label="Conversa" />
          <TabButton active={tab === 'observacoes'} onClick={() => setTab('observacoes')}
            icon={<NotebookPen size={13} strokeWidth={1.7} />} label="Observações" />
          <TabButton active={tab === 'suporte'} onClick={() => setTab('suporte')}
            icon={<Bot size={13} strokeWidth={1.7} />} label="Suporte IA" />
          <TabButton active={tab === 'agendamentos'} onClick={() => setTab('agendamentos')}
            icon={<Calendar size={13} strokeWidth={1.7} />} label="Agendamentos" />
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1">
          {error && (
            <div className="m-4 rounded-md px-3 py-2 text-[11.5px]"
              style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}>
              {error}
            </div>
          )}
          {tab === 'conversa' && (
            <ChatPanel
              leadId={leadId}
              onActivity={() => onChange?.()}
              injectedDraft={pendingDraft}
              onDraftConsumed={() => setPendingDraft(null)}
              // O composer muda conforme o canal: com `email`, ganha o campo de
              // assunto e manda pela rota de e-mail.
              canal={lead?.channel}
            />
          )}
          {tab === 'observacoes' && lead && (
            <ObservacoesTab
              leadId={leadId}
              initialValue={lead.notes ?? ''}
              onSaved={(notes) => setLead(l => (l ? { ...l, notes } : l))}
            />
          )}
          {tab === 'suporte' && (
            <SuporteIaTab
              leadId={leadId}
              onUseDraft={(text) => { setPendingDraft(text); setTab('conversa'); }}
            />
          )}
          {tab === 'agendamentos' && <AgendamentosTab leadId={leadId} />}
        </div>
      </div>

      <style jsx>{`
        .lead-modal-enter {
          animation: leadModalIn 220ms cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        @keyframes leadModalIn {
          0% { transform: scale(0.92) translateY(8px); opacity: 0; }
          100% { transform: scale(1) translateY(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

/** Barra copiável com a chave PIX manual da unidade. Só renderiza quando há
 *  chave cadastrada (o pai já checa). Serve o atendente quando o gateway
 *  automático (Asaas) cai — ele copia e manda na mão sem sair do painel. */
function PixManualBar({ pix }: { pix: UnitPix }) {
  const [copied, setCopied] = useState(false);
  const key = pix.key ?? '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard bloqueado (http/permite) — atendente seleciona e copia manual */
    }
  }
  const meta = [pix.keyType, pix.holder, pix.bank].filter(Boolean).join(' · ');
  return (
    <div
      className="flex items-center gap-2 overflow-x-auto border-b px-3 py-2 text-[11.5px] sm:px-5"
      style={{ borderColor: 'var(--border-subtle)', background: '#0A0A0F' }}
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 text-text-muted">
        <KeyRound size={12} strokeWidth={1.7} /> PIX manual:
      </span>
      <code className="shrink-0 rounded bg-[#18181F] px-1.5 py-0.5 font-mono text-[11px] text-text-secondary">
        {key}
      </code>
      {meta && <span className="shrink-0 text-text-muted">{meta}</span>}
      <button
        type="button"
        onClick={copy}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium transition"
        style={{
          background: '#18181F',
          color: copied ? '#00d492' : '#94A3B8',
          border: '1px solid var(--border-subtle)',
        }}
      >
        {copied ? <Check size={12} strokeWidth={2} /> : <Copy size={12} strokeWidth={1.7} />}
        {copied ? 'Copiado' : 'Copiar'}
      </button>
    </div>
  );
}

function AttributionPill({
  active, label, color, onClick,
}: {
  active: boolean;
  label: string;
  color?: string;
  onClick: () => void;
}) {
  const c = color ?? '#94A3B8';
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2 py-0.5 text-[11px] font-medium transition"
      style={
        active
          ? { background: `${c}26`, color: c, border: `1px solid ${c}66` }
          // Inativa ainda carrega a COR do canal (tom suave) em vez de cinza —
          // assim a barra de origem fica visivelmente colorida mesmo com o lead
          // em "Automático". Antes toda pill não-ativa saía cinza e o cliente
          // reclamou que "não mostra as cores".
          : { background: '#141419', color: c, border: `1px solid ${c}33` }
      }
    >
      {label}
    </button>
  );
}

function TabButton({
  active, onClick, icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex shrink-0 items-center gap-1.5 px-3 py-3 text-[12px] font-medium transition sm:px-4 sm:text-[12.5px] ${
        active ? 'text-blue-light' : 'text-text-muted hover:text-text-secondary'
      }`}
    >
      {icon}
      {label}
      {active && (
        <span
          className="absolute bottom-0 left-2 right-2 h-[2px] rounded-t"
          style={{ background: 'var(--accent-light)' }}
        />
      )}
    </button>
  );
}

function ActionButton({
  icon, label, tone, onClick, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'success' | 'danger' | 'info';
  onClick: () => void;
  disabled?: boolean;
}) {
  const C = tone === 'success'
    ? { bg: 'rgba(0,212,146,0.12)', border: 'rgba(0,212,146,0.35)', text: '#00d492' }
    : tone === 'danger'
    ? { bg: 'rgba(255,96,96,0.12)', border: 'rgba(255,96,96,0.35)', text: '#ff6060' }
    : { bg: 'rgba(var(--accent-light-rgb),0.15)', border: 'rgba(var(--accent-light-rgb),0.45)', text: 'var(--accent-light)' };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-30 hover:brightness-110 sm:px-2.5"
      style={{ background: C.bg, borderColor: C.border, color: C.text }}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function Avatar({ id, lead }: { id: string; lead: Lead }) {
  const palette = ['#C08BFF', '#22D3EE', '#F472B6', '#A78BFA', '#FBBF24', '#4ADE80', '#F87171', '#818CF8'];
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const color = palette[hash % palette.length];
  const initials = leadInitials(lead);
  return (
    <div
      className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
      style={{
        background: `${color}26`,
        color,
        border: `2px solid ${color}55`,
        boxShadow: `0 0 0 3px ${color}11`,
      }}
    >
      {initials}
    </div>
  );
}

