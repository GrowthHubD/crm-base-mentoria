/**
 * Notificação de falha de API via WhatsApp para o admin da instância.
 *
 * Usa instância DEDICADA de sistema (`SYSTEM_WHATSAPP_INSTANCE_TOKEN`) — nunca
 * uma instância de atendimento (PRD Rule 17). Nunca propaga erro pra cima
 * (PRD Rule 18 — silenciar pra evitar cascade de falhas).
 *
 * Comportamento:
 *   - Sem ADMIN_WHATSAPP_NUMBER ou token: log warn e sai silenciosamente
 *   - Erro de envio: log error e sai silenciosamente
 *   - Sucesso: log info
 */
import { logger } from '../logger';
import { APP_NAME } from '../branding';
import { sendText, UazapiError } from '@/modules/channels/whatsapp/client';

export interface ApiFailureDetails {
  service: 'whatsapp' | 'ai' | 'storage' | string;
  operation: string;
  errorMessage: string;
  statusCode?: number;
  leadId?: string;
  connectionId?: string;
  /** Stack/contexto extra (não é exposto no WhatsApp, só nos logs) */
  context?: Record<string, unknown>;
}

export async function notifyAPIFailure(details: ApiFailureDetails): Promise<void> {
  const adminPhone = process.env.ADMIN_WHATSAPP_NUMBER;
  // Token DEDICADO de sistema; fallback pro token global em dev
  const systemToken =
    process.env.SYSTEM_WHATSAPP_INSTANCE_TOKEN || process.env.UAZAPI_TOKEN || '';

  if (!adminPhone) {
    logger.warn(
      { service: details.service, operation: details.operation },
      '[notify] ADMIN_WHATSAPP_NUMBER não configurado — falha não notificada'
    );
    return;
  }
  if (!systemToken) {
    logger.warn('[notify] SYSTEM_WHATSAPP_INSTANCE_TOKEN/UAZAPI_TOKEN ausentes — falha não notificada');
    return;
  }

  const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const message =
    `⚠️ *${APP_NAME} — Falha de API*\n\n` +
    `*Módulo:* ${details.service}\n` +
    `*Operação:* ${details.operation}\n` +
    `${details.statusCode ? `*Status:* ${details.statusCode}\n` : ''}` +
    `*Erro:* ${details.errorMessage}\n` +
    `${details.leadId ? `*Lead:* ${details.leadId}\n` : ''}` +
    `*Horário:* ${timestamp}`;

  try {
    const result = await sendText(systemToken, adminPhone, message);
    if (result.error) {
      logger.error(
        { details, uazapiError: result.error },
        '[notify] uazapi retornou erro — falha não chegou ao admin'
      );
      return;
    }
    logger.info(
      { adminPhone, service: details.service, messageId: result.message_id },
      '[notify] alerta enviado ao admin'
    );
  } catch (err) {
    if (err instanceof UazapiError) {
      logger.error(
        { details, status: err.status, body: err.body.slice(0, 200) },
        '[notify] uazapi rejeitou notificação — falha não chegou ao admin'
      );
    } else {
      logger.error(
        { details, err: err instanceof Error ? err.message : err },
        '[notify] erro inesperado ao enviar notificação'
      );
    }
    // NUNCA propaga (PRD Rule 18)
  }
}
