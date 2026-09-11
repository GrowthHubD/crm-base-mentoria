/**
 * UazapiAdapter — implementa ChannelAdapter para WhatsApp via uazapi v2.
 *
 * Pattern: cada instância (número WhatsApp) tem seu próprio token de instância
 * armazenado em `whatsapp_instances` (criptografado em `metadata.token`). O
 * adapter recebe o token no construtor e expõe os métodos do contrato
 * `ChannelAdapter` para uso pelos workers e service layer.
 *
 * NUNCA chame `client.ts` direto fora deste módulo — sempre via adapter, pra
 * facilitar troca de provider no futuro (ex: Evolution).
 */
import type { ChannelAdapter } from '../types';
import {
  sendText,
  sendImage,
  sendAudio,
  sendDocument,
  sendVideo,
  sendMedia,
  sendReaction,
  markAsRead,
  deleteMessage,
  editMessage,
  type UazapiSendResult,
} from './client';
import { ensureOggDataUri } from './audio-convert';
import { logger } from '@/lib/logger';

export interface UazapiAdapterOptions {
  /** Token específico da instância. Se ausente, cliente cai no admin token global. */
  instanceToken?: string;
  /** ID interno da instância (apenas para logging/contexto). */
  instanceId?: string;
}

/**
 * Adaptador uazapi do `ChannelAdapter`. Métodos retornam void no contrato
 * principal; mensagens externas (uazapi message_id) ficam disponíveis via
 * `lastResult` para callers que precisam persistir.
 */
export class UazapiAdapter implements ChannelAdapter {
  /** Resultado da última operação (útil pra capturar uazapi message_id) */
  public lastResult: UazapiSendResult | null = null;

  constructor(private readonly opts: UazapiAdapterOptions = {}) {}

  private get token(): string | undefined {
    return this.opts.instanceToken;
  }

  /**
   * `delayMs` (opcional): tempo em ms que a uazapi deve manter o status
   * "digitando..." no WhatsApp do destinatário antes da entrega. Workers e
   * service layer calculam um valor proporcional ao tamanho do texto pra
   * simular digitação humana — tanto da IA quanto de atendentes/agendados.
   */
  async sendText(contactId: string, body: string, delayMs?: number, quotedExternalId?: string | null): Promise<void> {
    this.lastResult = await sendText(this.token, contactId, body, delayMs, quotedExternalId);
    this.logResult('sendText', contactId);
  }

  async sendImage(contactId: string, imageUrl: string, caption?: string, delayMs?: number, quotedExternalId?: string | null): Promise<void> {
    this.lastResult = await sendImage(this.token, contactId, imageUrl, caption, delayMs, quotedExternalId);
    this.logResult('sendImage', contactId);
  }

  /**
   * Envia áudio. Aceita data URI ou URL HTTPS.
   *
   * Se for `data:audio/webm`, converte automaticamente pra `data:audio/ogg;codecs=opus`
   * (formato exigido pelo WhatsApp pra renderizar como balão de voz / PTT).
   * Caso a conversão falhe, envia o original como fallback (vai como anexo).
   *
   * `delayMs`: presence "gravando áudio..." pelo intervalo antes da entrega.
   */
  async sendAudio(contactId: string, audioUrl: string, delayMs?: number, _quotedExternalId?: string | null): Promise<void> {
    let finalUrl = audioUrl;
    if (audioUrl.startsWith('data:')) {
      finalUrl = await ensureOggDataUri(audioUrl);
    }
    // sendAudio do client uazapi ainda não suporta replyid — quote em áudio
    // é uso raro; aceito o parâmetro pra match da interface e ignoro silently.
    this.lastResult = await sendAudio(this.token, contactId, finalUrl, true, delayMs);
    this.logResult('sendAudio', contactId);
  }

  async sendDocument(contactId: string, docUrl: string, filename: string, delayMs?: number, _quotedExternalId?: string | null): Promise<void> {
    this.lastResult = await sendDocument(this.token, contactId, docUrl, filename, delayMs);
    this.logResult('sendDocument', contactId);
  }

  async markAsRead(contactId: string): Promise<void> {
    await markAsRead(this.token, contactId);
  }

  // ── Métodos extras (não estão no contrato base mas úteis) ──

  async sendVideo(contactId: string, videoUrl: string, caption?: string, delayMs?: number, quotedExternalId?: string | null): Promise<void> {
    this.lastResult = await sendVideo(this.token, contactId, videoUrl, caption, delayMs, quotedExternalId);
    this.logResult('sendVideo', contactId);
  }

  async sendMediaAuto(
    contactId: string,
    mediaUrl: string,
    fileName?: string,
    caption?: string,
    delayMs?: number
  ): Promise<void> {
    this.lastResult = await sendMedia(this.token, contactId, mediaUrl, fileName, caption, delayMs);
    this.logResult('sendMediaAuto', contactId);
  }

  /** Apaga mensagem no WhatsApp (uazapi /message/delete). */
  async deleteMessage(messageId: string): Promise<void> {
    await deleteMessage(this.token, messageId);
  }

  /** Edita texto de mensagem outbound já enviada. */
  async editMessage(messageId: string, phone: string, newText: string): Promise<void> {
    await editMessage(this.token, messageId, phone, newText);
  }

  /** Reage (ou remove reação com emoji=''). Best-effort: log e segue se falhar. */
  async reactToMessage(messageId: string, phone: string, emoji: string): Promise<void> {
    try {
      this.lastResult = await sendReaction(this.token, phone, messageId, emoji);
      this.logResult('reactToMessage', phone);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, messageId, phone, emoji },
        '[uazapi-adapter] reactToMessage falhou (segue — reação local ainda persistida)'
      );
    }
  }

  private logResult(op: string, contactId: string) {
    if (!this.lastResult) return;
    if (this.lastResult.error) {
      logger.warn(
        {
          op,
          instanceId: this.opts.instanceId,
          contactId,
          error: this.lastResult.error,
        },
        '[uazapi-adapter] envio com erro'
      );
    } else {
      logger.debug(
        {
          op,
          instanceId: this.opts.instanceId,
          contactId,
          messageId: this.lastResult.message_id,
        },
        '[uazapi-adapter] envio OK'
      );
    }
  }
}

/**
 * Factory: cria adapter pronto a partir do token criptografado guardado em
 * `connections.access_token_encrypted`. Faz decrypt e instancia.
 *
 * Uso comum: workers chamam `createAdapterForConnection(connectionId)` antes
 * de cada envio (cache curto pode ser adicionado depois se virar gargalo).
 */
export function createUazapiAdapter(opts: UazapiAdapterOptions): UazapiAdapter {
  return new UazapiAdapter(opts);
}
