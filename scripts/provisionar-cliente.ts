/**
 * Provisiona um cliente do zero até VERIFICADO NO AR, num comando.
 *
 * Uso (o modo é obrigatório — sem flag o script recusa rodar):
 *   npm run cliente:novo -- acme2 "Acme" --deploy   (instalação nova completa)
 *   npm run cliente:novo -- acme4 "Acme" --so-banco            (para antes da nuvem)
 *   npm run cliente:novo -- acme "Acme"   --so-verificar        (só roda a bateria)
 *
 * Onze passos, e a ordem de dois deles não é preferência:
 *
 *  - O ROLE do cliente (3) precisa existir antes do Hyperdrive (6), porque é a
 *    string de conexão dele que o Hyperdrive guarda. Sem role próprio, o
 *    Hyperdrive descarta o `search_path` e a instância lê o schema de OUTRO
 *    cliente — sem erro nenhum. Ver `ensure-client-role.ts`.
 *  - A ROTA (9) precisa nascer antes de qualquer Custom Domain sair. Com o
 *    curinga `*` na zona, o nome resolve mesmo sem rota, e a Cloudflare devolve
 *    522 — o host fica de pé retornando erro, o que parece bug de aplicação.
 *    Foi assim que derrubamos um cliente por alguns minutos.
 *
 * Termina rodando a bateria de fumaça contra a instância recém-criada. É a
 * diferença entre "os comandos rodaram" e "está funcionando": o script falha
 * alto se a instância nova não passar.
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// ── argumentos ────────────────────────────────────────────────────────────
// Aceita posicional E nomeado: `npm run` COME as flags `--slug`/`--nome`, então
// exigir a forma nomeada deixaria o comando documentado quebrado no uso óbvio.
const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n: string) => argv.includes(`--${n}`);
const posicionais = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const ant = argv[i - 1];
  return !(ant === '--slug' || ant === '--nome');
});

const slug = (arg('slug') ?? posicionais[0] ?? '').trim().toLowerCase();
const nome = (arg('nome') ?? posicionais.slice(1).join(' ')).trim();

if (!/^[a-z][a-z0-9]{1,30}$/.test(slug)) {
  console.error('slug inválido: só letras minúsculas e números, começando por letra.');
  console.error('  Uso: npm run cliente:novo -- <slug> "<Nome Comercial>"');
  process.exit(1);
}
if (!nome) {
  console.error('nome comercial obrigatório.  Uso: npm run cliente:novo -- <slug> "<Nome>"');
  process.exit(1);
}

// Modo explícito, sempre: sem flag este script chegava a criar Hyperdrive,
// gravar secrets, buildar e publicar o CRM E o acesso central — tudo a partir
// de um comando que o README apresentava como "cria o banco".
if (!flag('so-banco') && !flag('so-verificar') && !flag('deploy')) {
  console.error('Escolha o modo: --so-banco (só banco/admin), --so-verificar (só smoke) ou --deploy (instalação nova + acesso central).');
  process.exit(1);
}
if (/[\\/<>:"|?*]/.test(nome) || nome.includes('..')) {
  console.error('nome comercial inválido: caracteres de caminho não são permitidos.');
  process.exit(1);
}
if (flag('so-verificar')) {
  execFileSync('npx', ['tsx', 'scripts/smoke.ts', slug], { stdio: 'inherit', shell: process.platform === 'win32' });
  process.exit(0);
}

const SCHEMA = `cliente_${slug}`;
const WORKER = `crm-${slug}`;
const ZONA = process.env.LIDY_ZONE ?? 'seudominio.com.br';
const HOST = `${slug}.${ZONA}`;
const ADMIN = `admin@${slug}.lidy`;
const PASTA = `.credenciais/${nome.toUpperCase()}`;

/** Sem caracteres ambíguos (0/O, 1/l/I): esta senha vai ser lida em voz alta. */
const novaSenha = () =>
  Array.from(randomBytes(14))
    .map(b => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 55])
    .join('');
const SENHA = novaSenha();
if (existsSync(PASTA)) {
  console.error('A pasta de credenciais deste cliente já existe. Não reprovisiono nem troco chave de instalação viva.');
  process.exit(1);
}

// ── utilidades ────────────────────────────────────────────────────────────
let passoAtual = 0;
const TOTAL = 11;

function passo(titulo: string) {
  passoAtual++;
  console.log(`\n${'─'.repeat(60)}\n${passoAtual}/${TOTAL}  ${titulo}\n${'─'.repeat(60)}`);
}

function rodar(cmd: string, args: string[], env: Record<string, string> = {}) {
  execFileSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
}

/** Igual a `rodar`, mas devolve a saída em vez de imprimir. */
function capturar(cmd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
}

function guardar(arquivo: string, conteudo: string) {
  mkdirSync(PASTA, { recursive: true });
  writeFileSync(`${PASTA}/${arquivo}`, conteudo);
}

console.log(`
╔══════════════════════════════════════════════════════════════╗
  ${nome}
    slug ......... ${slug}
    schema ....... ${SCHEMA}
    worker ....... ${WORKER}
    endereço ..... https://${HOST}
    admin ........ ${ADMIN}
╚══════════════════════════════════════════════════════════════╝`);

// ══ BANCO ═════════════════════════════════════════════════════════════════
if (!flag('so-verificar')) {
  passo('schema');
  rodar('npx', ['tsx', 'scripts/ensure-schema.ts'], { DB_SCHEMA: SCHEMA });

  passo('migrations');
  rodar('npx', ['tsx', 'scripts/migrate-schema.ts'], { DB_SCHEMA: SCHEMA });

  passo('role isolado do cliente');
  rodar('npx', ['tsx', 'scripts/ensure-client-role.ts'], {
    DB_SCHEMA: SCHEMA,
    CLIENT_FOLDER: nome.toUpperCase(),
  });

  passo('índice composto de messages');
  rodar('npx', ['tsx', 'scripts/create-messages-index.ts'], { DB_SCHEMA: SCHEMA });

  passo('admin do cliente');
  rodar('npx', ['tsx', 'scripts/seed.ts'], {
    DB_SCHEMA: SCHEMA,
    ADMIN_EMAIL: ADMIN,
    ADMIN_PASSWORD: SENHA,
    ADMIN_NAME: `Admin ${nome}`,
  });
} else {
  passoAtual = 5;
}

if (flag('so-banco')) {
  console.log('\n--so-banco: parando aqui. A parte da Cloudflare não foi tocada.');
  process.exit(0);
}

// ══ CLOUDFLARE ════════════════════════════════════════════════════════════
const connFile = `${PASTA}/${SCHEMA}.conn.txt`;

passo('Hyperdrive');
let hyperdriveId = '';
if (!flag('so-verificar')) {
  if (!existsSync(connFile)) {
    console.error(`Não achei ${connFile}. O passo do role precisa ter rodado.`);
    process.exit(1);
  }
  const conn = readFileSync(connFile, 'utf8').trim();
  const saida = capturar('npx', [
    'wrangler', 'hyperdrive', 'create', WORKER, `--connection-string=${conn}`,
  ]);
  hyperdriveId = (/Created new Hyperdrive[^:]*:\s*([0-9a-f]{32})/i.exec(saida) ?? [])[1] ?? '';
  if (!hyperdriveId) {
    console.error('Não consegui ler o id do Hyperdrive na saída:\n' + saida);
    process.exit(1);
  }
  console.log(`  id: ${hyperdriveId}`);
  // Cache DESLIGADO: o padrão do Hyperdrive é cachear SELECT por até 60s, e num
  // CRM isso quebra o básico — gravar e a tela seguir mostrando o valor antigo.
  rodar('npx', ['wrangler', 'hyperdrive', 'update', hyperdriveId, '--caching-disabled']);
  guardar('hyperdrive-id.txt', hyperdriveId);
}

passo('entrada no wrangler.jsonc');
{
  const p = 'wrangler.jsonc';
  let s = readFileSync(p, 'utf8');
  if (s.includes(`"${slug}": {`)) {
    console.log('  já existe — mantida como está.');
    if (hyperdriveId) {
      s = s.replace(
        new RegExp(`("${slug}": \\{[\\s\\S]*?"id": ")PREENCHER-HYPERDRIVE-ID(")`),
        `$1${hyperdriveId}$2`
      );
      writeFileSync(p, s);
      console.log('  id do Hyperdrive preenchido.');
    }
  } else {
    const bloco = `
    "${slug}": {
      "name": "${WORKER}",
      "vars": {
        "NEXTAUTH_URL": "https://${HOST}",
        "APP_CLIENT_NAME": "${nome}",
        "DB_SCHEMA": "${SCHEMA}",
        "FEATURE_AI_AGENT": "false",
        "FEATURE_SCHEDULING": "false",
        "FEATURE_QUICK_REPLIES": "false",
        "FEATURE_RANKING": "true"
      },
      "hyperdrive": [{ "binding": "HYPERDRIVE", "id": "${hyperdriveId}", "localConnectionString": "postgresql://postgres:postgres@localhost:5432/postgres" }],
      "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "aixo-crm-media" }, { "binding": "BACKUPS", "bucket_name": "crm-backups" }],
      "triggers": { "crons": ["* * * * *"] },
      "routes": [{ "pattern": "${HOST}/*", "zone_name": "${ZONA}" }]
    },
`;
    // Insere logo depois da abertura de "env": mantém o arquivo válido sem
    // precisar reserializar (o que apagaria todos os comentários, que aqui
    // carregam o porquê de cada decisão).
    const marca = '"env": {';
    s = s.replace(marca, marca + bloco);
    writeFileSync(p, s);
    console.log('  entrada criada.');
  }
}

passo('segredos');
if (!flag('so-verificar')) {
  for (const chave of ['BETTER_AUTH_SECRET', 'ENCRYPTION_KEY', 'CRON_SECRET']) {
    const valor = randomBytes(32).toString('hex');
    // stdin DIRETO, sem shell no meio. A primeira versão canalizava por `cmd`
    // no Windows e os valores chegaram corrompidos: o Worker ficou com segredos
    // diferentes dos gravados aqui, o login passou a dar 500 e o diagnóstico de
    // schema parou de responder — tudo depois de um deploy que terminou com
    // sucesso. É o mesmo erro que já estava catalogado (segredo com `\n`) e que
    // eu repeti ao montar o pipe.
    //
    // `input` entrega os bytes exatos ao processo. Nada de echo, printf ou pipe.
    execFileSync('npx', ['wrangler', 'secret', 'put', chave, '--env', slug], {
      input: valor,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    });
    appendFileSync(`${PASTA}/segredos.txt`, `${chave}=${valor}\n`);
  }
}

passo('deploy');
rodar('npm', ['run', 'cf:build']);
rodar('npx', ['wrangler', 'deploy', '--env', slug]);

passo('cadastro no acesso central');
{
  const p = 'central/public/router.js';
  let s = readFileSync(p, 'utf8');
  if (s.includes(`${slug}:`)) {
    console.log('  já cadastrado.');
  } else {
    s = s.replace('const CLIENTES = {', `const CLIENTES = {\n  ${slug}: '${HOST}',`);
    writeFileSync(p, s);
    console.log('  cadastrado.');
  }
  rodar('npx', ['wrangler', 'deploy', '--config', 'central/wrangler.jsonc']);
}

// ══ VERIFICAÇÃO ═══════════════════════════════════════════════════════════
passo('bateria de fumaça contra a instância nova');
{
  const p = '.credenciais/smoke.json';
  const alvos = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : [];
  const segredos = readFileSync(`${PASTA}/segredos.txt`, 'utf8');
  const cron = (/CRON_SECRET=(\S+)/.exec(segredos) ?? [])[1] ?? '';

  const existente = alvos.find((a: { nome: string }) => a.nome === slug);
  const entrada = {
    nome: slug,
    url: `https://${HOST}`,
    email: ADMIN,
    senha: SENHA,
    schema: SCHEMA,
    cronSecret: cron,
    features: { aiAgent: false, scheduling: false, quickReplies: false, ranking: true },
  };
  if (existente) Object.assign(existente, entrada);
  else alvos.push(entrada);
  writeFileSync(p, JSON.stringify(alvos, null, 2) + '\n');

  guardar(
    `${slug}.txt`,
    `CRM ${nome}\nURL:   https://${HOST}\n\nADMIN\n  ${ADMIN}\n  ${SENHA}\n\n` +
      `TROQUE a senha no primeiro acesso. Este arquivo não vai pro git.\n`
  );

  try {
    rodar('npx', ['tsx', 'scripts/smoke.ts', slug]);
  } catch {
    console.error(`
╔══════════════════════════════════════════════════════════════╗
  A instância subiu MAS NÃO PASSOU na verificação.
  Ela está no ar e pode estar servindo errado — não entregue ao
  cliente antes de olhar a saída acima.
╚══════════════════════════════════════════════════════════════╝`);
    process.exit(1);
  }
}

console.log(`
╔══════════════════════════════════════════════════════════════╗
  ${nome} — PRONTO E VERIFICADO

  https://${HOST}
  ${ADMIN}
  ${SENHA}

  Credenciais em ${PASTA}/
  Troque a senha no primeiro acesso.

  Falta só o WhatsApp:
    uazapi   → QR na tela /conexoes
    oficial  → DB_SCHEMA=${SCHEMA} npm run connect:cloud
╚══════════════════════════════════════════════════════════════╝
`);
