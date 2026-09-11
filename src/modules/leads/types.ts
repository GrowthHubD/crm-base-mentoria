export type LeadStatus = 'new' | 'priority' | 'urgency' | 'attending' | 'converted' | 'lost';

/**
 * Canal de CONVERSA — por onde as mensagens realmente trafegam.
 *
 * `email` entrou aqui, e não só como origem, porque é conversa de verdade: o
 * composer do chat manda por e-mail e a resposta do cliente volta para o mesmo
 * histórico. Instagram continua de fora — não existe adapter de conversa por IG.
 *
 * `manual` é o lead cadastrado à mão no painel.
 */
export type LeadChannel = 'whatsapp' | 'email' | 'manual';

/**
 * Canal de ORIGEM — de onde o lead veio comercialmente. Um lead que clicou num
 * anúncio no Instagram e chamou no WhatsApp tem `channel: 'whatsapp'` e
 * `attributedChannel: 'instagram'`. É isso que o dashboard de canais mede, e é
 * por isso que Instagram e Google seguem aqui.
 */
export type LeadAttributedChannel = 'whatsapp' | 'instagram' | 'google' | 'email' | 'manual';

export interface Lead {
  id: string;
  externalContactId: string;
  channel: LeadChannel;
  connectionId?: string | null;
  name?: string | null;
  phone?: string | null;
  /** Endereço do contato — para lead de canal `email` é o próprio identificador
   *  da conversa, e a tela o mostra onde o WhatsApp mostraria o telefone. */
  email?: string | null;
  avatarUrl?: string | null;
  /** Anotações internas — ver comentário no schema. Não vai pro cliente. */
  notes?: string | null;
  status: LeadStatus;
  assignedToId?: string | null;
  attributedChannel?: LeadAttributedChannel | null;
  escalationLevel: number;
  lastMessageAt?: Date | null;
  /** Última msg do CLIENTE (direction=inbound). Alimenta o relógio de espera. */
  lastInboundAt?: Date | null;
  /** Última msg NOSSA (humana ou IA). Quando > lastInboundAt, timer some. */
  lastOutboundAt?: Date | null;
  lastEscalationAt?: Date | null;
  aiAgentActive: boolean;
  /** Camada extra de bloqueio da IA, independente de aiAgentActive. Setada
   *  pra now+24h em conversão. Atendente humano responde nessa janela. */
  aiBlockedUntil?: Date | null;
  /** Pausa RENOVÁVEL: cada mensagem do atendente humano seta now +
   *  cfg.aiPauseMinutesAfterHuman. Triggers de cancelamento usam
   *  cfg.aiPauseMinutesAfterCancellation. IA não responde nem follow-up
   *  enquanto > now. Null = sem pausa ativa. */
  aiPausedUntil?: Date | null;
  /** Setado quando o atendente clica "Resolvido" no LeadModal. Enquanto
   *  preenchido, follow-ups NÃO disparam. Limpa quando o lead manda nova
   *  msg inbound (volta a engajar). Null = ciclo normal. */
  resolvedAt?: Date | null;
  metadata?: Record<string, unknown> | null;
  convertedAt?: Date | null;
  /** Quem clicou em "Converti!". Null = automática (IA ou Asaas). */
  convertedById?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLeadInput {
  externalContactId: string;
  channel: LeadChannel;
  connectionId?: string;
  /** Filial. Herdada da conexão por onde a mensagem entrou — o número de
   *  WhatsApp pertence a uma filial, então quem escreveu para ele é lead dela. */
  unitId?: string | null;
  name?: string;
  phone?: string;
  email?: string;
  avatarUrl?: string;
  notes?: string | null;
  /** Destino explícito usado pelo cadastro manual. Ausente preserva os
   *  defaults da entrada automática por webhook. */
  status?: LeadStatus;
  stageId?: string | null;
  assignedToId?: string | null;
  attributedChannel?: LeadAttributedChannel | null;
  /** Default false. Webhook inbound passa true quando a unidade tem IA ativa. */
  aiAgentActive?: boolean;
  /**
   * BDR dono deste lead. Quando não vem, é RESOLVIDO a partir da conexão —
   * ver `createLead`. Só os caminhos que não têm conexão (e-mail, cadastro
   * manual) precisam informar.
   */
  ownerId?: string | null;
}

export interface UpdateLeadInput {
  name?: string;
  phone?: string;
  avatarUrl?: string;
  /** Anotações internas do time. String vazia limpa; undefined não mexe. */
  notes?: string | null;
  status?: LeadStatus;
  /**
   * Coluna personalizada do kanban. `null` devolve o card à coluna de fábrica
   * do status; `undefined` não mexe.
   *
   * Anda junto do `status`, nunca no lugar dele: mover um card para "Proposta
   * enviada" grava o `stageId` E o status âncora daquela coluna, para a regra
   * (escalação, SLA, relatório) continuar valendo sobre um estado conhecido.
   */
  stageId?: string | null;
  assignedToId?: string | null;
  aiAgentActive?: boolean;
  metadata?: Record<string, unknown>;
  /** null pra remover atribuição. Undefined = não muda. */
  attributedChannel?: LeadAttributedChannel | null;
  /** Setado pela rota PATCH quando atendente humano marca como converted.
   *  null = conversão automática (IA tool ou webhook Asaas). */
  convertedById?: string | null;
  /** Pausa renovável. Passar Date pra setar, null pra limpar. */
  aiPausedUntil?: Date | null;
  /** "Resolvido" manual. Passar Date pra marcar, null pra limpar (ex: inbound novo). */
  resolvedAt?: Date | null;
}
