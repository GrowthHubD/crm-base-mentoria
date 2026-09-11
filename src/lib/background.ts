/**
 * Mantém trabalho assíncrono vivo depois que a resposta já foi devolvida.
 *
 * O webhook responde 200 na hora e processa a mensagem em seguida — em Node
 * isso funciona sozinho, porque o processo continua rodando. No Cloudflare
 * Worker não: assim que a resposta sai, tudo que estiver pendente é cancelado
 * sem erro nenhum. O sintoma é cruel — o provedor recebe 200, o log diz
 * "processando inline", e a mensagem simplesmente nunca aparece no banco.
 *
 * `ctx.waitUntil` é o que estende a vida da requisição. O contexto do banco
 * também sobrevive junto, porque o client é guardado no mesmo objeto de
 * contexto que o `waitUntil` mantém vivo.
 */
const CLOUDFLARE_CONTEXT = Symbol.for('__cloudflare-context__');

interface WorkerContext {
  ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
}

export function runInBackground(work: Promise<unknown>): void {
  const ctx = (globalThis as Record<symbol, unknown>)[CLOUDFLARE_CONTEXT] as
    | WorkerContext
    | undefined;

  const waitUntil = ctx?.ctx?.waitUntil;
  if (waitUntil) {
    try {
      waitUntil.call(ctx!.ctx, work);
      return;
    } catch {
      // `waitUntil` recusa quando a requisicao ja foi drenada (acontece ao
      // agendar trabalho de dentro de outro trabalho em background). Cair pro
      // caminho de baixo e melhor do que estourar e perder a mensagem.
    }
  }

  // Node: a promise sobrevive por conta própria. O catch evita derrubar o
  // processo por unhandled rejection.
  void work.catch(() => {});
}
