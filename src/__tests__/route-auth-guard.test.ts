/**
 * Toda rota autenticada precisa CHAMAR a guarda — o middleware não basta.
 *
 * O middleware usa `getSessionCookie`, que só verifica se o cookie EXISTE. A
 * própria doc do better-auth diz que serve para redirect otimista e não para
 * autorização. Três rotas confiaram nele e ficaram abertas em produção:
 * `/api/leads` devolvia nome e telefone de todos os leads, `/api/leads/[id]/
 * messages` devolvia a conversa inteira e `/api/uazapi/status` devolvia os
 * dados da conexão — bastava mandar `cookie: better-auth.session_token=xxx`.
 *
 * Este teste é estrutural de propósito: ele varre os arquivos de rota em vez de
 * exercitar handlers. O que precisa ser impossível é ALGUÉM CRIAR A PRÓXIMA
 * rota sem guarda — e isso um teste de comportamento por rota nunca pega,
 * porque a rota nova não tem teste nenhum.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

const RAIZ = join(process.cwd(), 'src', 'app', 'api');

/**
 * Rotas que legitimamente não usam sessão, com o motivo. Acrescentar aqui é
 * uma decisão consciente; o default é exigir guarda.
 */
const SEM_SESSAO: Record<string, string> = {
  'auth/[...all]': 'é o próprio better-auth — quem emite a sessão',
  'health': 'liveness público; o diagnóstico extra exige CRON_SECRET',
  'cron/tick': 'sem sessão por natureza; protegido por CRON_SECRET',
  'cron/backup': 'sem sessão por natureza; protegido por CRON_SECRET',
  'cron/escalation': 'sem sessão por natureza; protegido por CRON_SECRET',
  'webhooks/whatsapp': 'a uazapi não faz login; valida por connectionId',
  'webhooks/whatsapp/[connectionId]': 'idem',
  'webhooks/meta/[connectionId]': 'a Meta não faz login; valida por assinatura (META_APP_SECRET)',
  'webhooks/evolution/[connectionId]':
    'a Evolution não faz login; valida por segredo no header x-evolution-token, comparado em tempo constante com connections.metadata.webhookToken',
  'media/[key]': 'a uazapi/CDN busca o arquivo por URL, sem cookie',
  'email/oauth/callback':
    'é o navegador voltando do Google, onde o cookie de sessão pode não vir (cross-site). ' +
    'A identidade vem do `state` assinado com HMAC-SHA256 e conferido em tempo constante — ' +
    'exigir sessão aqui faria a conexão falhar de forma intermitente',
};

/**
 * Duas formas VÁLIDAS de guardar um handler:
 *   1. `requireSession(req)` / `requireAdmin(req)` — o helper do projeto;
 *   2. `auth.api.getSession(...)` seguido de um 401 quando não houver usuário.
 *
 * A segunda é aceita porque algumas rotas precisam do `session.user.id` de
 * qualquer jeito (pra atribuir autoria) e chamar o helper seria consultar duas
 * vezes. O que NÃO vale é chamar `getSession` e não checar o resultado.
 */
function temGuarda(src: string): boolean {
  if (/require(Session|Admin)\s*\(/.test(src)) return true;
  return (
    /auth\.api\.getSession\s*\(/.test(src) &&
    /!session\?\.user\?\.id[\s\S]{0,120}?401/.test(src)
  );
}

function rotas(dir: string, prefixo = ''): Array<{ id: string; arquivo: string }> {
  const saida: Array<{ id: string; arquivo: string }> = [];
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) {
      saida.push(...rotas(caminho, prefixo ? `${prefixo}/${entrada}` : entrada));
    } else if (entrada === 'route.ts') {
      saida.push({ id: prefixo, arquivo: caminho });
    }
  }
  return saida;
}

describe('guarda de autenticação nas rotas de API', () => {
  const todas = rotas(RAIZ);

  it('encontra as rotas do projeto', () => {
    expect(todas.length).toBeGreaterThan(30);
  });

  it.each(todas.filter(r => !(r.id in SEM_SESSAO)))(
    '/api/$id chama requireSession ou requireAdmin',
    ({ arquivo }) => {
      const src = readFileSync(arquivo, 'utf8');
      expect(temGuarda(src)).toBe(true);
    }
  );

  it('a lista de exceções não tem entrada morta', () => {
    const ids = new Set(todas.map(r => r.id));
    const orfas = Object.keys(SEM_SESSAO).filter(id => !ids.has(id));
    expect(orfas, `exceções apontando pra rota que não existe mais: ${orfas.join(', ')}`).toEqual([]);
  });

  it('todo handler exportado é coberto pela guarda do arquivo', () => {
    // Guarda no GET e não no POST é o erro do meio: o arquivo "tem" a chamada,
    // mas um dos verbos passa direto. Foi assim em /leads/[id]/messages.
    const problemas: string[] = [];
    for (const { id, arquivo } of todas) {
      if (id in SEM_SESSAO) continue;
      const src = readFileSync(arquivo, 'utf8');
      const blocos = src.split(/(?=export async function (?:GET|POST|PATCH|PUT|DELETE)\b)/);
      for (const bloco of blocos) {
        const m = /^export async function (GET|POST|PATCH|PUT|DELETE)\b/.exec(bloco);
        if (!m) continue;
        if (!temGuarda(bloco)) problemas.push(`${m[1]} /api/${id}`);
      }
    }
    expect(problemas, `handlers sem guarda: ${problemas.join(', ')}`).toEqual([]);
  });
});

describe('caminho do arquivo é independente de plataforma', () => {
  it('usa o separador do sistema', () => {
    expect(RAIZ.includes(sep)).toBe(true);
  });
});
