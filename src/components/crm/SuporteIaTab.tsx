'use client';

import { useEffect, useState } from 'react';
import { Bot, Send, Sparkles, Loader2, Copy, Check, MessageSquarePlus } from 'lucide-react';
import type { Message } from '@/modules/messages/types';

// Perguntas de atalho — neutras de segmento de propósito. Quem quiser adaptar
// ao nicho do cliente faz por aqui, não espalhado pelo componente.
const QUICK_QUESTIONS = [
  'Como converter?',
  'Qual o próximo passo?',
  'Como retomar o contato?',
];

type Suggestion = { advice: string; draft: string; fallback: boolean };

export default function SuporteIaTab({
  leadId,
  onUseDraft,
}: {
  leadId: string;
  /** Joga o rascunho no composer da aba Conversa (editável, sem enviar). */
  onUseDraft?: (text: string) => void;
}) {
  const [lastInbound, setLastInbound] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Carrega última mensagem inbound só pra exibir no topo (contexto visível pro
  // atendente). A IA, no backend, analisa o histórico inteiro da conversa.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/leads/${leadId}/messages?limit=10&order=desc`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { messages: Message[] }) => {
        if (cancelled) return;
        const lastFromLead = j.messages.find((m) => m.direction === 'inbound');
        setLastInbound(lastFromLead?.body ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [leadId]);

  async function ask(prompt?: string) {
    setLoading(true);
    setError(null);
    setSuggestion(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/ai-suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prompt ? { question: prompt } : {}),
      });
      const j = await res.json();
      if (!res.ok) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setSuggestion({
        // Compat: backend antigo mandava `suggestion`; novo manda `advice`.
        advice: j.advice ?? j.suggestion ?? '',
        draft: j.draft ?? '',
        fallback: !!j.fallback,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro');
    } finally {
      setLoading(false);
    }
  }

  function copyDraft() {
    if (!suggestion?.draft) return;
    navigator.clipboard.writeText(suggestion.draft).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto px-5 py-5">
      {/* Card top: header */}
      <div
        className="rounded-xl border p-4"
        style={{
          background: 'linear-gradient(135deg, rgba(167,139,250,0.10), rgba(var(--accent-light-rgb),0.04))',
          borderColor: 'rgba(167,139,250,0.25)',
        }}
      >
        <div className="mb-1 flex items-center gap-2 text-[14px] font-semibold" style={{ color: '#A78BFA' }}>
          <Bot size={16} strokeWidth={1.7} />
          Suporte IA para Atendentes
        </div>
        <div className="text-[12px] text-text-secondary">
          A IA lê a conversa inteira, te dá uma orientação e já monta um rascunho de
          resposta pronto pra enviar ao cliente.
        </div>
      </div>

      {/* Última mensagem */}
      {lastInbound && (
        <div
          className="rounded-xl border p-3.5"
          style={{ background: '#111116', borderColor: 'var(--border-subtle)' }}
        >
          <div className="mb-1 text-[12px] font-semibold text-text-secondary">Última mensagem do cliente:</div>
          <div className="text-[13px] italic text-text-primary">&quot;{lastInbound}&quot;</div>
        </div>
      )}

      {/* Pergunte ao agente */}
      <div>
        <div className="mb-1.5 text-[12px] font-semibold text-text-secondary">Pergunte ao Agente IA:</div>
        <div className="flex items-end gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && question.trim()) ask(question.trim());
            }}
            placeholder="Ex: Como converter? Como responder sobre preço?"
            className="flex-1 rounded-lg border bg-[#111116] px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
            style={{ borderColor: 'var(--border-subtle)' }}
          />
          <button
            type="button"
            onClick={() => ask(question.trim() || undefined)}
            disabled={loading}
            aria-label="Enviar pergunta"
            className="flex h-9 w-9 items-center justify-center rounded-lg disabled:opacity-40"
            style={{ background: 'rgba(167,139,250,0.18)', color: '#A78BFA' }}
          >
            {loading ? <Loader2 size={14} strokeWidth={1.7} className="animate-spin" /> : <Send size={14} strokeWidth={1.7} />}
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_QUESTIONS.map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => { setQuestion(q); ask(q); }}
              disabled={loading}
              className="rounded-md px-2.5 py-1 text-[11.5px] transition disabled:opacity-40 hover:bg-[rgba(167,139,250,0.18)]"
              style={{ background: 'rgba(167,139,250,0.12)', color: '#A78BFA' }}
            >
              {q}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div
          className="rounded-md px-3 py-2 text-[11.5px]"
          style={{ background: 'rgba(248,113,113,0.08)', color: '#F87171' }}
        >
          {error}
        </div>
      )}

      {/* Sugestão (conselho pro atendente) */}
      {suggestion && suggestion.advice && (
        <div
          className="rounded-xl border p-4"
          style={{ background: '#0F0F14', borderColor: 'rgba(167,139,250,0.25)' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: '#A78BFA' }}>
              <Sparkles size={11} strokeWidth={1.7} /> Sugestão da IA
              {suggestion.fallback && (
                <span className="text-[10px] text-text-muted normal-case">(fallback)</span>
              )}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-[13px] text-text-primary">{suggestion.advice}</p>
        </div>
      )}

      {/* Rascunho pronto pro cliente */}
      {suggestion && suggestion.draft && (
        <div
          className="rounded-xl border p-4"
          style={{ background: '#0E1412', borderColor: 'rgba(52,211,153,0.30)' }}
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider"
              style={{ color: '#34D399' }}>
              <MessageSquarePlus size={11} strokeWidth={1.7} /> Rascunho pro cliente
            </span>
            <button
              type="button"
              onClick={copyDraft}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10.5px] text-text-muted transition hover:bg-[rgba(255,255,255,0.06)] hover:text-text-primary"
            >
              {copied ? <Check size={11} strokeWidth={1.8} /> : <Copy size={11} strokeWidth={1.7} />}
              {copied ? 'Copiado' : 'Copiar'}
            </button>
          </div>
          <p className="mb-3 whitespace-pre-wrap text-[13px] text-text-primary">{suggestion.draft}</p>
          <button
            type="button"
            onClick={() => onUseDraft?.(suggestion.draft)}
            disabled={!onUseDraft}
            className="flex w-full items-center justify-center gap-2 rounded-lg py-2.5 text-[12.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background: 'rgba(52,211,153,0.16)',
              color: '#34D399',
              border: '1px solid rgba(52,211,153,0.38)',
            }}
          >
            <MessageSquarePlus size={14} strokeWidth={1.8} />
            Editar na conversa
          </button>
          <div className="mt-1.5 text-center text-[10.5px] text-text-muted">
            Vai pro campo de digitação da aba Conversa — revise antes de enviar.
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => ask()}
        disabled={loading || !lastInbound}
        className="mt-auto flex items-center justify-center gap-2 rounded-xl py-3 text-[13.5px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
        style={{
          background: 'rgba(167,139,250,0.18)',
          color: '#A78BFA',
          border: '1px solid rgba(167,139,250,0.35)',
        }}
      >
        {loading ? <Loader2 size={14} strokeWidth={1.7} className="animate-spin" /> : <Bot size={14} strokeWidth={1.7} />}
        Sugerir Resposta
      </button>
    </div>
  );
}
