/**
 * Backup do banco para o R2, em NDJSON.
 *
 * Por que existe: o plano free do Supabase **não tem backup nenhum** — nem
 * snapshot diário, nem point-in-time. E o que está no banco é conversa de
 * WhatsApp de clientes de terceiros: o dado que mais dói perder e o que mais
 * pesa em LGPD. Sem isto, um acidente é perda total e definitiva.
 *
 * O que isto é: uma exportação diária das tabelas que importam, gravada no R2
 * (que já está ligado e tem 10 GB livres), numa pasta por cliente. Não é PITR —
 * transforma "perdi tudo" em "perdi no máximo um dia", e essa diferença é o
 * negócio existir ou não.
 *
 * NDJSON (uma linha JSON por registro) e não um JSON gigante: dá pra streamar,
 * inspecionar com `grep` e restaurar parcialmente sem carregar o arquivo todo
 * na memória — que é justamente o que falta num Worker.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { logger } from '@/lib/logger';

/**
 * Tabelas exportadas, em ordem de dependência (pais antes de filhos) — a ordem
 * do arquivo é a ordem de restauração.
 *
 * `users` fica de fora de propósito: contém hash de senha e sessão. Restaurar
 * usuário é recriar pelo seed; guardar credencial num bucket é aumentar a
 * superfície sem ganho.
 */
const TABLES = [
  'connections',
  'leads',
  'messages',
  'scheduled_messages',
  'followups',
  'attendant_close_log',
  'ai_agent_config',
  'pipeline_config',
  'quick_replies',
  'automations',
  'automation_steps',
] as const;

export interface BackupResult {
  key: string;
  tables: Record<string, number>;
  bytes: number;
  skipped: string[];
}

interface R2Bucket {
  put(key: string, value: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');

function getBucket(): R2Bucket | null {
  const ctx = (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT] as
    | { env?: { MEDIA?: R2Bucket } }
    | undefined;
  return ctx?.env?.MEDIA ?? null;
}

/**
 * Pasta do cliente dentro do bucket.
 *
 * Todos os deploys compartilham o MESMO bucket R2 (`aixo-crm-media`). Enquanto
 * a chave era só `backups/<timestamp>.ndjson`, os clientes escreviam na mesma
 * pasta com nome derivado só da hora — e como todo cron dispara no mesmo
 * minuto, dois backups no mesmo segundo faziam o segundo `put` sobrescrever o
 * primeiro, sem erro nenhum. O cliente sobrescrito ficava sem backup e o log
 * dizia que tinha dado certo.
 *
 * Mesmo sem colisão, um bucket com arquivos de sete clientes indistinguíveis
 * entre si só se descobre inútil na hora de restaurar — a única hora em que
 * isso importa.
 *
 * `DB_SCHEMA` é `cliente_<slug>` e já existe no `vars` de cada env.
 */
export function defaultPrefix(): string {
  const schema = process.env.DB_SCHEMA?.trim();
  return schema ? `backups/${schema}` : 'backups';
}

/**
 * Exporta tudo e grava no R2. Devolve o que foi salvo pra o chamador logar.
 *
 * Tabela que não existe é PULADA, não fatal: instalações diferentes estão em
 * pontos diferentes das migrations, e um backup que falha inteiro porque uma
 * tabela nova ainda não chegou é um backup que não acontece.
 */
export async function runBackup(prefix = defaultPrefix()): Promise<BackupResult> {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const parts: string[] = [];
  const counts: Record<string, number> = {};
  const skipped: string[] = [];

  for (const table of TABLES) {
    try {
      const rows = (await db.execute(sql.raw(`select * from "${table}"`))) as unknown as Record<string, unknown>[];
      counts[table] = rows.length;
      for (const row of rows) {
        parts.push(JSON.stringify({ __table: table, ...row }));
      }
    } catch (err) {
      skipped.push(table);
      logger.warn(
        { table, err: err instanceof Error ? err.message : err },
        '[backup] tabela pulada'
      );
    }
  }

  const body = parts.join('\n');
  const key = `${prefix}/${stamp}.ndjson`;

  const bucket = getBucket();
  if (!bucket) {
    // Fora do Worker (dev/script): não há binding. Devolve o resultado sem
    // gravar pra o chamador decidir o que fazer.
    logger.warn('[backup] sem binding do R2 — exportação não foi gravada');
    return { key, tables: counts, bytes: body.length, skipped };
  }

  await bucket.put(key, body, { httpMetadata: { contentType: 'application/x-ndjson' } });
  logger.info({ key, tables: counts, bytes: body.length, skipped }, '[backup] gravado no R2');
  return { key, tables: counts, bytes: body.length, skipped };
}
