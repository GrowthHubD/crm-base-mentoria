/**
 * Escopo de unidade — quem vê o quê.
 *
 * Três regras, e a ordem entre elas é a segurança do módulo:
 *
 *  1. Módulo desligado (`FEATURE_UNITS` off) → ninguém filtra nada. O cliente
 *     que não tem filial nunca paga o custo de existir esta camada.
 *  2. Usuário COM `unitId` → só a unidade dele, e ponto. Ele não escolhe.
 *  3. Usuário SEM `unitId` (o dono) → todas, ou a que ele selecionou na tela.
 *
 * A regra 2 vem antes da 3 de propósito: a unidade selecionada é uma
 * PREFERÊNCIA DE VISUALIZAÇÃO, não uma credencial. Se o atendente mandar outra
 * unidade no cabeçalho, ela é ignorada — o recorte dele vem do registro no
 * banco, não do que o navegador pediu. Confiar no cabeçalho aqui seria repetir
 * o erro do gating de plano, que escondia o menu e deixava a URL aberta.
 */
import type { AuthedRequestUser } from './auth-helpers';

/** Módulo vendido à parte — desligado a menos que explicitamente ligado. */
export function unidadesAtivas(): boolean {
  const v = process.env.FEATURE_UNITS?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Cabeçalho que o front usa para dizer qual unidade está selecionada. */
export const HEADER_UNIDADE = 'x-unit-id';

export interface EscopoUnidade {
  /** `null` = sem recorte (vê tudo). Caso contrário, filtrar por este id. */
  unitId: string | null;
  /** True quando o usuário pode alternar entre unidades na tela. */
  podeAlternar: boolean;
}

/**
 * Resolve o recorte desta requisição.
 *
 * `selecionada` vem do cabeçalho `x-unit-id` e SÓ é considerada para quem
 * enxerga todas — ver o comentário do topo.
 */
export function escopoDaRequisicao(
  usuario: Pick<AuthedRequestUser, 'unitId'> & { unitId?: string | null },
  selecionada?: string | null
): EscopoUnidade {
  if (!unidadesAtivas()) return { unitId: null, podeAlternar: false };

  // Usuário preso a uma unidade: o cabeçalho é ignorado.
  if (usuario.unitId) return { unitId: usuario.unitId, podeAlternar: false };

  const escolhida = selecionada?.trim();
  return {
    // "todas" é uma escolha legítima do dono, e vira ausência de filtro.
    unitId: escolhida && escolhida !== 'todas' ? escolhida : null,
    podeAlternar: true,
  };
}

/** Lê a unidade selecionada dos cabeçalhos da requisição. */
export function unidadeSelecionada(req: { headers: Headers }): string | null {
  return req.headers.get(HEADER_UNIDADE);
}
