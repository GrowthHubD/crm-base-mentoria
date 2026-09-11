/**
 * Identidade do produto — fonte única.
 *
 * Este CRM é white-label: a mesma base vai ao mercado com a marca de quem
 * revende. A marca da origem (Sistema Motel) estava espalhada por título da
 * aba, login, notificações de falha e prompts de IA — centralizar aqui é o que
 * impede a próxima derivação de repetir o problema.
 *
 * Tudo aceita override por variável de ambiente, então trocar a marca de um
 * deploy NÃO exige alterar código nem rebuildar a imagem: basta o `.env` (ou
 * `wrangler secret`) daquela instância.
 */

/** Nome curto — sidebar, título da aba, tela de login, notificações.
 *  Default = Lidy, a marca do produto. A identidade visual (paleta escura com
 *  azuis saturados, em `globals.css`) é a mesma e faz parte da marca. */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Lidy';

/** Nome completo — cabeçalhos, documentos. */
export const APP_FULL_NAME = process.env.NEXT_PUBLIC_APP_FULL_NAME || APP_NAME;

/**
 * Nome do cliente daquela instância — o que separa "LIDY - Acme" de
 * "LIDY - Fulano" na aba do navegador.
 *
 * É FUNÇÃO e não const, e a variável NÃO tem `NEXT_PUBLIC_`, pelo mesmo motivo
 * do gating de plano: `NEXT_PUBLIC_*` é substituído durante o BUILD, e um único
 * build é publicado em todos os Workers. Fixar aqui daria a todos os clientes o
 * nome de quem estava no `.env` na hora de compilar. Lida em runtime, cada
 * environment do wrangler traz o seu.
 *
 * **Só chame no servidor** — no browser `process.env` não tem esta chave.
 */
export function readClientName(): string {
  return process.env.APP_CLIENT_NAME?.trim() || '';
}

/**
 * Título da aba: `LIDY - Acme`, ou só `LIDY` quando a instância não nomeia
 * cliente (demo, dev). A marca vai em caixa alta porque é assim que ela é
 * desenhada no logo; o nome do cliente mantém a capitalização recebida.
 */
export function pageTitle(): string {
  const marca = APP_NAME.toUpperCase();
  const cliente = readClientName();
  return cliente ? `${marca} - ${cliente}` : marca;
}

/**
 * Linha de apoio abaixo do nome na tela de login.
 *
 * Fala de CRM, não de IA, de propósito: o agente é um add-on pago e a maior
 * parte das instalações não vai ter um. Vender "agente inteligente" na porta
 * de entrada promete o que o plano base não entrega.
 */
export const APP_TAGLINE =
  process.env.NEXT_PUBLIC_APP_TAGLINE || 'CRM de atendimento no WhatsApp';

/** Versão curta pra sidebar, onde não cabe a linha inteira. */
export const APP_TAGLINE_SHORT =
  process.env.NEXT_PUBLIC_APP_TAGLINE_SHORT || 'CRM de Atendimento';

/** Descrição usada no metadata da página. */
export const APP_DESCRIPTION =
  process.env.NEXT_PUBLIC_APP_DESCRIPTION || 'CRM de atendimento por WhatsApp com IA';

/** Segmento do cliente, em uma palavra. Alimenta os prompts de IA que precisam
 *  falar a língua do negócio (ex.: "clínica", "loja", "imobiliária").
 *  Vazio = o prompt fica genérico ("atendimento"). */
export const APP_BUSINESS_SEGMENT = process.env.APP_BUSINESS_SEGMENT || '';

/** Domínio de e-mail usado nos placeholders de formulário e no seed. */
export const APP_EMAIL_DOMAIN = process.env.APP_EMAIL_DOMAIN || 'crm.local';
