/**
 * GET  /api/connections — lista as conexões WhatsApp, com stats agregadas.
 * POST /api/connections — provisiona nova instância WhatsApp via uazapi (admin/atendente).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db/client';
import { connections } from '@/lib/db/schema/connections';
import { whatsappInstances } from '@/lib/db/schema/whatsapp-instances';
import { messages } from '@/lib/db/schema/messages';
import { leads } from '@/lib/db/schema/leads';
import { eq, sql, gte } from 'drizzle-orm';
import { isStatusConnected, getStatus, UazapiError } from '@/modules/channels/whatsapp/client';
import { provisionWhatsAppInstance } from '@/modules/channels/service';
import {
  provisionEvolutionInstance,
  isEvolutionConfigured,
  EvolutionConfigError,
} from '@/modules/channels/whatsapp/evolution/provisioning';
import { decrypt } from '@/lib/encryption';
import { logger } from '@/lib/logger';
import { requireSession, requireAdmin } from '@/lib/auth-helpers';
import { escopoDono, filtroDono } from '@/lib/escopo-dono';
import { users } from '@/lib/db/schema/users';
import { alias } from 'drizzle-orm/pg-core';

/** `users` visto como "dono do número" — o admin precisa saber de quem é. */
const donos = alias(users, 'donos');

export interface ConnectionView {
  id: string;
  name: string | null;
  type: 'whatsapp';
  status: 'connected' | 'disconnected' | 'qr_pending' | 'pending' | 'error';
  phone: string | null;
  instanceId: string | null;
  lastSeenAt: Date | null;
  messagesToday: number;
  /** Status remoto via uazapi (se aplicável) */
  remoteConnected?: boolean;
}

export async function GET(req: NextRequest) {
  const guard = await requireSession(req);
  if ('response' in guard) return guard.response;

  // Cada BDR só enxerga o próprio número. O admin vê todos — é ele quem
  // acompanha o time. Ver `lib/escopo-dono.ts`.
  const dono = escopoDono(guard.user);
  const porDono = filtroDono(connections.ownerId, dono.ownerId);
  const q = db
    .select({
      id: connections.id,
      name: connections.displayName,
      type: connections.type,
      status: connections.status,
      phone: connections.phoneNumber,
      accessTokenEncrypted: connections.accessTokenEncrypted,
      externalId: connections.externalId,
      metadata: connections.metadata,
      ownerId: connections.ownerId,
      ownerName: donos.name,
    })
    .from(connections)
    .leftJoin(donos, eq(connections.ownerId, donos.id));
  const rows = await (porDono ? q.where(porDono) : q);

  // Stats: mensagens hoje
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const msgsToday = await db
    .select({
      connectionId: leads.connectionId,
      count: sql<number>`count(*)::int`,
    })
    .from(messages)
    .innerJoin(leads, eq(messages.leadId, leads.id))
    .where(gte(messages.timestamp, startOfDay))
    .groupBy(leads.connectionId);
  const msgCountByConn = new Map<string, number>();
  for (const m of msgsToday) {
    if (m.connectionId) msgCountByConn.set(m.connectionId, m.count);
  }

  // Lookup whatsapp_instances pra cada connection WhatsApp
  const instances = await db
    .select({
      connectionId: whatsappInstances.connectionId,
      instanceId: whatsappInstances.instanceId,
      lastSeenAt: whatsappInstances.lastSeenAt,
    })
    .from(whatsappInstances);
  const instByConn = new Map(instances.map(i => [i.connectionId, i]));

  // Status remoto da uazapi (best-effort, paralelo)
  const result: ConnectionView[] = await Promise.all(
    rows.map(async row => {
      const inst = instByConn.get(row.id);
      const view: ConnectionView = {
        id: row.id,
        name: row.name,
        type: 'whatsapp',
        status: row.status as ConnectionView['status'],
        phone: row.phone,
        instanceId: inst?.instanceId ?? null,
        lastSeenAt: inst?.lastSeenAt ?? null,
        messagesToday: msgCountByConn.get(row.id) ?? 0,
      };

      // Só a uazapi responde a esta consulta de status remoto.
      //
      // A Cloud API nunca respondeu (perguntar lá com o token da Meta devolve
      // erro), e a Evolution também não — mas a Evolution ENTROU nesta consulta
      // por não estar na exceção, e o resultado foi pior que um erro no log: a
      // chamada falhava, `remoteConnected` ficava falso e o bloco abaixo
      // SOBRESCREVIA o status para "disconnected". O cliente escaneava o QR, o
      // WhatsApp conectava, e a tela dizia "Desconectado" — com o telefone
      // certo do lado, porque o telefone vinha de outra fonte.
      //
      // Quem mantém o status das conexões Evolution atualizado é o polling de
      // `/api/connections/[id]/status`, que fala com o servidor certo.
      const provider = (row.metadata as { provider?: string } | null)?.provider;
      const temStatusRemotoNaUazapi = provider !== 'cloud-api' && provider !== 'evolution';

      if (temStatusRemotoNaUazapi && row.accessTokenEncrypted) {
        try {
          const token = decrypt(row.accessTokenEncrypted);
          const remote = await getStatus(token);
          view.remoteConnected = isStatusConnected(remote);
          // Se remote diz disconnected mas DB diz connected, atualiza pra refletir
          if (!view.remoteConnected && view.status === 'connected') {
            view.status = 'disconnected';
          }
        } catch (err) {
          logger.debug({ connectionId: row.id, err: err instanceof Error ? err.message : err }, '[connections] status remoto falhou');
        }
      }

      return view;
    })
  );

  return NextResponse.json({ connections: result });
}

export async function POST(req: NextRequest) {
  // CRIAR conexão é do admin. Ler e reconectar são operação de atendimento —
  // o atendente precisa poder ver se o número caiu e levantá-lo de novo, e por
  // isso o GET e o QR ficam em `requireSession`. Mas criar um número novo (e
  // apagar um existente, ver `[id]/route.ts`) mexe na infraestrutura de
  // atendimento de todo mundo.
  const guard = await requireAdmin(req);
  if ('response' in guard) return guard.response;

  let body: { displayName?: unknown; provider?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });
  }

  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';

  // Qual provedor. Sem `provider` no corpo continua sendo uazapi — é o que as
  // seis instalações existentes mandam, e nenhuma delas deve mudar de
  // comportamento por causa desta rota ter passado a aceitar escolha.
  const provider = body.provider === 'evolution' ? 'evolution' : 'uazapi';

  if (!displayName) {
    return NextResponse.json({ error: 'displayName obrigatório' }, { status: 400 });
  }
  if (displayName.length > 80) {
    return NextResponse.json({ error: 'displayName muito longo (máx 80)' }, { status: 400 });
  }

  if (provider === 'evolution') {
    if (!isEvolutionConfigured()) {
      return NextResponse.json(
        { error: 'EVOLUTION_URL / EVOLUTION_GLOBAL_API_KEY não configurados neste deploy' },
        { status: 500 }
      );
    }
    // A URL pública deste deploy é o que a Evolution vai chamar de volta. Sem
    // ela o webhook nasceria apontando para lugar nenhum e as mensagens
    // sumiriam em silêncio — por isso falha aqui, e não depois.
    const appBaseUrl = process.env.NEXTAUTH_URL || process.env.BETTER_AUTH_URL;
    if (!appBaseUrl) {
      return NextResponse.json(
        { error: 'NEXTAUTH_URL ausente — sem ela o webhook da Evolution não teria destino' },
        { status: 500 }
      );
    }

    try {
      const result = await provisionEvolutionInstance({
        displayName,
        appBaseUrl,
        ownerId: guard.user.id,
      });
      return NextResponse.json(result, { status: 201 });
    } catch (err) {
      logger.error(
        { err: err instanceof Error ? err.message : err },
        '[POST /api/connections] provisionEvolutionInstance falhou'
      );
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Erro ao provisionar instância Evolution' },
        { status: err instanceof EvolutionConfigError ? 500 : 502 }
      );
    }
  }

  if (!process.env.UAZAPI_ADMIN_TOKEN && !process.env.UAZAPI_TOKEN) {
    return NextResponse.json(
      { error: 'UAZAPI_ADMIN_TOKEN não configurado no servidor' },
      { status: 500 }
    );
  }

  try {
    const result = await provisionWhatsAppInstance({ displayName, ownerId: guard.user.id });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      '[POST /api/connections] provisionWhatsAppInstance falhou'
    );
    if (err instanceof UazapiError) {
      return NextResponse.json(
        { error: `uazapi: ${err.message}`, transient: err.isTransient() },
        { status: err.isTransient() ? 502 : 400 }
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro ao provisionar instância' },
      { status: 500 }
    );
  }
}
