/**
 * Conversão de áudio → ogg/opus para mensagens de voz no WhatsApp.
 *
 * MediaRecorder do Chrome/Edge grava em `audio/webm; codecs=opus`, o Safari
 * (iOS/macOS) em `audio/mp4` (AAC), e uploads podem vir em ogg/vorbis, mp3, wav.
 * WhatsApp (via uazapi) só renderiza balão de voz (PTT) — e o iOS só decodifica —
 * quando o mimetype é `audio/ogg; codecs=opus` E o container é OGG. Formatos
 * crus (ex: ogg/vorbis) tocam no Android tolerante mas dão "áudio não disponível"
 * no iOS. Re-encode com libopus 32k/48kHz/mono garante PTT em qualquer device.
 *
 * O ffmpeg detecta o container de entrada pelo conteúdo (ignora a extensão do
 * arquivo temporário), então esta função aceita QUALQUER áudio de entrada.
 *
 * Refs:
 *   - Baileys issue #1828, #1745 (mimetype EXATO 'audio/ogg; codecs=opus')
 *   - whatsapp-web.js PR #1956 (parâmetros 32k/48kHz/mono)
 *   - ultramsg blog (-application voip otimiza pra voz)
 */
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';

let ffmpegPath: string | null = null;
try {
  // Lazy resolve em runtime — em edge runtime falha, em Node OK
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpegPath = ffmpegInstaller.path;
} catch {
  // Sem o package, tenta `ffmpeg` no PATH
  ffmpegPath = 'ffmpeg';
}

/**
 * Converte QUALQUER áudio (webm/opus, mp4/aac, ogg/vorbis, mp3, wav…) → ogg/opus
 * com re-encode para o formato que o WhatsApp aceita como PTT (push-to-talk /
 * mensagem de voz) e que o iOS consegue decodificar.
 *
 * Throws se o ffmpeg falhar.
 */
export async function transcodeToOggOpus(input: Buffer): Promise<Buffer> {
  const id = randomUUID();
  const inputPath = join(tmpdir(), `audio-in-${id}`);
  const outputPath = join(tmpdir(), `audio-out-${id}.ogg`);

  try {
    await fs.writeFile(inputPath, input);

    await new Promise<void>((resolve, reject) => {
      const args = [
        '-y',
        '-i', inputPath,
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-ar', '48000',
        '-ac', '1',
        '-application', 'voip',
        '-map_metadata', '-1',
        '-f', 'ogg',
        outputPath,
      ];
      const proc = spawn(ffmpegPath || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += String(d);
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
      });
    });

    return await fs.readFile(outputPath);
  } finally {
    fs.unlink(inputPath).catch(() => {});
    fs.unlink(outputPath).catch(() => {});
  }
}

/**
 * Recebe data URI (`data:audio/webm;base64,...`), converte pra ogg e retorna
 * data URI novo (`data:audio/ogg;codecs=opus;base64,...`). Se já for ogg,
 * retorna sem mexer. Em erro, devolve o original (caller usa como fallback).
 */
export async function ensureOggDataUri(dataUri: string): Promise<string> {
  const match = dataUri.match(/^data:([^;]+)(;[^,]+)?,(.+)$/);
  if (!match) return dataUri;
  const mime = match[1].toLowerCase();
  const base64 = match[3];

  if (mime.includes('ogg')) return dataUri;
  if (!mime.includes('webm') && !mime.includes('audio')) return dataUri;

  try {
    const inputBuffer = Buffer.from(base64, 'base64');
    const t0 = Date.now();
    const oggBuffer = await transcodeToOggOpus(inputBuffer);
    const ms = Date.now() - t0;
    const oggB64 = oggBuffer.toString('base64');
    logger.info(
      { inputBytes: inputBuffer.length, outputBytes: oggBuffer.length, ms },
      '[audio-convert] webm→ogg OK'
    );
    return `data:audio/ogg;codecs=opus;base64,${oggB64}`;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, '[audio-convert] webm→ogg falhou, devolvendo original');
    return dataUri;
  }
}
