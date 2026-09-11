/**
 * Cola entre a Cloud API e o resto do CRM: como uma connection oficial é
 * reconhecida, onde ficam suas credenciais e como sua mídia é baixada.
 *
 * Convenção de armazenamento (não exige migration — cabe no que já existe):
 *   connections.external_id             = phone_number_id da Meta
 *   connections.access_token_encrypted  = token permanente do System User
 *   connections.phone_number            = telefone legível (display)
 *   connections.metadata.provider       = 'cloud-api'
 *   connections.metadata.wabaId         = id da WABA (referência)
 *
 * A ausência de `metadata.provider` significa uazapi — era o único canal antes
 * de existir escolha, e nenhuma connection antiga precisa ser tocada.
 */
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { eq } from 'drizzle-orm';
import { decrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import type { MediaBlob } from '../media';
import type { ParsedInbound } from '../webhook-parser';
import { getMediaUrl, downloadMedia, type CloudApiCredentials } from './client';

export const CLOUD_API_PROVIDER = 'cloud-api';

export interface CloudConnection {
  id: string;
  status: string;
  credentials: CloudApiCredentials;
}

function isCloud(metadata: unknown): boolean {
  return (metadata as { provider?: string } | null)?.provider === CLOUD_API_PROVIDER;
}

/** Connection oficial pelo id interno (usado pela rota por-conexão). */
export async function getCloudConnection(connectionId: string): Promise<CloudConnection | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  if (!row || !isCloud(row.metadata) || !row.accessTokenEncrypted) return null;

  try {
    return {
      id: row.id,
      status: row.status,
      credentials: {
        phoneNumberId: row.externalId,
        accessToken: decrypt(row.accessTokenEncrypted),
      },
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, connectionId },
      '[cloud-api] decrypt do token falhou'
    );
    return null;
  }
}

/**
 * Connection oficial pelo `phone_number_id` que veio no webhook. É a defesa
 * contra webhook apontado para a URL errada: a Meta diz qual número recebeu, e
 * conferimos contra o que está cadastrado.
 */
export async function findCloudConnectionByPhoneNumberId(
  phoneNumberId: string
): Promise<CloudConnection | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.externalId, phoneNumberId))
    .limit(1);

  if (!row || !isCloud(row.metadata) || !row.accessTokenEncrypted) return null;

  try {
    return {
      id: row.id,
      status: row.status,
      credentials: {
        phoneNumberId: row.externalId,
        accessToken: decrypt(row.accessTokenEncrypted),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Baixa a mídia de uma mensagem recebida pelo canal oficial.
 *
 * São duas chamadas autenticadas: o webhook traz só o `media_id`, a URL é
 * temporária (~5 min) e o download exige o mesmo Bearer. Devolve `null` em
 * qualquer falha — o ingest grava a mensagem mesmo assim, para o atendente ver
 * que algo chegou, e loga o motivo.
 */
export function makeCloudMediaResolver(
  creds: CloudApiCredentials
): (parsed: ParsedInbound) => Promise<MediaBlob | null> {
  return async (parsed) => {
    const mediaId = parsed.providerMediaId;
    if (!mediaId) return null;

    const media = await getMediaUrl(creds, mediaId);
    if (!media) return null;

    const downloaded = await downloadMedia(creds, media.url);
    if (!downloaded) return null;

    return {
      buffer: downloaded.buffer,
      mimeType: media.mimeType ?? downloaded.mimeType,
      size: downloaded.buffer.length,
      source: 'cloud-api',
    };
  };
}
