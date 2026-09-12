/**
 * Módulos vendidos à parte — o que ESTE deploy tem contratado.
 *
 * Existe porque papel e plano são eixos DIFERENTES e estavam confundidos:
 *
 *   papel  → o que ESTE USUÁRIO pode fazer dentro do que a empresa contratou
 *            (atendente não mexe em configuração; admin mexe).
 *   plano  → o que a EMPRESA contratou (o cliente que paga só o CRM não vê
 *            agente de IA nem sequer como aba desabilitada).
 *
 * Esconder por papel um módulo que o cliente não comprou é o erro clássico: o
 * admin dele — que é o próprio dono — passa a ver a porta de um produto que
 * ninguém vendeu, e a primeira pergunta na reunião vira "por que isso está
 * cinza pra mim?".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * POR QUE É LIDO NO SERVIDOR, E NÃO NO CLIENTE
 *
 * A primeira versão usava `NEXT_PUBLIC_FEATURE_*`. Esse prefixo faz o Next
 * SUBSTITUIR o valor dentro do código durante o BUILD — não é lido em runtime.
 * Como um mesmo build é publicado em vários Workers (`wrangler deploy --env
 * acme`, `--env acme2`), todos herdariam os flags de quem estava no
 * `.env` na hora de compilar: dois clientes com planos diferentes receberiam
 * o mesmo menu.
 *
 * Agora as variáveis são comuns (sem `NEXT_PUBLIC_`), lidas pelo layout —
 * que é Server Component — e passadas como prop até a navegação. Um build,
 * N deploys, cada um com o seu plano. Ligar um módulo pra um cliente é mudar
 * o `vars` daquele environment e redeployar só ele.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Módulo VENDIDO À PARTE: desligado a menos que explicitamente ligado. */
function optIn(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Módulo que JÁ VEM no plano base: ligado a menos que explicitamente tirado.
 *  A diferença importa: um add-on esquecido no `.env` tem que aparecer como
 *  não-contratado, e um módulo do base esquecido no `.env` não pode sumir. */
function optOut(value: string | undefined): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off');
}

export interface PlanFeatures {
  /** Agente de IA: auto-resposta, personalidade, transferência. Add-on pago. */
  aiAgent: boolean;
  /**
   * Mensagem agendada MANUAL: o atendente escreve o texto e escolhe a hora
   * para um lead específico ("Bom dia, conseguiu ver?" às 9h). Não tem IA
   * envolvida — é um lembrete que o sistema entrega no horário.
   *
   * É do PLANO BASE (opt-out): faz parte do CRM de atendimento, como o kanban.
   */
  scheduling: boolean;
  /**
   * Canal de E-MAIL: caixa do Gmail conectada por OAuth, leads de e-mail no
   * kanban, envio pelo card.
   *
   * Nasceu para o fluxo de BDR de um sócio (prospecção fria por e-mail) e
   * ficou LIGADO PARA TODOS por não ter flag — clientes que vendem por WhatsApp
   * viam o CRM dividido em "WhatsApp | E-mail" e um item de e-mail em
   * Configurações, sem nunca terem contratado nada disso.
   *
   * Add-on, e opt-in: quem não pediu não vê.
   */
  email: boolean;
  /**
   * Follow-up AUTOMÁTICO: o sistema decide sozinho o que mandar, com base no
   * contexto da conversa, e só dispara quando o lead fica inativo.
   *
   * Add-on PAGO, e separado do agendamento manual de propósito: o que se cobra
   * aqui é a automação e a leitura de contexto, não a entrega programada.
   */
  followups: boolean;
  /** Textos rápidos + gerador de variações anti-bloqueio. */
  quickReplies: boolean;
  /** Ranking de atendentes. */
  ranking: boolean;
  /** Unidades (filiais) do cliente. Add-on: quem tem uma sede só não deve
   *  pagar o custo de um seletor que não muda nada. */
  units: boolean;
}

export type FeatureKey = keyof PlanFeatures;

/**
 * Lê o plano do ambiente. **Só chame no servidor** — no browser
 * `process.env` não tem estas chaves e tudo voltaria desligado.
 *
 * No Worker, os valores vêm dos `vars` daquele environment no wrangler.jsonc.
 * Em dev, do `.env`.
 */
export function readPlanFeatures(): PlanFeatures {
  return {
    // Add-ons pagos — nascem desligados.
    aiAgent: optIn(process.env.FEATURE_AI_AGENT),
    // Do plano base: só some se alguém desligar de propósito.
    scheduling: optOut(process.env.FEATURE_SCHEDULING),
    followups: optIn(process.env.FEATURE_FOLLOWUPS),
    email: optIn(process.env.FEATURE_EMAIL),
    quickReplies: optIn(process.env.FEATURE_QUICK_REPLIES),
    // Parte do CRM base — só some se alguém desligar de propósito.
    ranking: optOut(process.env.FEATURE_RANKING),
    units: optIn(process.env.FEATURE_UNITS),
  };
}

/** Plano mínimo — usado como fallback quando a prop não chegou. Conservador
 *  de propósito: na dúvida, mostra só o que todo mundo comprou. */
export const BASE_PLAN: PlanFeatures = {
  aiAgent: false,
  scheduling: true,
  followups: false,
  email: false,
  quickReplies: false,
  ranking: true,
  units: false,
};

/**
 * Qual módulo cada rota exige. É a fonte única do bloqueio no SERVIDOR.
 *
 * Esconder o item do menu não é bloquear: as páginas e as APIs continuavam
 * abrindo por URL direta — `/agente-ia` respondia 200 num deploy que não tinha
 * o agente contratado, e `/api/admin/ai-config` também. Gating só na navegação
 * é decoração.
 *
 * A ordem importa: o primeiro prefixo que casar decide.
 */
export const FEATURE_PATHS: Array<{ prefix: string; feature: FeatureKey }> = [
  { prefix: '/agente-ia', feature: 'aiAgent' },
  { prefix: '/api/admin/ai-config', feature: 'aiAgent' },
  { prefix: '/textos-rapidos', feature: 'quickReplies' },
  { prefix: '/api/admin/quick-replies', feature: 'quickReplies' },
  { prefix: '/agendamentos', feature: 'scheduling' },
  { prefix: '/api/scheduled-messages', feature: 'scheduling' },
  { prefix: '/ranking', feature: 'ranking' },
  { prefix: '/api/ranking', feature: 'ranking' },
  { prefix: '/configuracoes/unidades', feature: 'units' },
  { prefix: '/api/admin/units', feature: 'units' },
  { prefix: '/configuracoes/email', feature: 'email' },
  { prefix: '/api/email', feature: 'email' },
];

/** Módulo exigido por esta rota, ou null quando a rota é do plano base. */
export function featureForPath(pathname: string): FeatureKey | null {
  const hit = FEATURE_PATHS.find(
    p => pathname === p.prefix || pathname.startsWith(`${p.prefix}/`)
  );
  return hit?.feature ?? null;
}

/** True quando a rota está liberada para este plano. */
export function isPathAllowed(pathname: string, features: PlanFeatures): boolean {
  const needed = featureForPath(pathname);
  return needed === null || features[needed];
}

/** Nome comercial de cada módulo, pra mensagem de bloqueio e proposta. */
export const FEATURE_LABELS: Record<FeatureKey, string> = {
  aiAgent: 'Agente de IA',
  scheduling: 'Mensagens agendadas',
  followups: 'Follow-ups automáticos',
  email: 'Canal de e-mail',
  quickReplies: 'Textos rápidos',
  ranking: 'Ranking de atendentes',
  units: 'Unidades (filiais)',
};
