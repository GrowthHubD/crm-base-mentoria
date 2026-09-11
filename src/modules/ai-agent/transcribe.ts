/**
 * Transcrição de áudio inbound pra texto via Whisper.
 *
 * Por que existe: o WhatsApp não dá pro modelo de IA (Gemini via OpenRouter)
 * "ouvir" áudio de voz. A gente baixa o arquivo da URL servida pelo nosso
 * storage (depois de resolveMediaBlob), manda pro Whisper, e usa o texto
 * resultante como `body` da mensagem inbound — daí a IA responde igual a
 * uma mensagem de texto comum.
 *
 * Falhas não derrubam o fluxo: retorna `null` e o caller mantém a mensagem
 * salva sem texto (bubble mostra só o AudioPlayer; preview no kanban fica
 * "🎤 Áudio").
 */
import OpenAI from 'openai';
import { logger } from '@/lib/logger';

const API_KEY = process.env.OPENAI_API_KEY;
// Modelo padrão: whisper-1. Pode ser sobrescrito via env pra testar gpt-4o-mini-transcribe etc.
const MODEL = process.env.TRANSCRIBE_MODEL ?? 'whisper-1';
// Limite de áudios muito longos (Whisper aceita 25MB / ~25min). Pra WhatsApp
// PTT é raro passar de 2min, mas o cap evita custo absurdo se vier algo
// gigante. Áudios maiores caem fora silenciosamente.
const MAX_AUDIO_BYTES = parseInt(process.env.TRANSCRIBE_MAX_BYTES ?? `${10 * 1024 * 1024}`, 10);

let _client: OpenAI | null = null;
function getClient(): OpenAI | null {
  if (!API_KEY) return null;
  if (!_client) _client = new OpenAI({ apiKey: API_KEY });
  return _client;
}

export function isTranscribeAvailable(): boolean {
  return !!API_KEY;
}

/**
 * Baixa áudio da URL e transcreve com Whisper. Retorna o texto ou null se
 * falhar / não estiver configurado.
 *
 * `language` é dica pro modelo (ISO-639-1). Default 'pt' (português brasileiro).
 */
export async function transcribeAudio(
  audioUrl: string,
  mimeType: string | null,
  options: { language?: string } = {}
): Promise<string | null> {
  const client = getClient();
  if (!client) {
    logger.warn('[transcribe] OPENAI_API_KEY ausente — pulando transcrição');
    return null;
  }
  if (!/^https?:\/\//i.test(audioUrl)) {
    logger.warn({ audioUrl }, '[transcribe] URL inválida — pulando');
    return null;
  }

  const startedAt = Date.now();
  try {
    const res = await fetch(audioUrl);
    if (!res.ok) {
      logger.warn({ audioUrl, status: res.status }, '[transcribe] download falhou');
      return null;
    }
    const arr = await res.arrayBuffer();
    if (arr.byteLength === 0) {
      logger.warn({ audioUrl }, '[transcribe] arquivo vazio');
      return null;
    }
    if (arr.byteLength > MAX_AUDIO_BYTES) {
      logger.warn({ audioUrl, bytes: arr.byteLength, max: MAX_AUDIO_BYTES }, '[transcribe] áudio muito grande — pulando');
      return null;
    }

    // Whisper precisa de um File com nome+extension reconhecível. Inferimos a
    // partir do mimetype; default opus (formato padrão do WhatsApp PTT).
    const ext = extFromMime(mimeType);
    const fileName = `inbound.${ext}`;
    const file = new File([new Uint8Array(arr)], fileName, { type: mimeType ?? 'audio/ogg' });

    const out = await client.audio.transcriptions.create({
      file,
      model: MODEL,
      language: options.language ?? 'pt',
      response_format: 'text',
    });

    // response_format=text retorna string crua direto; SDK pode encapsular em {text}.
    const text = typeof out === 'string' ? out : (out as { text?: string }).text ?? '';
    const trimmed = text.trim();
    const ms = Date.now() - startedAt;
    if (!trimmed) {
      logger.info({ audioUrl, bytes: arr.byteLength, ms }, '[transcribe] resultado vazio');
      return null;
    }
    logger.info(
      { audioUrl, bytes: arr.byteLength, ms, length: trimmed.length, preview: trimmed.slice(0, 80) },
      '[transcribe] OK'
    );
    return trimmed;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : err, audioUrl },
      '[transcribe] falha — mensagem segue sem texto'
    );
    return null;
  }
}

function extFromMime(mime: string | null): string {
  if (!mime) return 'ogg';
  const m = mime.toLowerCase();
  if (m.includes('opus') || m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  return 'ogg';
}
