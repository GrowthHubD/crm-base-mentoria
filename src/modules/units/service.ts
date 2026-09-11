/**
 * Unidades (filiais) — leitura e escrita.
 *
 * Regra que atravessa tudo: `unitId` nulo significa "sem recorte", nunca
 * "unidade inválida". É isso que faz ligar o módulo num cliente que já opera
 * não exigir migração — os leads antigos ficam em `null` e continuam
 * aparecendo para todo mundo até alguém os atribuir.
 */
import { and, asc, eq, isNull, or, type SQL } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { units, type Unit } from '@/lib/db/schema/units';
import { leads } from '@/lib/db/schema/leads';
import { connections } from '@/lib/db/schema/connections';
import { users } from '@/lib/db/schema/users';

export type { Unit };

export async function listarUnidades(incluirInativas = false): Promise<Unit[]> {
  const q = db.select().from(units).orderBy(asc(units.name));
  if (incluirInativas) return q;
  return q.where(eq(units.active, true));
}

export async function criarUnidade(input: {
  name: string;
  slug: string;
  description?: string | null;
}): Promise<Unit> {
  const [row] = await db
    .insert(units)
    .values({
      name: input.name.trim(),
      slug: normalizarSlug(input.slug),
      description: input.description?.trim() || null,
    })
    .returning();
  return row;
}

export async function atualizarUnidade(
  id: string,
  patch: { name?: string; slug?: string; description?: string | null; active?: boolean }
): Promise<Unit | null> {
  const valores: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name !== undefined) valores.name = patch.name.trim();
  if (patch.slug !== undefined) valores.slug = normalizarSlug(patch.slug);
  if (patch.description !== undefined) valores.description = patch.description?.trim() || null;
  if (patch.active !== undefined) valores.active = patch.active;

  const [row] = await db.update(units).set(valores).where(eq(units.id, id)).returning();
  return row ?? null;
}

/**
 * Desativa a unidade. NÃO existe exclusão de propósito.
 *
 * Leads, mensagens e conversões da filial fechada continuam no histórico e no
 * relatório. Apagar a linha os deixaria apontando para nada — o cliente perderia
 * o passado de uma operação que existiu.
 */
export async function desativarUnidade(id: string): Promise<Unit | null> {
  return atualizarUnidade(id, { active: false });
}

/** Quantos registros dependem desta unidade — mostrado antes de desativar. */
export async function usoDaUnidade(id: string) {
  const [l] = await db
    .select({ n: leads.id })
    .from(leads)
    .where(eq(leads.unitId, id))
    .limit(1);
  const [c] = await db
    .select({ n: connections.id })
    .from(connections)
    .where(eq(connections.unitId, id))
    .limit(1);
  const [u] = await db
    .select({ n: users.id })
    .from(users)
    .where(eq(users.unitId, id))
    .limit(1);
  return { temLeads: Boolean(l), temConexoes: Boolean(c), temUsuarios: Boolean(u) };
}

/**
 * Condição de recorte para uma coluna `unit_id`.
 *
 * Devolve `undefined` quando não há recorte — assim quem chama pode passar
 * direto para o `and(...)` sem `if`, e a consulta sem unidade não ganha
 * cláusula nenhuma.
 *
 * O `or(... , isNull(...))` é o coração da migração incremental: filtrar por
 * uma unidade também traz o que ainda não foi atribuído. Sem isso, ligar o
 * módulo faria o board do cliente ficar VAZIO no primeiro acesso, porque todo
 * lead histórico está em `null`.
 */
export function filtroUnidade(
  coluna: Parameters<typeof isNull>[0],
  unitId: string | null | undefined
): SQL | undefined {
  if (!unitId) return undefined;
  return or(eq(coluna as never, unitId), isNull(coluna));
}

/** `and` que ignora os `undefined` — evita `and(a, undefined)` espalhado. */
export function combinar(...partes: Array<SQL | undefined>): SQL | undefined {
  const usadas = partes.filter(Boolean) as SQL[];
  if (usadas.length === 0) return undefined;
  if (usadas.length === 1) return usadas[0];
  return and(...usadas);
}

function normalizarSlug(v: string): string {
  return v
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
