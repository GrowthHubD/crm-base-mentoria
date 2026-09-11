/**
 * Contrato uniforme que todo canal implementa. Workers e service layer
 * dependem APENAS desta interface — adapters concretos (uazapi, Instagram
 * Graph, futura Evolution) ficam isolados em `<canal>/adapter.ts`.
 *
 * Métodos que um provedor não suporta nativamente (ex: editMessage no
 * Instagram) devem fazer no-op + log de warning, NÃO throw — o caller já
 * lida com graceful degradation.
 *
 * `delayMs`: presence "digitando..." antes da entrega. WhatsApp via uazapi
 * suporta nativamente; Instagram Graph API não — o adapter IG ignora o
 * parâmetro silenciosamente.
 */

export interface ChannelSendResult {
  /** ID externo da mensagem (uazapi message_id, IG mid, etc.). Usado pra
   *  rastrear status de entrega e deduplicar echoes. */
  message_id?: string;
  /** Mensagem de erro descritiva (string única — adapters concretos
   *  serializam códigos/subcódigos do provedor pro formato textual). */
  error?: string;
}

export interface ChannelAdapter {
  /** Disponível após qualquer send*; contém o external message_id pra persistir. */
  readonly lastResult: ChannelSendResult | null;

  /**
   * `quotedExternalId`: messageId externo da mensagem citada (reply/quote no
   * WhatsApp). Quando setado, o balão é renderizado pelo WhatsApp citando a
   * msg original. Provedores que não suportam quote (ex: Instagram via Graph)
   * devem ignorar silenciosamente.
   */
  sendText(contactId: string, body: string, delayMs?: number, quotedExternalId?: string | null): Promise<void>;
  sendImage(contactId: string, imageUrl: string, caption?: string, delayMs?: number, quotedExternalId?: string | null): Promise<void>;
  sendAudio(contactId: string, audioUrl: string, delayMs?: number, quotedExternalId?: string | null): Promise<void>;
  sendVideo(contactId: string, videoUrl: string, caption?: string, delayMs?: number, quotedExternalId?: string | null): Promise<void>;
  sendDocument(contactId: string, docUrl: string, filename: string, delayMs?: number, quotedExternalId?: string | null): Promise<void>;

  /**
   * Envia um template pré-aprovado. OPCIONAL de propósito: só a API oficial
   * tem o conceito. Na uazapi qualquer texto sai a qualquer hora, então quem
   * precisa de template pergunta antes se o adapter oferece — em vez de a
   * interface obrigar todo provedor a fingir que suporta.
   *
   * É o único envio possível fora da janela de 24h da Meta.
   */
  sendTemplate?(
    contactId: string,
    templateName: string,
    languageCode: string,
    params?: { header?: string[]; body?: string[] }
  ): Promise<void>;

  markAsRead(contactId: string): Promise<void>;

  /** Apaga mensagem outbound já entregue. No-op em canais que não suportam. */
  deleteMessage(externalMessageId: string): Promise<void>;
  /** Edita texto de mensagem outbound. No-op em canais que não suportam. */
  editMessage(externalMessageId: string, contactId: string, newText: string): Promise<void>;
  /**
   * Reage com emoji a uma mensagem. `emoji = ''` REMOVE reação anterior.
   * No-op em canais que não suportam reactions.
   */
  reactToMessage(externalMessageId: string, contactId: string, emoji: string): Promise<void>;
}

export type ChannelType = 'whatsapp';

export interface ChannelConnection {
  id: string;
  type: ChannelType;
  externalId: string;
  displayName?: string | null;
  status: 'pending' | 'qr_pending' | 'connected' | 'disconnected' | 'error';
}
