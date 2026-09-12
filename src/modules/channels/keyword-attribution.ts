/**
 * Matching de marcador {chave} → canal de atribuição.
 *
 * Regra (cliente, 30/05): marcador SEMPRE entre chaves `{...}`, pode estar em
 * qualquer lugar da mensagem. Substring "solta" não bate mais — só conteúdo
 * dentro das chaves. Isso evita falso positivo (ex: regra "meta" batendo na
 * palavra "meta-pergunta").
 *
 * Fluxo:
 *  1. A cada msg inbound (ou edit), tenta match no texto da msg atual.
 *  2. Se a msg atual não tem marcador, faz BUSCA RETROATIVA nas últimas 50
 *     inbound do lead — cobre o caso em que o marcador veio em msg anterior
 *     (ou em que a regra foi cadastrada depois do lead já ter mandado o
 *     marcador).
 *  3. Match novo sobrescreve atribuição anterior — "Fulano vem 1 mês depois
 *     por outra fonte, o novo valor substitui o último".
 *  4. Sem hit em nenhuma msg do histórico → no-op (mantém atribuição anterior
 *     ou deixa null se nunca teve).
 *
 * Leads sem `attributed_channel` ficam fora da contagem do dashboard de
 * canais (sem fallback pro canal técnico). É proposital — dashboard mostra
 * SÓ leads que vieram por anúncio rastreado.
 */
import { logger } from '@/lib/logger';
import type { ChannelKeywordRule } from '@/lib/db/schema/ai-agent-config';

const MARKER_REGEX = /\{([^{}]+)\}/g;

const RETROACTIVE_LIMIT = 50;

/**
 * Extrai todos os marcadores `{x}` do texto, retorna lista normalizada
 * (lowercase, trimmed, vazios removidos). Ex:
 *   "vim do {1} {ig} olá" → ["1", "ig"]
 */
export function extractMarkers(text: string | null | undefined): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(MARKER_REGEX)) {
    const inner = m[1].trim();
    if (inner) out.push(inner.toLowerCase());
  }
  return out;
}

/**
 * Encontra a primeira regra cuja `keyword` casa com algum marcador extraído
 * de `text`. Tolerante: se o cliente cadastrou `{1}` ou apenas `1` na regra,
 * ambos são equivalentes (strip de `{}` antes do compare).
 */
export function matchChannelKeyword(
  text: string | null | undefined,
  rules: ChannelKeywordRule[] | null | undefined
): ChannelKeywordRule | null {
  if (!rules || rules.length === 0) return null;
  const markers = extractMarkers(text);
  if (markers.length === 0) return null;
  for (const rule of rules) {
    if (!rule.keyword) continue;
    const expected = rule.keyword.replace(/[{}]/g, '').trim().toLowerCase();
    if (!expected) continue;
    if (markers.includes(expected)) return rule;
  }
  return null;
}

async function searchHistoryForMarker(
  leadId: string,
  rules: ChannelKeywordRule[]
): Promise<ChannelKeywordRule | null> {
  try {
    const { db } = await import('@/lib/db/client');
    const { messages } = await import('@/lib/db/schema/messages');
    const { and, eq, desc } = await import('drizzle-orm');
    const rows = await db
      .select({ body: messages.body })
      .from(messages)
      .where(and(eq(messages.leadId, leadId), eq(messages.direction, 'inbound')))
      .orderBy(desc(messages.timestamp))
      .limit(RETROACTIVE_LIMIT);
    for (const row of rows) {
      const hit = matchChannelKeyword(row.body, rules);
      if (hit) return hit;
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId },
      '[keyword-attribution] busca retroativa falhou'
    );
    return null;
  }
}

/**
 * Reavalia atribuição do lead. Tenta a msg atual primeiro; sem hit, busca
 * retroativamente nas últimas N inbound. Atualiza `attributedChannel` quando
 * canal encontrado difere do atual.
 */
export async function reevaluateChannelAttribution(args: {
  leadId: string;
  text: string | null | undefined;
  currentAttribution: string | null | undefined;
  rules: ChannelKeywordRule[] | null | undefined;
  source?: 'inbound' | 'edit';
}): Promise<{ changed: boolean; channel: string | null }> {
  if (!args.rules || args.rules.length === 0) {
    return { changed: false, channel: args.currentAttribution ?? null };
  }
  let hit = matchChannelKeyword(args.text, args.rules);
  let matchedIn: 'current' | 'history' = 'current';
  if (!hit) {
    hit = await searchHistoryForMarker(args.leadId, args.rules);
    if (hit) matchedIn = 'history';
  }
  if (!hit) return { changed: false, channel: args.currentAttribution ?? null };
  if (hit.channel === args.currentAttribution) {
    return { changed: false, channel: hit.channel };
  }
  try {
    const { patchLead } = await import('@/modules/leads/service');
    await patchLead(args.leadId, { attributedChannel: hit.channel });
    logger.info(
      {
        leadId: args.leadId,
        keyword: hit.keyword,
        channel: hit.channel,
        previousChannel: args.currentAttribution ?? null,
        source: args.source ?? 'inbound',
        matchedIn,
      },
      '[keyword-attribution] canal (re)atribuído'
    );
    return { changed: true, channel: hit.channel };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId: args.leadId },
      '[keyword-attribution] falha ao atribuir canal'
    );
    return { changed: false, channel: args.currentAttribution ?? null };
  }
}
