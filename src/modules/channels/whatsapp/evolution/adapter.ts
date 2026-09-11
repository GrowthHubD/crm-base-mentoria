/**
 * EvolutionAdapter — implementa `ChannelAdapter` para WhatsApp via Evolution API v2.
 *
 * Diferente do `CloudApiAdapter`, aqui **não há no-op por limitação do
 * provedor**: a Evolution roda em cima do Baileys, então "digitando...",
 * editar, apagar e reagir existem de verdade. O contrato foi desenhado em cima
 * da uazapi, que é a mesma família — e por isso encaixa quase um-para-um.
 *
 * O único ponto que exige contexto extra é o `markAsRead`, e pela mesma razão
 * que na Cloud API: o contrato entrega o CONTATO, e o WhatsApp marca leitura
 * por MENSAGEM. A key da última mensagem recebida é alimentada pelo webhook
 * via `rememberLastInbound`.
 *
 * `sendTemplate` não é implementado de propósito. É opcional no contrato e só
 * a API oficial tem o conceito — na Evolution qualquer texto sai a qualquer
 * hora, então fingir suporte só produziria um caminho morto.
 */
import type { ChannelAdapter } from '../../types';
import { logger } from '@/lib/logger';
import { ensureOggDataUri } from '../audio-convert';
import {
  sendText,
  sendMedia,
  sendWhatsAppAudio,
  sendReaction,
  markAsRead,
  deleteMessage,
  editMessage,
  type EvolutionCredentials,
  type EvolutionMessageKey,
  type EvolutionSendResult,
} from './client';

export class EvolutionAdapter implements ChannelAdapter {
  public lastResult: EvolutionSendResult | null = null;

  /**
   * Última key inbound por contato. Estático (e não por instância) porque o
   * adapter é recriado a cada envio e cacheado por pouco tempo no service —
   * guardar no objeto perderia o contexto entre o webhook e o envio seguinte.
   *
   * Cache best-effort: se o isolate reciclar, `markAsRead` vira no-op com log,
   * que é degradação aceitável (o cliente vê a mensagem não lida por mais um
   * tempo; nada se perde).
   */
  private static lastInboundByContact = new Map<string, EvolutionMessageKey>();

  /**
   * Destino de cada mensagem que ENVIAMOS, por id.
   *
   * Existe porque `deleteMessage` do contrato recebe só o id, e o WhatsApp
   * exige a key inteira (jid + fromMe + id) para apagar. Em vez de mudar a
   * interface — que os outros dois canais já cumprem — anotamos o jid no
   * momento do envio, que é quando ele é conhecido de graça.
   *
   * Limitado a `MAX_OUTBOUND_KEYS` entradas: apagar mensagem é ação de
   * segundos após o envio, então guardar histórico longo só vazaria memória
   * no isolate.
   */
  private static outboundJidById = new Map<string, string>();

  private static readonly MAX_OUTBOUND_KEYS = 500;

  constructor(private readonly creds: EvolutionCredentials) {}

  /** Chamado pelo ingest a cada inbound, para viabilizar o `markAsRead`. */
  static rememberLastInbound(contactId: string, key: EvolutionMessageKey): void {
    EvolutionAdapter.lastInboundByContact.set(normalizeContact(contactId), key);
  }

  /** Anota o destino do que acabou de sair, para um `deleteMessage` posterior. */
  private rememberOutbound(contactId: string): void {
    const id = this.lastResult?.message_id;
    if (!id) return;

    const map = EvolutionAdapter.outboundJidById;
    if (map.size >= EvolutionAdapter.MAX_OUTBOUND_KEYS) {
      // Map preserva ordem de inserção: a primeira chave é a mais antiga.
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(id, toJid(contactId));
  }

  private log(op: string, contactId: string): void {
    this.rememberOutbound(contactId);
    if (this.lastResult?.error) {
      logger.warn(
        { op, instance: this.creds.instanceName, contactId, error: this.lastResult.error },
        '[evolution] envio falhou'
      );
    } else {
      logger.debug(
        { op, instance: this.creds.instanceName, contactId, messageId: this.lastResult?.message_id },
        '[evolution] envio OK'
      );
    }
  }

  async sendText(
    contactId: string,
    body: string,
    delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendText(this.creds, contactId, body, delayMs, quotedExternalId);
    this.log('sendText', contactId);
  }

  async sendImage(
    contactId: string,
    imageUrl: string,
    caption?: string,
    delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendMedia(this.creds, contactId, 'image', imageUrl, {
      caption,
      delayMs,
      quotedExternalId,
    });
    this.log('sendImage', contactId);
  }

  async sendVideo(
    contactId: string,
    videoUrl: string,
    caption?: string,
    delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendMedia(this.creds, contactId, 'video', videoUrl, {
      caption,
      delayMs,
      quotedExternalId,
    });
    this.log('sendVideo', contactId);
  }

  /**
   * Envia áudio como balão de voz (PTT).
   *
   * Mesma conversão que o adapter uazapi faz: um `data:audio/webm` gravado no
   * browser vira `ogg/opus` antes de sair, porque é o formato que o WhatsApp
   * renderiza como voz. Falhando a conversão, segue o original — vira anexo,
   * o que é pior que ideal mas melhor que não enviar.
   */
  async sendAudio(
    contactId: string,
    audioUrl: string,
    delayMs?: number,
    _quotedExternalId?: string | null
  ): Promise<void> {
    let finalUrl = audioUrl;
    if (audioUrl.startsWith('data:')) {
      finalUrl = await ensureOggDataUri(audioUrl);
    }
    // A Evolution não aceita `quoted` em sendWhatsAppAudio. Quote em áudio é
    // uso raro; aceito o parâmetro para casar com a interface e ignoro.
    this.lastResult = await sendWhatsAppAudio(this.creds, contactId, finalUrl, delayMs);
    this.log('sendAudio', contactId);
  }

  async sendDocument(
    contactId: string,
    docUrl: string,
    filename: string,
    delayMs?: number,
    quotedExternalId?: string | null
  ): Promise<void> {
    this.lastResult = await sendMedia(this.creds, contactId, 'document', docUrl, {
      fileName: filename,
      delayMs,
      quotedExternalId,
    });
    this.log('sendDocument', contactId);
  }

  /**
   * Marca como lida a última mensagem conhecida daquele contato.
   *
   * Sem key conhecida vira no-op com log — nunca throw. Marcar leitura é
   * cortesia visual: falhar aqui não pode derrubar o fluxo de atendimento.
   */
  async markAsRead(contactId: string): Promise<void> {
    const key = EvolutionAdapter.lastInboundByContact.get(normalizeContact(contactId));
    if (!key) {
      logger.debug(
        { contactId, instance: this.creds.instanceName },
        '[evolution] markAsRead sem key inbound conhecida — ignorado'
      );
      return;
    }
    await markAsRead(this.creds, [key]);
  }

  /**
   * Apaga mensagem outbound já entregue.
   *
   * O contrato entrega só o id; o WhatsApp exige a key inteira. O jid vem do
   * registro feito no envio (`rememberOutbound`). Se o isolate reciclou entre
   * o envio e o pedido de apagar, vira no-op com aviso — nunca throw, porque
   * o CRM já apagou a mensagem localmente e o caller conta com degradação
   * suave. `fromMe: true` é sempre correto: só apagamos o que nós enviamos.
   */
  async deleteMessage(externalMessageId: string): Promise<void> {
    const remoteJid = EvolutionAdapter.outboundJidById.get(externalMessageId);
    if (!remoteJid) {
      logger.warn(
        { externalMessageId, instance: this.creds.instanceName },
        '[evolution] deleteMessage sem destino conhecido — a Evolution exige o remoteJid'
      );
      return;
    }
    await deleteMessage(this.creds, { remoteJid, fromMe: true, id: externalMessageId });
  }

  async editMessage(externalMessageId: string, contactId: string, newText: string): Promise<void> {
    this.lastResult = await editMessage(
      this.creds,
      { remoteJid: toJid(contactId), fromMe: true, id: externalMessageId },
      newText
    );
    this.log('editMessage', contactId);
  }

  /**
   * Reage com emoji (`emoji = ''` remove). Best-effort, como no uazapi: a
   * reação já foi persistida localmente antes de chegar aqui, então falhar no
   * provedor é uma dessincronia visual, não perda de dado.
   *
   * `fromMe: false` porque reagimos a mensagens RECEBIDAS na esmagadora
   * maioria dos casos; quando a key exata é conhecida, o ingest a guardou.
   */
  async reactToMessage(externalMessageId: string, contactId: string, emoji: string): Promise<void> {
    try {
      const known = EvolutionAdapter.lastInboundByContact.get(normalizeContact(contactId));
      const key: EvolutionMessageKey =
        known && known.id === externalMessageId
          ? known
          : { remoteJid: toJid(contactId), fromMe: false, id: externalMessageId };

      this.lastResult = await sendReaction(this.creds, key, emoji);
      this.log('reactToMessage', contactId);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, externalMessageId, contactId, emoji },
        '[evolution] reactToMessage falhou (segue — reação local já persistida)'
      );
    }
  }
}

/** Chave do cache: dígitos puros, para o mesmo contato não virar duas entradas. */
function normalizeContact(contactId: string): string {
  return contactId.replace(/@.*$/, '').replace(/\D/g, '');
}

function toJid(contactId: string): string {
  if (contactId.includes('@')) return contactId;
  return `${normalizeContact(contactId)}@s.whatsapp.net`;
}

export function createEvolutionAdapter(creds: EvolutionCredentials): EvolutionAdapter {
  return new EvolutionAdapter(creds);
}
