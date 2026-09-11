/**
 * Suporte IA pra Atendentes — assistente DENTRO do CRM (tab "Suporte IA").
 *
 * Diferente do `generateReplyForLead`, que redige a mensagem que VAI PRO CLIENTE,
 * essa função produz uma DICA pro atendente humano. A IA olha o histórico
 * recente da conversa, a pergunta do atendente (ex: "qual o próximo passo aqui?"),
 * e responde com orientação prática EM 1ª PESSOA pro atendente — não copy/paste
 * pro cliente.
 *
 * Distinção crítica:
 *   - Resposta ao cliente (2ª pessoa): "Oi João, segue a informação que você pediu..."
 *   - Sugestão ao atendente (1ª pessoa): "Sugiro responder a dúvida sobre prazo
 *     primeiro — foi o que travou ele. O João já demonstrou interesse e disse
 *     que ia confirmar — vale dar um tempo antes de insistir."
 *
 * O atendente recebe a sugestão e DECIDE se usa ou adapta. Não é mensagem pronta.
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { logger } from '@/lib/logger';
import { reads as messagesReads } from '@/modules/messages/service';
import { reads as leadReads } from '@/modules/leads/service';
import { getConfigRow } from './queries';
import { sanitizeForPrompt } from './prompts';

const MODEL_ID = process.env.AI_MODEL_ID ?? 'google/gemini-3-flash-preview';
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
const MAX_TOKENS = 600;
const BUSINESS_NAME = process.env.BUSINESS_NAME?.trim() || 'a empresa';

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!API_KEY) return null;
  if (!_client) {
    _client = new OpenAI({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXTAUTH_URL ?? 'http://localhost:3000',
        // ASCII only — header HTTP recusa Unicode (em-dash U+2014 quebrava
        // toda chamada com "Cannot convert argument to a ByteString").
        'X-Title': 'CRM - Suporte IA',
      },
    });
  }
  return _client;
}

/**
 * Template default do prompt do Suporte IA. Usado quando a unidade não
 * customizou via UI. Variables expandidas em runtime: {{businessName}}.
 *
 * Mantenha o tom: 1ª pessoa ("sugiro", "vale", "atenção a"), focado em AÇÃO
 * do atendente, sem redigir mensagem pro cliente.
 */
export const DEFAULT_SUPPORT_PROMPT = `Você é um assistente INTERNO que orienta ATENDENTES HUMANOS de {{businessName}}.

Seu público NÃO é o cliente — é o colaborador que está atendendo o cliente no WhatsApp. Ele te pergunta o que fazer e você responde EM 1ª PESSOA pro atendente, em PT-BR, com tom direto e prático.

REGRAS DE OURO:
1. NUNCA redija a mensagem pronta pro cliente. NÃO use o nome do cliente como vocativo. NÃO escreva "Para garantir o seu, Fulano...". Isso é trabalho do atendente.
2. SEMPRE oriente o atendente: "Sugiro X porque Y", "Vale perguntar Z antes de avançar", "Atenção: o cliente já disse W".
3. Seja CURTO (2-5 frases). Frase única quando possível.
4. Aponte CONTEXTO que o atendente pode ter perdido (mudanças de assunto, sinais de objeção, mensagens antigas relevantes).
5. Quando faltar dado, diga o que faltou ("não sei essa informação aqui — confirme antes de responder").
6. Se a IA principal já respondeu o cliente recentemente, comente isso ("a IA já respondeu X e está esperando retorno").
7. Não invente preço, política, prazo ou regra. Se não souber, peça pra confirmar com a gerência ou consultar o painel.

FORMATO DA RESPOSTA:
- Inicie com a sugestão prática (a primeira ação concreta).
- Se houver risco/objeção, alerte em 1 frase.
- Termine com pergunta de follow-up só se ela ajudar o atendente a decidir.

Exemplos do que NÃO fazer:
RUIM: "Olá João, obrigado pelo contato, seguem as informações..." (mensagem pronta pro cliente)
RUIM: "Para confirmar, peça que ele envie o comprovante."  (sem contexto/razão)

Exemplos do que FAZER:
BOM: "Sugiro responder a dúvida sobre prazo primeiro — foi o que travou ele. Vale confirmar o dado no painel antes."
BOM: "Atenção: ele citou que vai falar com a esposa e ainda não voltou. Antes de insistir, oferece um tempo — reduz a pressão."
BOM: "Não tenho essa informação aqui — confirme com a gerência antes de responder."`;

export interface SupportSuggestionResult {
  /** Orientação pro ATENDENTE (1ª pessoa, coaching). Sempre presente. */
  advice: string;
  /** Mensagem pronta pra ENVIAR ao cliente (2ª pessoa). Vazio quando a IA não
   * produziu rascunho (ex: pergunta puramente de coaching, fallback, erro). */
  draft: string;
  fallback: boolean;
}

/**
 * Bloco APENDADO ao prompt de coaching (mesmo que o admin tenha customizado o
 * `supportSystemPrompt`). Força a saída em DUAS seções parseáveis: o conselho
 * pro atendente E um rascunho pronto pro cliente. A última instrução vence, então
 * isso governa o FORMATO sem reescrever o conteúdo do coaching.
 */
const DRAFT_FORMAT_BLOCK = `

---
FORMATO OBRIGATÓRIO DA SAÍDA — responda SEMPRE com estas DUAS seções, exatamente nesta ordem e com estes marcadores literais:

[CONSELHO]
<sua orientação pro atendente, seguindo TODAS as regras acima (1ª pessoa, curto, aponte contexto/risco). NÃO é a mensagem do cliente.>

[CLIENTE]
<a mensagem PRONTA pra enviar ao cliente, escrita em 2ª pessoa, tom natural de WhatsApp, SEM rótulo de cargo, SEM assinatura. Baseie-se em TODO o histórico da conversa, não só na última mensagem. NÃO invente preço, política, horário ou regra — se faltar um dado, escreva a mensagem de forma geral ou peça o dado ao cliente de forma natural. Se a pergunta do atendente for puramente interna (ex: "esse lead vale a pena?") e não houver mensagem que faça sentido enviar, escreva apenas: (sem rascunho)>`;

/**
 * Gera uma sugestão de orientação pro atendente sobre o lead.
 *
 * @param leadId  Lead que o atendente está atendendo.
 * @param questionRaw  O que o atendente perguntou (ex: "qual o próximo passo aqui?").
 *                     Se vazio, o caller deve ter fornecido fallback (ex: última msg inbound).
 */
export async function generateSupportSuggestion(
  leadId: string,
  questionRaw: string
): Promise<SupportSuggestionResult> {
  const lead = await leadReads.getById(leadId);
  if (!lead) throw new Error(`Lead ${leadId} não encontrado`);

  const businessName = BUSINESS_NAME;

  const cfg = await getConfigRow();
  const promptTemplate =
    (cfg?.supportSystemPrompt?.trim() || DEFAULT_SUPPORT_PROMPT)
      .replaceAll('{{businessName}}', businessName) + DRAFT_FORMAT_BLOCK;

  const question = sanitizeForPrompt(questionRaw).slice(0, 500);

  // Contexto: lê o arco recente da conversa (não só a última msg). Janela larga
  // o suficiente pra IA pegar mudanças de assunto, objeções e o que já foi
  // oferecido — base tanto pro conselho quanto pro rascunho.
  const history = await messagesReads.conversation(leadId, 30);
  const historyLines = history
    .map((m) => {
      const tag =
        m.sender === 'lead' ? 'CLIENTE' :
        m.sender === 'ai' ? 'IA' :
        m.sender === 'human' ? `ATENDENTE${m.senderName ? ` (${m.senderName})` : ''}` :
        m.sender === 'owner' ? 'DONO' : 'SISTEMA';
      const body = (m.body ?? '').trim() || (m.type === 'image' ? '[imagem]' :
        m.type === 'audio' ? '[áudio]' :
        m.type === 'video' ? '[vídeo]' :
        m.type === 'document' ? '[documento]' : '');
      return `[${tag}] ${body}`;
    })
    .filter((l) => l.length > 3)
    .slice(-25);

  const userBlock = [
    `Lead: ${lead.name ?? lead.phone ?? leadId}`,
    `Status atual no funil: ${lead.status}`,
    '',
    'HISTÓRICO RECENTE (mais antiga primeiro):',
    historyLines.length > 0 ? historyLines.join('\n') : '(sem mensagens)',
    '',
    `PERGUNTA DO ATENDENTE: ${question || '(usar a última mensagem do cliente como pergunta implícita — sugira o próximo passo)'}`,
  ].join('\n');

  const client = getClient();
  if (!client) {
    return {
      advice: 'Suporte IA indisponível agora (sem credenciais OpenRouter). Use seu julgamento — ou peça apoio do gerente.',
      draft: '',
      fallback: true,
    };
  }

  try {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: promptTemplate },
      { role: 'user', content: userBlock },
    ];
    const completion = await client.chat.completions.create({
      model: MODEL_ID,
      messages,
      temperature: 0.6,
      max_tokens: MAX_TOKENS,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    if (!text) {
      return {
        advice: 'Não consegui gerar uma sugestão útil dessa vez. Tente reformular a pergunta.',
        draft: '',
        fallback: true,
      };
    }
    const { advice, draft } = parseSupportOutput(text);
    return { advice, draft, fallback: false };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, leadId },
      '[ai-support] geração falhou'
    );
    return {
      advice: 'Não consegui consultar a IA agora. Tenta de novo em alguns segundos.',
      draft: '',
      fallback: true,
    };
  }
}

/**
 * Separa a saída do modelo nas seções [CONSELHO] e [CLIENTE]. Tolerante:
 * - Se o marcador [CLIENTE] não aparecer, trata tudo como conselho (draft vazio).
 * - "(sem rascunho)" (sinal explícito do modelo) vira draft vazio.
 * - Remove os marcadores literais do texto exibido.
 */
export function parseSupportOutput(raw: string): { advice: string; draft: string } {
  const text = raw.trim();
  const clientMarker = /\[\s*CLIENTE\s*\]/i;
  const idx = text.search(clientMarker);

  if (idx === -1) {
    // Sem seção de cliente — tudo é conselho.
    return { advice: stripAdviceMarker(text), draft: '' };
  }

  const advice = stripAdviceMarker(text.slice(0, idx));
  let draft = text.slice(idx).replace(clientMarker, '').trim();

  // Modelo sinalizou que não há mensagem que faça sentido enviar.
  if (/^\(?\s*sem rascunho\s*\)?\.?$/i.test(draft)) draft = '';

  return { advice, draft };
}

function stripAdviceMarker(s: string): string {
  return s.replace(/\[\s*CONSELHO\s*\]/i, '').trim();
}
