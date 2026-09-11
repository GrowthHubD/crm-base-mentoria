/**
 * Qual das duas aparências do quadro esta instalação usa.
 *
 * Nasceu de um estrago: o quadro foi remodelado para um cliente de prospecção
 * — card apertado, faixa horizontal, sem os botões de mover — e o deploy levou
 * isso para os CRMs de atendimento, que não pediram nada. O dono de um deles
 * reclamou do "zoom" no mesmo dia.
 *
 * As medidas em si estão em `globals.css`, sob `[data-kanban='compacto']`.
 * Aqui só se decide qual vale, e a decisão é do SERVIDOR: um mesmo build vai
 * para os sete Workers, então ler isso no cliente daria a todos a aparência de
 * quem estava no `.env` na hora de compilar — o mesmo erro que os
 * `NEXT_PUBLIC_FEATURE_*` causaram (ver o cabeçalho de `lib/plan.ts`).
 *
 * Padrão CONFORTÁVEL de propósito: um deploy que esqueça a variável devolve a
 * aparência que o cliente já conhecia, e não a de outro.
 */
export type DensidadeKanban = 'confortavel' | 'compacto';

export function densidadeKanban(): DensidadeKanban {
  const v = process.env.UI_KANBAN_COMPACTO?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' ? 'compacto' : 'confortavel';
}
