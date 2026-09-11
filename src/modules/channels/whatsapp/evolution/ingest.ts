/**
 * Processamento de um lote de eventos já parseados da Evolution.
 *
 * Vive fora da rota pelo mesmo motivo do canal oficial: tem dois chamadores —
 * o webhook (caminho feliz) e o sweeper de recuperação. Duas cópias divergindo
 * significaria que a recuperação faz algo diferente do processamento normal,
 * exatamente onde ninguém olha.
 *
 * Reprocessar é seguro: `messages.external_id` é UNIQUE, então reinserir a
 * mesma mensagem é no-op.
 */
import { logger } from '@/lib/logger';
import { ingestParsedInbound } from '@/modules/channels/whatsapp/process-inbound';
import {
  getEvolutionConnection,
  findEvolutionConnectionByInstance,
  makeEvolutionMediaResolver,
  mapConnectionState,
} from './provider';
import { EvolutionAdapter } from './adapter';
import type { EvolutionParsedBatch } from './webhook-parser';
import { updateExternalStatus, markFailed, reads as messageReads } from '@/modules/messages/service';

export async function handleEvolutionEvents(
  connectionId: string,
  parsed: EvolutionParsedBatch
): Promise<void> {
  // A connection do path é a fonte primária; o `instance` do payload é a rede
  // de segurança para quando o webhook cadastrado aponta para o lugar errado.
  const connection =
    (await getEvolutionConnection(connectionId)) ??
    (parsed.instanceName ? await findEvolutionConnectionByInstance(parsed.instanceName) : null);

  if (!connection) {
    // LANÇAR, e não retornar. A connection pode passar a existir DEPOIS — é o
    // que acontece quando o número é conectado antes do cadastro terminar.
    // Sair normalmente faria o chamador rodar `markDone`, e a mensagem do
    // cliente nunca entraria: silencioso dos dois lados (a Evolution viu 200,
    // o CRM diz "processado", o lead sumiu). Lançando, o evento vai para
    // retentativa e depois para `failed`, que é visível e reprocessável a
    // partir do payload cru.
    const detalhe = `nenhuma connection evolution corresponde (connectionId=${connectionId}, instance=${parsed.instanceName ?? 'ausente'})`;
    logger.error({ connectionId, instance: parsed.instanceName }, `[evolution] ${detalhe}`);
    throw new Error(detalhe);
  }

  // Estado da conexão (número caiu, número voltou). Informativo: falhar aqui
  // não pode reter o lote.
  if (parsed.connectionState) {
    logger.info(
      {
        connectionId: connection.id,
        state: parsed.connectionState,
        mapeado: mapConnectionState(parsed.connectionState),
      },
      '[evolution] connection.update recebido'
    );
  }

  // Status das mensagens que saíram daqui. Falha aqui não retém o lote: status
  // é informação derivada, e perdê-lo atrasa um ✓✓ na tela, não uma mensagem.
  for (const status of parsed.statuses) {
    try {
      if (status.status === 'failed') {
        const msg = await messageReads.byExternalId(status.externalId);
        if (msg) await markFailed(msg.id, status.error ?? 'falha reportada pela Evolution');
        else
          logger.debug(
            { externalId: status.externalId },
            '[evolution] falha de mensagem desconhecida'
          );
      } else {
        await updateExternalStatus(status.externalId, status.status);
      }
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, externalId: status.externalId },
        '[evolution] atualização de status falhou'
      );
    }
  }

  if (parsed.messages.length === 0) return;

  const resolveMedia = makeEvolutionMediaResolver(connection.credentials);
  const failures: string[] = [];

  for (const message of parsed.messages) {
    try {
      // Guarda a key da última inbound para viabilizar o `markAsRead` — o
      // WhatsApp marca leitura por mensagem, e o contrato do adapter só
      // entrega o contato.
      if (message.externalId && message.contactJid && !message.fromMe) {
        EvolutionAdapter.rememberLastInbound(message.contactPhone, {
          remoteJid: message.contactJid,
          fromMe: false,
          id: message.externalId,
        });
      }

      await ingestParsedInbound(message, {
        connectionIdOverride: connection.id,
        resolveMedia,
      });
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      failures.push(`${message.externalId ?? 'sem-id'}: ${motivo}`);
      logger.error(
        { err: motivo, externalId: message.externalId, connectionId: connection.id },
        '[evolution] falha ao processar mensagem do lote'
      );
    }
  }

  // Uma mensagem que falhou não pode sair daqui como sucesso: o evento
  // precisa ir para retentativa. Lançamos DEPOIS de tentar todas, para que uma
  // mensagem problemática não impeça as outras de entrar.
  if (failures.length > 0) {
    throw new Error(`${failures.length} mensagem(ns) falharam: ${failures.join(' | ')}`);
  }
}
