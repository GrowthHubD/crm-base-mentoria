/**
 * Gerador de variações de texto rápido via LLM (OpenRouter / Gemini Flash).
 *
 * Motivação anti-ban: a mesma saudação/template saindo byte-a-byte idêntica
 * pra dezenas de contatos novos é assinatura de spam pro WhatsApp. Aqui a IA
 * produz N paráfrases naturais do mesmo texto pra o atendente cadastrar como
 * variações — o sistema sorteia uma a cada uso.
 *
 * REGRA CRÍTICA: dados sensíveis (CNPJ, chave PIX, valores, links, números)
 * NÃO podem ser alterados. A variação muda a EMBALAGEM (saudação, ordem,
 * sinônimos), nunca o DADO. O prompt reforça isso; ainda assim o atendente
 * revê antes de salvar.
 */
import OpenAI from 'openai';
import { logger } from '@/lib/logger';
import { APP_NAME, APP_BUSINESS_SEGMENT } from '@/lib/branding';

const MODEL_ID = process.env.AI_MODEL_ID ?? 'google/gemini-3-flash-preview';
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!API_KEY) return null;
  if (!_client) {
    _client = new OpenAI({
      apiKey: API_KEY,
      baseURL: BASE_URL,
      defaultHeaders: {
        'HTTP-Referer': process.env.NEXTAUTH_URL ?? 'http://localhost:3000',
        'X-Title': `${APP_NAME} - Variacoes`,
      },
    });
  }
  return _client;
}

// O segmento entra por configuração (APP_BUSINESS_SEGMENT). Vazio = prompt
// genérico. Sem isso o nicho do primeiro cliente vaza pro produto inteiro.
const SEGMENT = APP_BUSINESS_SEGMENT ? ` de ${APP_BUSINESS_SEGMENT}` : '';

const SYSTEM_PROMPT = `Você reescreve mensagens de atendimento${SEGMENT} em PT-BR, gerando VARIAÇÕES naturais da MESMA mensagem.

OBJETIVO: a empresa manda a mesma mensagem pra muitos clientes e isso parece spam pro WhatsApp. Você gera versões diferentes do MESMO conteúdo pra alternar o texto.

REGRAS OBRIGATÓRIAS:
1. PRESERVE 100% qualquer DADO: números, valores em R$, CNPJ, chave PIX, links/URLs, nomes próprios, horários. Copie-os EXATAMENTE como vieram. NUNCA invente, altere ou remova um dígito.
2. Varie só a EMBALAGEM: saudação, ordem das frases, sinônimos, pontuação, emojis (com moderação). O sentido e as informações têm que ser idênticos.
3. Mantenha o mesmo TOM e idioma (PT-BR informal de atendimento).
4. Tamanho parecido com o original. Não invente informação nova nem promessas.
5. Cada variação tem que ser claramente diferente das outras na forma.

SAÍDA: responda APENAS um array JSON de strings, sem texto fora do array. Ex: ["versão 1","versão 2"].`;

export interface GenerateVariationsResult {
  variations: string[];
  fallback: boolean;
}

/**
 * Gera `count` variações do texto. Retorna `fallback:true` (lista vazia) se a
 * IA não estiver configurada ou a chamada falhar — o caller decide o que fazer.
 */
export async function generateVariations(
  text: string,
  count = 4
): Promise<GenerateVariationsResult> {
  const original = (text ?? '').trim();
  if (!original) return { variations: [], fallback: true };
  const n = Math.max(1, Math.min(8, count));

  const client = getClient();
  if (!client) {
    logger.warn('[quick-replies.generate] OPENROUTER_API_KEY ausente — sem gerador');
    return { variations: [], fallback: true };
  }

  try {
    const completion = await client.chat.completions.create({
      model: MODEL_ID,
      temperature: 0.9,
      max_tokens: 1200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Gere ${n} variações da mensagem abaixo. Responda só o array JSON.\n\nMENSAGEM:\n"""\n${original}\n"""`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    const parsed = parseVariations(raw);
    // Remove qualquer eco do próprio original e duplicatas; cap em n.
    const seen = new Set<string>([original]);
    const out: string[] = [];
    for (const v of parsed) {
      const t = v.trim();
      if (!t || seen.has(t)) continue;
      seen.add(t);
      out.push(t);
      if (out.length >= n) break;
    }
    return { variations: out, fallback: out.length === 0 };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err },
      '[quick-replies.generate] falha ao gerar variações'
    );
    return { variations: [], fallback: true };
  }
}

/**
 * Extrai o array de strings da resposta do LLM. Tolerante: aceita o array
 * cru, ou cercado por ```json ... ```, ou com texto antes/depois (pega o
 * primeiro [ ... ] balanceado).
 */
function parseVariations(raw: string): string[] {
  const tryParse = (s: string): string[] | null => {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j) && j.every(x => typeof x === 'string')) return j as string[];
    } catch {
      /* ignore */
    }
    return null;
  };

  const direct = tryParse(raw.trim());
  if (direct) return direct;

  // tira cerca de código
  const fenced = raw.replace(/```(?:json)?/gi, '').trim();
  const fencedParsed = tryParse(fenced);
  if (fencedParsed) return fencedParsed;

  // pega o primeiro [...] do texto
  const start = fenced.indexOf('[');
  const end = fenced.lastIndexOf(']');
  if (start !== -1 && end > start) {
    const slice = fenced.slice(start, end + 1);
    const sliceParsed = tryParse(slice);
    if (sliceParsed) return sliceParsed;
  }
  return [];
}
