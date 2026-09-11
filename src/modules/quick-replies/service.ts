/**
 * Service de textos rápidos. CRUD simples por unit — usado pelo painel
 * /configuracoes (admin) e pelo composer do CRM (atendente lê pra montar
 * o picker do slash command).
 */
import { db } from '@/lib/db/client';
import { quickReplies, type QuickReplyRow } from '@/lib/db/schema/quick-replies';
import { eq, asc, sql } from 'drizzle-orm';

const MAX_SHORTCUT = 40;
const MAX_BODY = 2000;
const MAX_LABEL = 80;
const MAX_VARIATIONS = 10;

export interface QuickReplyInput {
  shortcut: string;
  body: string;
  label?: string | null;
  /** Variações alternativas (anti-ban). Trimmed, deduplicadas vs body. */
  variations?: string[] | null;
}

/**
 * Normaliza/valida a lista de variações: trim, remove vazias, remove
 * duplicatas (e a que for igual ao body — body já é a 1ª opção), cap em
 * MAX_VARIATIONS e MAX_BODY por item. Retorna null quando não sobra nenhuma
 * (mantém a coluna limpa em vez de [] vazio).
 */
function normalizeVariations(raw: string[] | null | undefined, body: string): string[] | null {
  if (!raw || !Array.isArray(raw)) return null;
  const seen = new Set<string>([body.trim()]);
  const out: string[] = [];
  for (const v of raw) {
    const t = (v ?? '').trim();
    if (!t) continue;
    if (t.length > MAX_BODY) throw new Error(`variação excede ${MAX_BODY} caracteres`);
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_VARIATIONS) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Sorteia uma variação do atalho. Inclui sempre o `body` como 1ª opção.
 * Determinístico só na ausência de variações (retorna body). A aleatoriedade
 * é o ponto: evita texto idêntico repetido pra muitos contatos.
 */
export function pickVariation(row: Pick<QuickReplyRow, 'body' | 'variations'>): string {
  const pool = [row.body, ...((row.variations as string[] | null) ?? [])].filter(Boolean);
  if (pool.length <= 1) return row.body;
  return pool[Math.floor(Math.random() * pool.length)];
}

function normalizeShortcut(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    // sem espaços, caracteres especiais limitados — só letra/numero/underscore/hifen
    .replace(/[^a-z0-9_-]+/g, '');
}

function validate(
  input: QuickReplyInput
): { shortcut: string; body: string; label: string | null; variations: string[] | null } {
  const shortcut = normalizeShortcut(input.shortcut);
  if (!shortcut) throw new Error('atalho vazio ou inválido (use letras, números, _ ou -)');
  if (shortcut.length > MAX_SHORTCUT) throw new Error(`atalho excede ${MAX_SHORTCUT} caracteres`);
  const body = (input.body ?? '').trim();
  if (!body) throw new Error('mensagem vazia');
  if (body.length > MAX_BODY) throw new Error(`mensagem excede ${MAX_BODY} caracteres`);
  const label = input.label ? input.label.trim().slice(0, MAX_LABEL) || null : null;
  const variations = normalizeVariations(input.variations, body);
  return { shortcut, body, label, variations };
}

export async function listByUnit(): Promise<QuickReplyRow[]> {
  return db
    .select()
    .from(quickReplies)
    .orderBy(asc(quickReplies.shortcut));
}

export async function create(input: QuickReplyInput): Promise<QuickReplyRow> {
  const v = validate(input);
  const [row] = await db
    .insert(quickReplies)
    .values({ shortcut: v.shortcut, body: v.body, label: v.label, variations: v.variations })
    .returning();
  return row;
}

export async function update(id: string, input: QuickReplyInput): Promise<QuickReplyRow | null> {
  const v = validate(input);
  const [row] = await db
    .update(quickReplies)
    .set({ shortcut: v.shortcut, body: v.body, label: v.label, variations: v.variations, updatedAt: new Date() })
    .where(eq(quickReplies.id, id))
    .returning();
  return row ?? null;
}

export async function remove(id: string): Promise<boolean> {
  const result = await db
    .delete(quickReplies)
    .where(eq(quickReplies.id, id))
    .returning({ id: quickReplies.id });
  return result.length > 0;
}

/** Janela default do detector de repetição (horas). */
export const REPETITION_WINDOW_HOURS = 3;
/** Tamanho mínimo de texto pra valer a pena checar (ignora "ok", "sim"). */
const REPETITION_MIN_LEN = 25;

export interface RepetitionResult {
  /** Quantas vezes texto idêntico saiu (outbound) na janela. */
  count: number;
  windowHours: number;
}

/**
 * Conta quantas vezes uma mensagem outbound IDÊNTICA (trim) já saiu nas
 * últimas N horas — independente de ter sido pelo CRM ou pelo celular
 * (owner echo entra como outbound no banco). Alimenta o alerta anti-ban do
 * composer: "essa mensagem já saiu X vezes, varie pra não cair em spam".
 *
 * Texto curto (< REPETITION_MIN_LEN) retorna 0 — "oi", "ok" repetem natural.
 */
export async function countRecentIdenticalOutbound(
  text: string,
  windowHours = REPETITION_WINDOW_HOURS
): Promise<RepetitionResult> {
  const trimmed = (text ?? '').trim();
  if (trimmed.length < REPETITION_MIN_LEN) return { count: 0, windowHours };
  const res = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from messages m
    where m.direction = 'outbound'
      and m.timestamp > now() - (${windowHours} || ' hours')::interval
      and btrim(m.body) = ${trimmed}
  `);
  const arr = Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows ?? [];
  const count = Number((arr[0] as { n?: number } | undefined)?.n ?? 0);
  return { count, windowHours };
}
