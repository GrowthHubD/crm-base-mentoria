/**
 * GET /api/health — liveness do deploy.
 *
 * Existe para responder UMA pergunta depois de um deploy: o Worker subiu e
 * alcança o banco? Sem isto, um deploy quebrado só aparece quando alguém tenta
 * logar e vê a tela girar.
 *
 * Não exige autenticação e por isso NÃO expõe configuração: só um booleano de
 * conectividade e a latência. Nenhum nome de host, nenhuma variável, nenhuma
 * contagem de registros — endpoint público é superfície de reconhecimento.
 */
import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, DB_SCHEMA } from '@/lib/db/client';
import { APP_NAME } from '@/lib/branding';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const startedAt = Date.now();

  let database = false;
  try {
    await db.execute(sql`select 1`);
    database = true;
  } catch {
    // Silencioso de propósito: a mensagem do driver carrega host e usuário.
    database = false;
  }

  const body: Record<string, unknown> = {
    app: APP_NAME,
    status: database ? 'ok' : 'degraded',
    database,
    latencyMs: Date.now() - startedAt,
  };

  // Diagnóstico de schema — atrás do CRON_SECRET, porque nome de schema é
  // informação de infraestrutura e este endpoint é público.
  //
  // Existe porque a falha que ele detecta é traiçoeira: se o `search_path` não
  // chegar ao banco, a instância de um cliente lê o schema de OUTRO sem dar
  // erro nenhum — health ok, login "funcionando", dados errados.
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('x-cron-secret') === secret) {
    body.schemaEsperado = DB_SCHEMA;
    try {
      const r = (await db.execute(sql`show search_path`)) as unknown as Array<{ search_path: string }>;
      body.searchPathReal = r[0]?.search_path ?? null;
      const t = (await db.execute(sql`select current_schema() as s`)) as unknown as Array<{ s: string }>;
      body.schemaEmUso = t[0]?.s ?? null;
    } catch {
      body.searchPathReal = 'erro ao consultar';
    }
  }

  return NextResponse.json(body, { status: database ? 200 : 503 });
}
