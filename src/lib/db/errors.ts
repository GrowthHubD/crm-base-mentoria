/**
 * Desembrulha um erro de banco até a causa de verdade.
 *
 * Existe por uma cegueira concreta: o CRM tinha um 500 intermitente em ~3% das
 * requisições, e o log só mostrava a mensagem que o Drizzle monta —
 * `Failed query: select "id", "email", ...`. Isso diz QUAL consulta caiu, e não
 * diz nada sobre o porquê: o erro do driver fica pendurado em `err.cause` e o
 * pino serializa só o topo, então a informação que importa nunca chegava.
 *
 * O `postgres.js` põe o motivo em campos que não são `message` (`code`,
 * `severity`, `routine`, `errno`, `address`) — um `CONNECTION_CLOSED` e um
 * `53300 too_many_connections` viram a MESMA linha de log sem isto, e são
 * problemas opostos.
 *
 * Só observabilidade: não altera fluxo, não engole erro, não toca no banco.
 */

/** Campos que carregam o motivo real; o resto do objeto de erro é ruído. */
const CAMPOS = [
  'name',
  'message',
  'code',
  'errno',
  'severity',
  'routine',
  'detail',
  'hint',
  'constraint_name',
  'address',
  'port',
  'syscall',
] as const;

/** Profundidade máxima da cadeia de `cause`. Cinco é folga: na prática o driver
 *  fica em um ou dois níveis, e o limite evita laço se algum erro se
 *  auto-referenciar. */
const PROFUNDIDADE_MAX = 5;

export interface CamadaErro {
  nivel: number;
  [campo: string]: unknown;
}

/**
 * Achata `err` e toda a cadeia de `cause` numa lista serializável.
 * O nível 0 é o erro do Drizzle; o motivo real costuma estar no nível 1.
 */
export function describeDbError(err: unknown): { cadeia: CamadaErro[] } {
  const cadeia: CamadaErro[] = [];
  const vistos = new Set<unknown>();
  let atual: unknown = err;

  for (let nivel = 0; nivel < PROFUNDIDADE_MAX && atual; nivel++) {
    // Erro que aponta pra si mesmo existe e trava o laço.
    if (vistos.has(atual)) break;
    vistos.add(atual);

    const e = atual as Record<string, unknown>;
    const camada: CamadaErro = { nivel };
    for (const campo of CAMPOS) {
      if (e[campo] !== undefined && e[campo] !== null) camada[campo] = e[campo];
    }
    cadeia.push(camada);
    atual = e.cause;
  }

  return { cadeia };
}
