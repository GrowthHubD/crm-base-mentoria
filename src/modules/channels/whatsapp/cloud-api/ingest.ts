/**
 * Processamento de um lote de eventos já parseados da Cloud API.
 *
 * Vive fora da rota porque tem dois chamadores: o webhook (caminho feliz,
 * logo após gravar o evento) e o sweeper do `/api/cron/tick` (recuperação).
 * Duas cópias divergindo significaria que a recuperação faz algo diferente do
 * processamento normal — exatamente onde ninguém olha.
 *
 * Reprocessar é seguro: `messages.external_id` é UNIQUE, então reinserir a
 * mesma mensagem é no-op. É essa idempotência que permite falhar e retentar
 * o lote inteiro em vez de tentar adivinhar o que já entrou.
 */
import { logger } from '@/lib/logger';
import { ingestParsedInbound } from '@/modules/channels/whatsapp/process-inbound';
import type { parseMetaWebhook } from './webhook-parser';
import { getCloudConnection, findCloudConnectionByPhoneNumberId } from './provider';
import { makeCloudMediaResolver } from './provider';
import { CloudApiAdapter } from './adapter';
import { updateExternalStatus, markFailed, reads as messageReads } from '@/modules/messages/service';

type ParsedBatch = ReturnType<typeof parseMetaWebhook>;

export async function handleCloudEvents(connectionId: string, parsed: ParsedBatch): Promise<void> {
  // A connection do path é a fonte primária; o phone_number_id do payload é a
  // rede de segurança quando a URL cadastrada na Meta aponta pro lugar errado.
  const connection =
    (await getCloudConnection(connectionId)) ??
    (parsed.phoneNumberId ? await findCloudConnectionByPhoneNumberId(parsed.phoneNumberId) : null);

  if (!connection) {
    // LANÇAR, e não retornar. A versão anterior retornava normalmente aqui,
    // com a justificativa de que "retentar dá no mesmo" — e essa premissa é
    // falsa: a connection pode passar a existir DEPOIS. Foi o que aconteceu.
    //
    // Sair normalmente faz o chamador rodar `markDone`, então o evento fica
    // gravado como concluído e a mensagem do cliente nunca entra. Silencioso
    // dos dois lados: a Meta viu 200, o CRM diz "processado", e o lead sumiu.
    // Em produção isso comeu 6 mensagens de 2 pessoas enquanto a connection
    // ainda não estava vinculada — exatamente na janela de estreia da
    // campanha, que é quando cada lead vale mais.
    //
    // Lançando, o evento vai para retentativa e depois para `failed`, que é
    // visível e reprocessável a partir do payload cru guardado. Uma mensagem
    // que a gente ainda não sabe rotear é um problema a resolver, não um
    // evento a descartar.
    const detalhe = `nenhuma connection cloud-api corresponde (connectionId=${connectionId}, phoneNumberId=${parsed.phoneNumberId ?? 'ausente'})`;
    logger.error({ connectionId, phoneNumberId: parsed.phoneNumberId }, `[cloud-api] ${detalhe}`);
    throw new Error(detalhe);
  }

  // Status das mensagens que saíram daqui: sent → delivered → read, ou failed.
  // Falha aqui não retém o lote: status é informação derivada, e perdê-lo
  // atrasa um ✓✓ na tela, não uma mensagem de cliente.
  for (const status of parsed.statuses) {
    try {
      if (status.status === 'failed') {
        const msg = await messageReads.byExternalId(status.externalId);
        if (msg) await markFailed(msg.id, status.error ?? 'falha reportada pela Meta');
        else logger.debug({ externalId: status.externalId }, '[cloud-api] falha de mensagem desconhecida');
      } else {
        await updateExternalStatus(status.externalId, status.status);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, externalId: status.externalId },
        '[cloud-api] atualização de status falhou'
      );
    }
  }

  if (parsed.messages.length === 0) return;

  const resolveMedia = makeCloudMediaResolver(connection.credentials);
  const failures: string[] = [];

  for (const message of parsed.messages) {
    try {
      // Guarda o wamid pra viabilizar o "marcar como lida" (a Meta exige o id
      // da mensagem, e o contrato do adapter só entrega o contato).
      if (message.externalId) {
        CloudApiAdapter.rememberLastInbound(message.contactPhone, message.externalId);
      }

      const result = await ingestParsedInbound(message, {
        connectionIdOverride: connection.id,
        resolveMedia,
      });

      logger.info(
        { connectionId: connection.id, externalId: message.externalId, ...result },
        '[cloud-api] mensagem processada'
      );
    } catch (err) {
      // Uma mensagem problemática não leva as outras junto — mas TAMBÉM não
      // pode ser esquecida. Antes, o catch aqui engolia o erro e o lote era
      // dado como concluído: o evento ficava salvo, a mensagem não entrava, e
      // ninguém ficava sabendo. Acumulamos e lançamos no fim, o que devolve o
      // lote pra fila de retentativa.
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${message.externalId ?? 'sem-id'}: ${msg}`);
      logger.error(
        { err: msg, externalId: message.externalId },
        '[cloud-api] falha ao processar mensagem'
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} mensagem(ns) falharam: ${failures.join(' | ')}`);
  }
}
