/**
 * Cola entre a Evolution API e o resto do CRM: como uma connection Evolution é
 * reconhecida, onde ficam suas credenciais e como sua mídia é baixada.
 *
 * Convenção de armazenamento (não exige migration — cabe no que já existe):
 *   connections.external_id             = instanceName na Evolution
 *   connections.access_token_encrypted  = apikey DA INSTÂNCIA
 *   connections.phone_number            = telefone legível (display)
 *   connections.metadata.provider       = 'evolution'
 *   connections.metadata.baseUrl        = servidor Evolution deste cliente
 *   connections.metadata.webhookToken   = segredo que o webhook precisa apresentar
 *
 * Duas escolhas que valem registrar:
 *
 * - **`baseUrl` no metadata, não em env.** A uazapi tem endpoint global e a
 *   Cloud API é a Meta; os dois cabem numa variável de ambiente. A Evolution é
 *   self-hosted: cada cliente aponta para o servidor dele. Em env, o segundo
 *   cliente com Evolution própria já não caberia.
 *
 * - **A key da instância, nunca a global.** A global cria e APAGA qualquer
 *   instância do servidor e lê o histórico de todas. A da instância só opera
 *   aquele número. Se o banco de um cliente vazar, vaza o acesso a um número —
 *   não ao servidor inteiro. A global só aparece uma vez, no `/instance/create`
 *   do onboarding, e não é persistida em lugar nenhum.
 */
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { eq } from 'drizzle-orm';
import { decrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { resolveMediaBlob, type MediaBlob } from '../media';
import type { ParsedInbound } from '../webhook-parser';
import { isUsableMediaUrl } from '../webhook-parser';
import {
  getBase64FromMediaMessage,
  type EvolutionCredentials,
  type EvolutionMessageKey,
} from './client';

export const EVOLUTION_PROVIDER = 'evolution';

export interface EvolutionConnection {
  id: string;
  status: string;
  credentials: EvolutionCredentials;
  /** Segredo esperado no header do webhook. `null` = connection antiga, sem token. */
  webhookToken: string | null;
}

interface EvolutionMetadata {
  provider?: string;
  baseUrl?: string;
  webhookToken?: string;
}

export function isEvolution(metadata: unknown): boolean {
  return (metadata as EvolutionMetadata | null)?.provider === EVOLUTION_PROVIDER;
}

/**
 * Monta a connection a partir da linha do banco. Devolve `null` — em vez de
 * lançar — quando falta peça essencial, porque todo caller já trata ausência
 * como "não é uma connection Evolution válida" e segue para o próximo palpite.
 */
function hydrate(row: typeof connections.$inferSelect): EvolutionConnection | null {
  if (!isEvolution(row.metadata) || !row.accessTokenEncrypted) return null;

  const meta = (row.metadata ?? {}) as EvolutionMetadata;
  if (!meta.baseUrl) {
    logger.error(
      { connectionId: row.id },
      '[evolution] connection sem metadata.baseUrl — não há servidor para chamar'
    );
    return null;
  }

  try {
    return {
      id: row.id,
      status: row.status,
      credentials: {
        baseUrl: meta.baseUrl,
        instanceName: row.externalId,
        apiKey: decrypt(row.accessTokenEncrypted),
      },
      webhookToken: meta.webhookToken ?? null,
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, connectionId: row.id },
      '[evolution] decrypt da key da instância falhou'
    );
    return null;
  }
}

/** Connection pelo id interno (usado pela rota por-conexão). */
export async function getEvolutionConnection(
  connectionId: string
): Promise<EvolutionConnection | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  return row ? hydrate(row) : null;
}

/**
 * Connection pelo `instance` que veio no corpo do webhook. É a rede de
 * segurança para webhook apontado à URL errada — mesmo papel que o
 * `findCloudConnectionByPhoneNumberId` cumpre no canal oficial.
 */
export async function findEvolutionConnectionByInstance(
  instanceName: string
): Promise<EvolutionConnection | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.externalId, instanceName))
    .limit(1);

  return row ? hydrate(row) : null;
}

/**
 * Traduz o estado da Evolution para o status da connection no CRM.
 * `open` é o único que significa "número conectado e operando".
 */
export function mapConnectionState(state: string | null | undefined):
  'connected' | 'qr_pending' | 'disconnected' {
  switch ((state ?? '').toLowerCase()) {
    case 'open':
      return 'connected';
    case 'connecting':
      return 'qr_pending';
    default:
      return 'disconnected';
  }
}

/**
 * Resolve o binário da mídia — de TODOS os casos, não só do caso raro.
 *
 * Isto é importante e não é óbvio: quem chama escolhe entre este resolver e o
 * genérico, nunca os dois (`opts.resolveMedia ? custom(...) : generico(...)`).
 * Um resolver que devolve `null` esperando o genérico assumir simplesmente
 * perde a mídia. Por isso aqui:
 *
 *   1. com base64 inline ou URL utilizável → delega ao `resolveMediaBlob`;
 *   2. sem nenhum dos dois → pede o binário ao servidor Evolution, que ainda
 *      tem a sessão do Baileys para descriptografar a URL `.enc` que o
 *      WhatsApp manda e que o `media.ts` recusa de propósito.
 *
 * `null` significa "não consegui" de verdade. O ingest grava a mensagem mesmo
 * assim, para o atendente ver que algo chegou, e o motivo fica no log.
 */
export function makeEvolutionMediaResolver(
  creds: EvolutionCredentials
): (parsed: ParsedInbound) => Promise<MediaBlob | null> {
  return async (parsed) => {
    // Quando há base64 inline ou URL utilizável, DELEGA ao resolvedor genérico
    // em vez de devolver `null`.
    //
    // Devolver `null` aqui parecia certo — "o genérico dá conta" — e não dava:
    // quem chama faz `opts.resolveMedia ? await opts.resolveMedia(...) : generico(...)`,
    // ou seja, é um OU outro. Com o resolver presente, o genérico nunca roda, e
    // `null` virava "não consegui a mídia". Toda imagem que chegava inline —
    // que é o caso comum, porque o webhook é criado com `base64: true` — era
    // descartada, e a conversa mostrava "Mídia indisponível".
    if (parsed.mediaBase64 || isUsableMediaUrl(parsed.mediaUrl)) {
      return resolveMediaBlob(parsed, creds.apiKey);
    }

    if (!parsed.externalId || !parsed.contactJid) return null;

    const key: EvolutionMessageKey = {
      remoteJid: parsed.contactJid,
      fromMe: parsed.fromMe,
      id: parsed.externalId,
    };

    const media = await getBase64FromMediaMessage(creds, key);
    if (!media) return null;

    try {
      const buffer = Buffer.from(media.base64, 'base64');
      return {
        buffer,
        mimeType: media.mimetype ?? parsed.mimeType ?? 'application/octet-stream',
        size: buffer.length,
        // `url` é a origem genérica do contrato de MediaBlob que melhor
        // descreve "veio de uma segunda chamada ao provedor".
        source: 'url',
      };
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, messageId: parsed.externalId },
        '[evolution] base64 devolvido pelo servidor é inválido'
      );
      return null;
    }
  };
}
