'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Check, NotebookPen } from 'lucide-react';

/**
 * Bloco de notas do atendimento.
 *
 * O que não cabe na conversa: o combinado que ficou no telefone, o histórico
 * do cliente, o motivo de ele ter sumido. Fica visível só pro time — NUNCA sai
 * pro cliente, e não entra em prompt de IA.
 *
 * Salva sozinho depois de uma pausa na digitação: obrigar a clicar em "Salvar"
 * num campo de anotação é o jeito mais fácil de perder anotação.
 */
export default function ObservacoesTab({
  leadId,
  initialValue,
  onSaved,
}: {
  leadId: string;
  initialValue: string;
  onSaved?: (notes: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  // Guarda o que já está no servidor pra não salvar de novo o que não mudou —
  // inclusive na primeira renderização.
  const savedRef = useRef(initialValue);

  useEffect(() => {
    setValue(initialValue);
    savedRef.current = initialValue;
  }, [initialValue, leadId]);

  useEffect(() => {
    if (value === savedRef.current) return;
    const id = setTimeout(async () => {
      setState('saving');
      try {
        const res = await fetch(`/api/leads/${leadId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ notes: value }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        savedRef.current = value;
        setState('saved');
        onSaved?.(value);
        setTimeout(() => setState(s => (s === 'saved' ? 'idle' : s)), 1800);
      } catch {
        setState('error');
      }
    }, 800);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, leadId]);

  return (
    <div className="flex h-full flex-col p-3 sm:p-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] text-text-muted">
          <NotebookPen size={12} strokeWidth={1.7} />
          Anotações internas — o cliente não vê
        </span>
        <span className="text-[11px]">
          {state === 'saving' && (
            <span className="inline-flex items-center gap-1 text-text-muted">
              <Loader2 size={11} className="animate-spin" /> salvando
            </span>
          )}
          {state === 'saved' && (
            <span className="inline-flex items-center gap-1 text-success-text">
              <Check size={11} /> salvo
            </span>
          )}
          {state === 'error' && <span className="text-error-text">falhou ao salvar</span>}
        </span>
      </div>

      <textarea
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Ex: cliente pediu retorno depois do dia 10 · já comprou em janeiro · prefere ser chamado de Léo"
        className="min-h-[160px] flex-1 resize-none rounded-lg border bg-[#111116] px-3 py-2.5 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted focus:border-blue-light focus:outline-none"
        style={{ borderColor: 'var(--border-subtle)' }}
      />
    </div>
  );
}
