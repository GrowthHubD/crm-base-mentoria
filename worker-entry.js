/**
 * Entrada do Worker — embrulha o bundle do OpenNext pra acrescentar `scheduled`.
 *
 * Por que existe: o OpenNext gera um worker só com `fetch`, e Cron Trigger da
 * Cloudflare invoca `scheduled`. Sem este wrapper não há onde pendurar o cron,
 * e tudo que no Node é job do BullMQ (escalação de pipeline, mensagens
 * agendadas, follow-ups, steps de automação) simplesmente não roda.
 *
 * O cron não reimplementa nada: faz uma requisição interna pra própria app, na
 * rota `/api/cron/tick`. Assim a lógica vive num lugar só e continua testável
 * por HTTP.
 */
import openNextHandler from './.open-next/worker.js';

export default {
  fetch(request, env, ctx) {
    return openNextHandler.fetch(request, env, ctx);
  },

  async scheduled(event, env, ctx) {
    const url = new URL('/api/cron/tick', env.NEXTAUTH_URL ?? 'https://crm-base.workers.dev');
    const request = new Request(url, {
      method: 'POST',
      headers: { 'x-cron-secret': env.CRON_SECRET ?? '' },
    });

    // `waitUntil` garante que a passada termine mesmo depois do handler
    // retornar — sem isso o isolate morre no meio da atualização de status.
    ctx.waitUntil(
      openNextHandler
        .fetch(request, env, ctx)
        .then(async (res) => {
          console.log(`[cron] tick -> HTTP ${res.status}`);
        })
        .catch((err) => {
          console.error('[cron] tick falhou', err);
        })
    );
  },
};
