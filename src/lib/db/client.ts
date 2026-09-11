/**
 * Drizzle client — driver postgres-js.
 *
 * Duas realidades muito diferentes rodam este mesmo arquivo:
 *
 *   Node (npm run dev, workers BullMQ, scripts, testes)
 *     Processo longo. Conecta direto no Postgres pela `DATABASE_URL` e mantém
 *     um pool único no módulo.
 *
 *   Cloudflare Worker (produção)
 *     NÃO conecta direto: a conexão TCP até o Postgres pendura e a requisição
 *     morre por timeout. Quem termina a conexão na borda e faz o pooling é o
 *     **Hyperdrive**, exposto como binding.
 *
 * `DATABASE_URL` (modo Node) aceita qualquer um dos três modos do Supabase, e o
 * client se adapta sozinho — cola-se a string como o painel entrega:
 *
 *   Direct connection ....... porta 5432, host `db.<ref>.supabase.co`
 *                             Ideal para processo persistente (`npm run dev`).
 *                             ATENÇÃO: é IPv6-only. Em rede IPv4 não conecta —
 *                             use o Session pooler.
 *   Session pooler .......... porta 5432, host `...pooler.supabase.com`
 *                             Equivalente IPv4 do direct. Mesma semântica.
 *   Transaction pooler ...... porta 6543, host `...pooler.supabase.com`
 *                             NÃO suporta prepared statements — ver abaixo.
 *
 * Histórico: antes era `@neondatabase/serverless` (HTTP) no Neon. Migrado pra
 * postgres-js+Supabase em 2026-05-26 depois que o free do Neon estourou a quota
 * de compute hours.
 */
import postgres from 'postgres';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

type Database = PostgresJsDatabase<typeof schema>;

/**
 * Schema do Postgres desta instalação. Default `public`.
 *
 * É o que permite vários clientes dividirem UM projeto Supabase sem misturar
 * dado: cada instância aponta pro seu schema e as tabelas têm os mesmos nomes
 * dentro dele. Isolamento real — uma query jamais atravessa a fronteira,
 * porque o `search_path` não enxerga o schema do vizinho.
 *
 * Escolhido em vez de uma coluna `tenant_id` nas tabelas justamente pela
 * migração: promover um cliente que cresceu para banco próprio é um dump de um
 * schema. Com linhas misturadas seria cirurgia de dados, com risco de vazar
 * entre clientes.
 *
 * `public` fica no fim do caminho por causa das extensões, que vivem lá.
 */
export const DB_SCHEMA = process.env.DB_SCHEMA?.trim() || 'public';
const SEARCH_PATH = DB_SCHEMA === 'public' ? 'public' : `${DB_SCHEMA}, public`;

/**
 * O OpenNext publica o contexto do Worker neste símbolo global — tanto no
 * worker de produção quanto no `next dev`. Ler o global em vez de importar
 * `@opennextjs/cloudflare` é deliberado: este módulo também roda em processos
 * Node puros (workers BullMQ, `tsx scripts/...`, vitest), onde o pacote não
 * tem contexto e o import só adicionaria uma forma nova de quebrar.
 */
const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');

interface WorkerContext {
  env?: { HYPERDRIVE?: { connectionString?: string } };
  ctx?: { waitUntil?: (p: Promise<unknown>) => void };
}

function readWorkerContext(): WorkerContext | undefined {
  return (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT] as WorkerContext | undefined;
}

/**
 * Erro em que vale reabrir a conexão e perguntar de novo.
 *
 * Só um caso, e bem estreito: o Hyperdrive fechou o socket e o driver ainda não
 * sabia, então falhou AO ESCREVER a consulta. Foi o que o log mostrou depois de
 * `describeDbError` — `write CONNECTION_CLOSED <id>.hyperdrive.local:5432` —
 * e era a fonte do 500 intermitente que o cliente via a cada poucos minutos.
 *
 * A exigência de ter falhado no `write` é o que torna a repetição segura, e não
 * é detalhe: significa que a consulta NUNCA CHEGOU no servidor. Nada foi lido
 * pela metade, nada foi gravado. Se a conexão tivesse caído depois do envio, ao
 * ler a resposta, repetir um INSERT poderia duplicar — por isso esse caso fica
 * de fora e continua estourando.
 *
 * Qualquer outro erro passa direto. Repetir erro de verdade — dado inválido,
 * tabela faltando — só transformaria uma falha explícita em mais um fantasma
 * intermitente, que é exatamente o problema que este código existe para acabar.
 */
function ehConexaoFechadaAoEscrever(err: unknown): boolean {
  let atual: unknown = err;
  for (let i = 0; i < 5 && atual; i++) {
    const e = atual as { code?: string; message?: string; cause?: unknown };
    const fechada = e.code === 'CONNECTION_CLOSED' || e.code === 'CONNECTION_ENDED';
    if (fechada && typeof e.message === 'string' && e.message.startsWith('write ')) {
      return true;
    }
    atual = e.cause;
  }
  return false;
}

/** Assinatura mínima do client do postgres-js que o Drizzle consome. */
type SqlClient = ReturnType<typeof postgres>;

/**
 * Envolve o client para repetir UMA vez, em conexão nova, quando o socket
 * morreu antes do envio.
 *
 * O Drizzle conversa com o driver por um ponto só — `client.unsafe(query,
 * params)`, às vezes seguido de `.values()` — então é ali que a repetição cabe,
 * e não espalhada por dezenas de chamadas.
 *
 * `begin` (transação) recebe o client CRU de propósito: repetir uma instrução
 * solta no meio de uma transação cuja conexão caiu partiria a transação em
 * duas, o que é pior do que falhar.
 */
function comReconexao(criar: () => SqlClient): SqlClient {
  let sql = criar();

  function executar(query: string, params: unknown[], comValues: boolean): Promise<unknown> {
    const tentar = (cliente: SqlClient) => {
      const q = cliente.unsafe(query, params as never[]);
      return comValues ? q.values() : q;
    };

    return Promise.resolve()
      .then(() => tentar(sql))
      .catch(err => {
        if (!ehConexaoFechadaAoEscrever(err)) throw err;
        // O pool antigo ficou com o socket morto; abre outro e repete.
        // Uma tentativa só: se a nova conexão também cair, é sinal de problema
        // real do outro lado e insistir só adiaria o diagnóstico.
        sql = criar();
        return tentar(sql);
      });
  }

  return new Proxy(sql, {
    // O client do postgres-js é chamável (`sql\`select ...\``). Sem este trap o
    // Proxy quebraria esse uso.
    apply(_alvo, _this, args: unknown[]) {
      return (sql as unknown as (...a: unknown[]) => unknown)(...args);
    },
    get(_alvo, prop, receber) {
      if (prop === 'unsafe') {
        return (query: string, params: unknown[] = []) => ({
          then: (ok?: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
            executar(query, params, false).then(ok, falha),
          catch: (falha?: (e: unknown) => unknown) => executar(query, params, false).catch(falha),
          finally: (fim?: () => void) => executar(query, params, false).finally(fim),
          values: () => executar(query, params, true),
        });
      }
      const valor = Reflect.get(sql as object, prop, receber);
      return typeof valor === 'function' ? valor.bind(sql) : valor;
    },
  }) as SqlClient;
}

/** Pool do processo Node. Só existe fora do Worker. */
let nodeDb: Database | null = null;

function getNodeDb(): Database {
  if (nodeDb) return nodeDb;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Banco não configurado: defina DATABASE_URL (Node) ou o binding HYPERDRIVE (Worker).',
    );
  }

  /**
   * SSL é exigido por Postgres gerenciado (Supabase/Neon). O painel do Supabase
   * entrega a URI SEM `?sslmode=require`, então não dá para depender desse
   * parâmetro: qualquer host que não seja local recebe SSL.
   */
  const needsSsl =
    connectionString.includes('sslmode=require') ||
    !/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString);

  /**
   * O Transaction pooler multiplexa conexões entre transações, e por isso
   * **não suporta prepared statements** — que o postgres-js usa por padrão.
   *
   * Sem esta detecção, trocar para o pooler de transação quebraria em runtime
   * com erro obscuro ("prepared statement does not exist"), longe da causa.
   * Detecta-se pela porta 6543, exclusiva desse modo.
   */
  const isTransactionPooler = /:6543(\/|$|\?)/.test(connectionString);

  const sql = postgres(connectionString, {
    max: 10,
    ssl: needsSsl ? 'require' : false,
    connection: { search_path: SEARCH_PATH },
    // Idle timeout 20s: derruba conexões ociosas para não saturar o pool quando
    // os workers ficam parados entre execuções de cron.
    idle_timeout: 20,
    ...(isTransactionPooler ? { prepare: false } : {}),
  });

  nodeDb = drizzle(sql, { schema });
  return nodeDb;
}

/**
 * Um client por requisição do Worker, guardado no próprio objeto de contexto.
 *
 * Não dá para reaproveitar entre requisições: o Worker proíbe I/O em socket
 * aberto por outra requisição ("Cannot perform I/O on behalf of a different
 * request"). Cachear globalmente falha — o client nasceria no cold start, sem
 * contexto, preso na conexão direta.
 */
const perRequest = new WeakMap<object, Database>();

function getWorkerDb(ctx: WorkerContext, connectionString: string): Database {
  const existing = perRequest.get(ctx);
  if (existing) return existing;

  // A string do Hyperdrive aponta para o endpoint local da borda: o TLS é
  // terminado pelo próprio Hyperdrive, e exigi-lo aqui estoura em
  // `ERR_OPTION_NOT_IMPLEMENTED` (workerd não implementa rejectUnauthorized).
  // `fetch_types: false` evita a query de introspecção de tipos, que não
  // sobrevive à multiplexação. `max: 5` respeita o teto de conexões externas
  // simultâneas de um Worker.
  //
  // `max: 1` e não 5. O Worker limita as conexões TCP SIMULTÂNEAS de uma
  // requisição, e como cada requisição cria o seu próprio client, um pool de 5
  // encostava no teto sozinho: `/api/crm/queues` dispara uma query por coluna
  // do kanban, cinco em paralelo, cinco conexões. Com o polling da tela por
  // cima, as queries passaram a falhar de forma intermitente — em `users`,
  // `leads` e `connections` indistintamente, porque o problema nunca foi a
  // query, era a conexão.
  //
  // Uma conexão por requisição não é limitação: quem faz pooling de verdade é
  // o Hyperdrive, do outro lado. As queries da requisição serializam nela, o
  // que troca um pouco de latência por não estourar o teto.
  // `comReconexao` porque `max: 1` reduziu o 500 intermitente mas não o
  // eliminou: o Hyperdrive fecha o socket por conta dele, e a requisição
  // seguinte descobria isso escrevendo num cano morto. Ver o comentário da
  // função — a repetição vale só quando a consulta não chegou a sair.
  const sql = comReconexao(() =>
    postgres(connectionString, {
      max: 1,
      fetch_types: false,
      ssl: false,
      connection: { search_path: SEARCH_PATH },
    })
  );

  // NÃO chamar `sql.end()` aqui. O postgres-js marca o pool como encerrando no
  // instante da chamada e passa a rejeitar tudo que for emitido depois — como o
  // client nasce antes da primeira query, fechá-lo aqui derrubaria todas elas.
  // O pool morre junto com o contexto da requisição; o Hyperdrive faz o pooling
  // de verdade do outro lado.

  const instance = drizzle(sql, { schema });
  perRequest.set(ctx, instance);
  return instance;
}

function getDb(): Database {
  const ctx = readWorkerContext();
  const connectionString = ctx?.env?.HYPERDRIVE?.connectionString;
  if (ctx && connectionString) return getWorkerDb(ctx, connectionString);
  return getNodeDb();
}

/**
 * Proxy preguiçoso: resolve o client a cada acesso.
 *
 * `db` é importado no topo de dezenas de módulos, o que acontece no cold start
 * — antes de existir qualquer contexto de requisição. Resolver ali fixaria a
 * escolha errada para sempre. Resolvendo por acesso, cada requisição do Worker
 * pega o seu próprio client via Hyperdrive e o Node segue com o pool único.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop) {
    const real = getDb() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    // Métodos vêm ligados à instância real: sem isso, `db.transaction(...)`
    // executaria com `this` apontando para o Proxy vazio.
    return typeof value === 'function' ? value.bind(real) : value;
  },
  has: (_target, prop) => prop in (getDb() as object),
});

export type DB = Database;
