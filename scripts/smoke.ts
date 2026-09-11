/**
 * Bateria de fumaça contra uma instância NO AR.
 *
 * Existe porque as três falhas mais caras deste projeto passaram batido no
 * teste unitário E na olhada na tela:
 *
 *   1. `search_path` que não chegava ao banco — a instância de um cliente lia o
 *      schema de OUTRO, sem erro nenhum: health ok, login funcionando, dados do
 *      vizinho na tela.
 *   2. Gating de plano que escondia o menu mas deixava a URL aberta — módulo
 *      não contratado respondendo 200.
 *   3. Pool de conexão estourando só sob concorrência — 500 intermitente que
 *      nunca aparece numa requisição isolada.
 *
 * Nenhuma das três aparece rodando `npm test`. Só batendo no ambiente publicado,
 * autenticado, e com mais de uma chamada ao mesmo tempo.
 *
 * Uso:
 *   npm run smoke              # todas as instâncias de .credenciais/smoke.json
 *   npm run smoke -- acme     # só uma
 *
 * As credenciais vivem em `.credenciais/smoke.json` (gitignorado) — nunca como
 * argumento de linha de comando, que fica no histórico do shell.
 *
 * `features` no smoke.json tem que espelhar os `vars` daquele environment no
 * wrangler.jsonc. Não é redundância: é justamente a divergência entre os dois
 * que a bateria procura — módulo aberto num cliente que não o comprou, ou
 * fechado num cliente que pagou por ele.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Modulo = 'aiAgent' | 'scheduling' | 'quickReplies' | 'ranking';

interface Instancia {
  nome: string;
  url: string;
  email: string;
  senha: string;
  schema: string;
  cronSecret?: string;
  /** O que este cliente contratou — espelho dos `vars` do wrangler.jsonc. */
  features: Record<Modulo, boolean>;
}

const CONFIG = resolve(process.cwd(), '.credenciais/smoke.json');

function carregarInstancias(): Instancia[] {
  let bruto: string;
  try {
    bruto = readFileSync(CONFIG, 'utf8');
  } catch {
    console.error(
      `Não achei ${CONFIG}.\n` +
        `Crie o arquivo com a lista de instâncias — veja .credenciais/smoke.exemplo.json.`
    );
    process.exit(2);
  }
  const lista = JSON.parse(bruto) as Instancia[];
  const filtro = process.argv.slice(2).filter(a => !a.startsWith('-'));
  return filtro.length ? lista.filter(i => filtro.includes(i.nome)) : lista;
}

let BASE = '';
let EMAIL = '';
let PASSWORD = '';
let SCHEMA = '';
let CRON = '';
let FEATURES: Record<Modulo, boolean> = {
  aiAgent: false,
  scheduling: false,
  quickReplies: false,
  ranking: true,
};

let cookie = '';
let falhas: string[] = [];
let avisos: string[] = [];

const ok = (nome: string, detalhe = '') =>
  console.log(`  ok   ${nome}${detalhe ? ` — ${detalhe}` : ''}`);

function falha(nome: string, detalhe: string) {
  console.log(`  FALHA ${nome} — ${detalhe}`);
  falhas.push(`${nome}: ${detalhe}`);
}

function aviso(nome: string, detalhe: string) {
  console.log(`  ...  ${nome} — ${detalhe}`);
  avisos.push(`${nome}: ${detalhe}`);
}

/** Requisição autenticada. `cb` mata cache de borda: sem isso um 200 velho
 *  do Hyperdrive/CDN mascara uma rota que está quebrada agora. */
async function req(path: string, init: RequestInit = {}) {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (cookie) headers.cookie = cookie;
  const sep = path.includes('?') ? '&' : '?';
  return fetch(`${BASE}${path}${sep}_smoke=${Date.now()}`, {
    ...init,
    headers,
    redirect: 'manual',
  });
}

async function esperado(path: string, codes: number[], nome = path) {
  try {
    const res = await req(path);
    if (codes.includes(res.status)) ok(nome, `HTTP ${res.status}`);
    else falha(nome, `esperava ${codes.join(' ou ')}, veio ${res.status}`);
    return res.status;
  } catch (err) {
    falha(nome, `exceção: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

async function rodar(inst: Instancia) {
  BASE = inst.url.replace(/\/$/, '');
  EMAIL = inst.email;
  PASSWORD = inst.senha;
  SCHEMA = inst.schema;
  CRON = inst.cronSecret ?? '';
  FEATURES = inst.features;
  cookie = '';
  falhas = [];
  avisos = [];

  const contratados = (Object.keys(FEATURES) as Modulo[]).filter(k => FEATURES[k]);
  console.log(
    `\n=== ${inst.nome} — ${BASE}\n    contratado: ${contratados.join(', ') || '(só o núcleo)'} ===\n`
  );

  console.log('SAUDE');
  try {
    const h = await fetch(`${BASE}/api/health?_smoke=${Date.now()}`);
    const hj = (await h.json()) as Record<string, unknown>;
    if (h.status === 200 && hj.database === true) ok('health', `banco ok, ${hj.latencyMs}ms`);
    else falha('health', `HTTP ${h.status} ${JSON.stringify(hj)}`);
  } catch (err) {
    falha('health', String(err));
  }

  // A verificação que teria pego o vazamento de schema no minuto zero.
  if (CRON && SCHEMA) {
    const d = await fetch(`${BASE}/api/health?_smoke=${Date.now()}`, {
      headers: { 'x-cron-secret': CRON },
    });
    const dj = (await d.json()) as Record<string, unknown>;
    if (dj.schemaEmUso === SCHEMA) ok('schema em uso', String(dj.schemaEmUso));
    else
      falha(
        'schema em uso',
        `esperava "${SCHEMA}", está em "${dj.schemaEmUso}" — esta instância pode estar lendo dados de OUTRO cliente`
      );
  } else {
    aviso('schema em uso', 'sem SMOKE_CRON_SECRET/SMOKE_SCHEMA, não verificado');
  }

  console.log('\nAUTENTICACAO');
  const semSessao = await fetch(`${BASE}/api/leads`, { redirect: 'manual' });
  if ([301, 302, 307, 308, 401, 403].includes(semSessao.status))
    ok('API sem sessão barrada', `HTTP ${semSessao.status}`);
  else falha('API sem sessão', `HTTP ${semSessao.status} — rota aberta sem login`);

  // Login sem `Origin` tem que ser recusado: é o anti-CSRF do better-auth. Se
  // um dia isso passar a responder 200, qualquer site consegue logar em nome do
  // usuário a partir do navegador dele.
  const semOrigin = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (semOrigin.status === 403) ok('login sem Origin recusado (CSRF)', 'HTTP 403');
  else falha('login sem Origin', `HTTP ${semOrigin.status} — proteção CSRF caiu`);

  // Cookie INVENTADO. É a falha mais silenciosa que existe aqui: o middleware
  // usa `getSessionCookie`, que só verifica que o cookie EXISTE — não valida
  // assinatura nem expiração. Rota que "confia no middleware" está aberta pra
  // qualquer um que mande um cookie com o nome certo e conteúdo qualquer.
  // Três rotas estavam assim (leads, histórico da conversa, status da conexão).
  const forjado = 'better-auth.session_token=nao-assinado';
  const abertas: string[] = [];
  for (const p of [
    '/api/leads',
    '/api/leads/00000000-0000-0000-0000-000000000000/messages',
    '/api/uazapi/status',
    '/api/crm/queues',
    '/api/crm/search?q=a',
    '/api/connections',
    '/api/me',
    '/api/ranking',
    '/api/dashboard/stats',
    '/api/admin/pipeline-config',
  ]) {
    const r = await fetch(`${BASE}${p}`, { headers: { cookie: forjado }, redirect: 'manual' });
    if (r.status === 200) abertas.push(`${p} (${r.status})`);
  }
  if (abertas.length === 0) ok('cookie forjado rejeitado em todas as rotas');
  else falha('cookie forjado', `respondem 200 SEM login válido: ${abertas.join(', ')}`);

  const login = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, referer: `${BASE}/login` },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (login.status !== 200) {
    falha('login', `HTTP ${login.status}`);
    console.log('\nSem sessão o resto desta instância não roda.');
    return falhas;
  }
  cookie = (login.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).join('; ');
  if (!cookie) {
    falha('login', 'HTTP 200 mas sem cookie de sessão');
    return falhas;
  }
  ok('login', EMAIL);

  const senhaErrada = await fetch(`${BASE}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, referer: `${BASE}/login` },
    body: JSON.stringify({ email: EMAIL, password: `${PASSWORD}-errada` }),
  });
  if (senhaErrada.status >= 400) ok('senha errada rejeitada', `HTTP ${senhaErrada.status}`);
  else falha('senha errada', `HTTP ${senhaErrada.status} — aceitou credencial inválida`);

  console.log('\nNUCLEO (tem que responder em qualquer plano)');
  for (const p of [
    '/api/me',
    '/api/crm/queues',
    '/api/leads',
    '/api/connections',
    '/api/dashboard/stats',
    '/api/dashboard/timeline',
    '/api/dashboard/channels',
    '/api/dashboard/hourly',
    '/api/dashboard/attendants',
    '/api/dashboard/converted',
    '/api/dashboard/atendimentos',
    '/api/crm/search?q=a',
    '/api/admin/pipeline-config',
  ]) {
    await esperado(p, [200]);
  }

  console.log('\nPAGINAS (500 aqui é a tela do cliente quebrando)');
  for (const p of ['/dashboard', '/crm', '/conexoes', '/configuracoes', '/superadmin/users']) {
    await esperado(p, [200], p);
  }

  console.log('\nPLANO (o não contratado precisa estar FECHADO, não só escondido)');
  // Cada módulo tem uma API e uma página. As duas metades importam: esconder o
  // item do menu e deixar a URL abrir é exatamente o bug que já aconteceu.
  const MODULOS: Array<{ chave: Modulo; api: string; pagina: string }> = [
    { chave: 'aiAgent', api: '/api/admin/ai-config', pagina: '/agente-ia' },
    { chave: 'quickReplies', api: '/api/admin/quick-replies', pagina: '/textos-rapidos' },
    { chave: 'scheduling', api: '/api/scheduled-messages', pagina: '/agendamentos' },
    { chave: 'ranking', api: '/api/ranking', pagina: '/ranking' },
  ];

  for (const m of MODULOS) {
    const contratado = FEATURES[m.chave];
    const rotulo = contratado ? 'contratado' : 'deve estar fechado';
    await esperado(m.api, contratado ? [200] : [404], `${m.api} (${rotulo})`);
    await esperado(m.pagina, contratado ? [200] : [307, 308], `${m.pagina} (${rotulo})`);
  }

  console.log('\nCRON');
  if (CRON) {
    const sem = await fetch(`${BASE}/api/cron/tick`, { method: 'POST' });
    if (sem.status === 404 || sem.status === 401)
      ok('tick sem segredo barrado', `HTTP ${sem.status}`);
    else falha('tick sem segredo', `HTTP ${sem.status} — endpoint exposto`);

    const com = await fetch(`${BASE}/api/cron/tick`, {
      method: 'POST',
      headers: { 'x-cron-secret': CRON },
    });
    if (com.status === 200) ok('tick com segredo', 'HTTP 200');
    else falha('tick com segredo', `HTTP ${com.status} — agendadas e follow-ups não disparam`);
  } else {
    aviso('cron', 'sem SMOKE_CRON_SECRET, não verificado');
  }

  console.log('\nWEBHOOK DA META');
  // A Meta desativa endpoint que devolve erro em série. Sem assinatura válida a
  // resposta tem que ser recusa limpa, nunca 500.
  const wh = await fetch(`${BASE}/api/webhooks/meta/inexistente`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: [] }),
  });
  if (wh.status < 500) ok('webhook recusa sem quebrar', `HTTP ${wh.status}`);
  else falha('webhook', `HTTP ${wh.status} — a Meta desativa endpoint que falha em série`);

  console.log('\nCONCORRENCIA (é o que a tela faz: polling em várias abas)');
  const alvos = ['/api/crm/queues', '/api/connections', '/api/dashboard/stats'];
  const codigos: number[] = [];
  for (let rodada = 0; rodada < 8; rodada++) {
    const res = await Promise.all(
      alvos.map(p =>
        req(p)
          .then(r => r.status)
          .catch(() => 0)
      )
    );
    codigos.push(...res);
  }
  const ruins = codigos.filter(c => c !== 200);
  if (ruins.length === 0) ok(`${codigos.length} chamadas em paralelo`, 'todas 200');
  else
    falha(
      'concorrência',
      `${ruins.length}/${codigos.length} falharam (códigos: ${[...new Set(ruins)].join(', ')})`
    );

  if (falhas.length === 0)
    console.log(`\n-> ${inst.nome}: PASSOU${avisos.length ? ` (${avisos.length} não verificado)` : ''}`);
  else console.log(`\n-> ${inst.nome}: ${falhas.length} FALHA(S)`);

  return falhas;
}

async function main() {
  const instancias = carregarInstancias();
  if (!instancias.length) {
    console.error('Nenhuma instância corresponde ao filtro.');
    process.exit(2);
  }

  // Em série de propósito: rodar em paralelo mistura a saída de duas instâncias
  // e, pior, a fase de concorrência de uma vira ruído na da outra.
  const resultado: Array<[string, string[]]> = [];
  for (const inst of instancias) {
    resultado.push([inst.nome, await rodar(inst)]);
  }

  console.log('\n════ RESUMO GERAL ════');
  let total = 0;
  for (const [nome, fs] of resultado) {
    total += fs.length;
    if (fs.length === 0) {
      console.log(`  ${nome}: ok`);
    } else {
      console.log(`  ${nome}: ${fs.length} falha(s)`);
      for (const f of fs) console.log(`      - ${f}`);
    }
  }
  console.log('');
  process.exit(total ? 1 : 0);
}

main().catch(err => {
  console.error('A bateria quebrou antes de terminar:', err);
  process.exit(2);
});
