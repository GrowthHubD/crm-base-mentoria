/**
 * CloudApiAdapter — implementa `ChannelAdapter` para o WhatsApp oficial.
 *
 * O contrato foi desenhado em cima da uazapi, que faz mais coisas do que a API
 * oficial permite. Aqui, o que a Meta não oferece vira **no-op com aviso**, e
 * não exceção — é o que o contrato manda, e é o que mantém o CRM funcionando
 * com os dois canais lado a lado:
 *
 *   - `delayMs` ("digitando..."): ignorado. Não existe no canal oficial.
 *   - `deleteMessage` / `editMessage`: não existem. Ficam no log.
 *   - `markAsRead(contactId)`: a Meta marca por MENSAGEM, não por conversa.
 *     Como o contrato só entrega o contato, o adapter marca a última mensagem
 *     recebida que ele conhece (setada pelo webhook via `rememberLastInbound`).
 */
import type { ChannelAdapter } from '../../types';
import { logger } from '@/lib/logger';
import {
  sendText,
  sendTemplate,
  sendImage,
  sendAudio,
  sendVideo,
  sendDocument,
  sendReaction,
  markAsRead,
  type CloudApiCredentials,
  type CloudSendResult,
} from './client';

export class CloudApiAdapter implements ChannelAdapter {
  public lastResult: CloudSendResult | null = null;

  /**
   * Último wamid recebido por contato. A Cloud API precisa de um id de
   * mensagem pra marcar leitura, e o contrato do adapter só passa o contato.
   */
  private static lastInboundByContact = new Map<string, string>();

  constructor(private readonly creds: CloudApiCredentials) {}

  /** Chamado pelo webhook a cada inbound, pra viabilizar o markAsRead. */
  static rememberLastInbound(contactId: string, messageId: string): void {
    CloudApiAdapter.lastInboundByContact.set(contactId, messageId);
  }

  private log(op: string, contactId: string): void {
    if (this.lastResult?.error) {
      logger.warn({ op, contactId, error: this.lastResult.error }, '[cloud-api] envio falhou');
    } else {
      logger.info(
        { op, contactId, messageId: this.lastResult?.message_id },
        '[cloud-api] mensagem enviada'
      );
    }
  }

  /**
   * Envia template aprovado — a única saída fora da janela de 24h.
   *
   * Note que NÃO aceita `quotedExternalId`: a Meta não permite citar mensagem
   * em template, e passar o `context` faria a chamada inteira ser rejeitada.
   */
  async sendTemplate(
    contactId: string,
    templateName: string,
    languageCode: string,
    params?: { header?: string[]; body?: string[] }
  ): Promise<void> {
    this.lastResult = await sendTemplate(this.creds, contactId, templateName, languageCode, params ?? {});
    this.log('sendTemplate', contactId);
  }

  async sendText(
    contactId: string,
    body: string,
    _delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendText(this.creds, contactId, body, quotedExternalId);
    this.log('sendText', contactId);
  }

  async sendImage(
    contactId: string,
    imageUrl: string,
    caption?: string,
    _delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendImage(this.creds, contactId, imageUrl, caption, quotedExternalId);
    this.log('sendImage', contactId);
  }

  async sendAudio(
    contactId: string,
    audioUrl: string,
    _delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendAudio(this.creds, contactId, audioUrl, quotedExternalId);
    this.log('sendAudio', contactId);
  }

  async sendVideo(
    contactId: string,
    videoUrl: string,
    caption?: string,
    _delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendVideo(this.creds, contactId, videoUrl, caption, quotedExternalId);
    this.log('sendVideo', contactId);
  }

  async sendDocument(
    contactId: string,
    docUrl: string,
    filename: string,
    _delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendDocument(
      this.creds,
      contactId,
      docUrl,
      filename,
      undefined,
      quotedExternalId
    );
    this.log('sendDocument', contactId);
  }

  async markAsRead(contactId: string): Promise<void> {
    const messageId = CloudApiAdapter.lastInboundByContact.get(contactId);
    if (!messageId) {
      // Isolate novo (o mapa é por processo) ou conversa sem inbound conhecido.
      // Não é erro: leitura é cosmética e a próxima mensagem repõe o id.
      logger.debug({ contactId }, '[cloud-api] markAsRead sem mensagem conhecida — ignorado');
      return;
    }
    try {
      await markAsRead(this.creds, messageId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, contactId },
        '[cloud-api] markAsRead falhou'
      );
    }
  }

  async deleteMessage(externalMessageId: string): Promise<void> {
    logger.warn(
      { externalMessageId },
      '[cloud-api] apagar mensagem não existe no canal oficial — ignorado'
    );
  }

  async editMessage(externalMessageId: string, _contactId: string, _newText: string): Promise<void> {
    logger.warn(
      { externalMessageId },
      '[cloud-api] editar mensagem não existe no canal oficial — ignorado'
    );
  }

  async reactToMessage(externalMessageId: string, contactId: string, emoji: string): Promise<void> {
    try {
      this.lastResult = await sendReaction(this.creds, contactId, externalMessageId, emoji);
      this.log('reactToMessage', contactId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, externalMessageId },
        '[cloud-api] reação falhou'
      );
    }
  }
}
