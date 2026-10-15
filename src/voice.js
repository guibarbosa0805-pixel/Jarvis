import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export const MAX_SPOKEN_CHARS = 900;

const URL_RE = /https?:\/\/\S+/g;

export function hasLink(text) {
  return /https?:\/\/\S+/.test(text);
}

/** Texto limpo pra ser lido em voz alta: sem emoji, markdown nem links. */
export function speakableText(text) {
  return text
    .replace(URL_RE, '')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, '')
    .replace(/[*_~`#>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/([.!?:]),/g, '$1')
    .replace(/([!?])\./g, '$1')
    .trim();
}

/**
 * Áudio do Gemini TTS -> OGG/Opus, o formato dos áudios de voz do WhatsApp.
 * Se vier PCM cru (audio/L16;rate=24000) o ffmpeg precisa saber o formato; WAV é autodetectado.
 */
export function wavToOggOpus(audioBuffer, mimeType = 'audio/wav') {
  const raw = /L16|pcm/i.test(mimeType);
  const rate = /rate=(\d+)/i.exec(mimeType)?.[1] ?? '24000';
  const inputArgs = raw ? ['-f', 's16le', '-ar', rate, '-ac', '1'] : [];
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      ...inputArgs,
      '-i', 'pipe:0',
      '-c:a', 'libopus', '-application', 'voip', '-b:a', '32k', '-ac', '1',
      '-f', 'ogg', 'pipe:1',
    ]);
    const chunks = [];
    let stderr = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0 && chunks.length) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(0, 200)}`));
    });
    p.stdin.on('error', () => {});
    p.stdin.end(audioBuffer);
  });
}
