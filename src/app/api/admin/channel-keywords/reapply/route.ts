/**
 * POST /api/admin/channel-keywords/reapply — aplica retroativamente as regras
 * de atribuição de canal nos leads existentes da unit ativa.
 *
 * Use caso: admin cadastra/edita uma keyword em /agente-ia → quer que leads
 * antigos cujas mensagens já contêm o marcador sejam reatribuídos sem
 * precisar esperar nova msg. ANTES desse endpoint, as regras só rodavam
 * em mensagens NOVAS (inbound ou edit).
 *
 * Estratégia: itera todos leads da unit; pra cada um chama
 * `reevaluateChannelAttribution` com `text=null` — força fallback no
 * histórico (`searchHistoryForMarker` varre as últimas 50 inbound).
 * O helper já pula no-op (sem mudança) e só faz UPDATE quando o canal
 * resolvido difere do atual.
 *
 * Apenas admin/super_admin. Síncrono: bloqueia até terminar — pra units
 * com milhares de leads, pode demorar 30s+. Limita a 5000 leads por
 * chamada como guard.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth-helpers';
import { db } from '@/lib/db/client';
import { leads } from '@/lib/db/schema/leads';
import { getConfigRow } from '@/modules/ai-agent/queries';
import { reevaluateChannelAttribution } from '@/modules/channels/keyword-attribution';
import { logger } from '@/lib/logger';

const MAX_LEADS_PER_RUN = 5000;

export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  const cfg = await getConfigRow();
  const rules = cfg?.channelKeywords ?? [];
  if (rules.length === 0) {
    return NextResponse.json({
      total: 0,
      updated: 0,
      message: 'Nenhuma regra de atribuição cadastrada. Adicione regras em "Atribuição de Canal por Palavra-chave" antes de reaplicar.',
    });
  }

  // Lista todos os leads. Qualquer lead com histórico de inbound é candidato
  // a reatribuição.
  const rows = await db
    .select({ id: leads.id, attributedChannel: leads.attributedChannel })
    .from(leads)
    .limit(MAX_LEADS_PER_RUN);

  let updated = 0;
  let scanned = 0;
  for (const lead of rows) {
    scanned++;
    try {
      const res = await reevaluateChannelAttribution({
        leadId: lead.id,
        text: null, // força fallback histórico (busca nas últimas 50 inbound)
        currentAttribution: lead.attributedChannel,
        rules,
        source: 'inbound',
      });
      if (res.changed) updated++;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, leadId: lead.id },
        '[channel-keywords.reapply] reavaliação falhou (segue pros próximos)'
      );
    }
  }

  logger.info(
    { total: scanned, updated, rules: rules.length },
    '[channel-keywords.reapply] retroativa concluída'
  );
  return NextResponse.json({
    total: scanned,
    updated,
    rulesCount: rules.length,
    capped: scanned >= MAX_LEADS_PER_RUN,
  });
}
