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

/** Texto falável cortado no fim de uma frase, pra respostas longas não serem cortadas no meio. */
export function spokenExcerpt(text, max = MAX_SPOKEN_CHARS) {
  const clean = speakableText(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > max / 2 ? cut.slice(0, end + 1) : cut;
}

/** PCM cru do TTS (audio/L16;rate=24000) ganha cabeçalho WAV; WAV já pronto passa direto. */
export function toWav(buffer, mimeType = '') {
  if (!/L16|pcm/i.test(mimeType)) return buffer;
  const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + buffer.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(buffer.length, 40);
  return Buffer.concat([header, buffer]);
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

// Saudações que disparam a rotina de bom dia (texto ou áudio transcrito), ex:
// "bom dia", "bom dia Jarvis", "bom dia crianças, papai chegou", "ei Jarvis, tá aí?".
// Só vale se a mensagem for TODA uma saudação — "bom dia, me lembra de X" segue pro modelo.
// O texto já chega normalizado (minúsculo, sem acento/pontuação, espaços únicos), então a regex usa espaço literal.
const FILLER = '(?:jarvis|crianca|criancas|pessoal|senhor|amigo|meu amigo|tudo bem|papai chegou|o papai chegou|cheguei|ja cheguei)';
const OPENER = '(?:(?:ei|e ai|oi|ola|opa|fala) )?';
const GREETING_RE = new RegExp(
  '^' + OPENER + '(?:jarvis )?bom ?dia(?: ' + FILLER + ')*$|' +
    '^(?:o )?papai chegou$|' +
    '^' + OPENER + 'jarvis (?:(?:ta|esta|voce ta|voce esta) )?(?:ai|acordado|ouvindo|por ai)$',
);

/** Minúsculo, sem acento nem pontuação; "Jarvi/Garvis/carvice" (erros de transcrição) viram "jarvis". */
function normalizeSpeech(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b[jgc][aeiouy]r[vw][a-z]{1,3}\b/g, 'jarvis')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGreeting(text) {
  const normalized = normalizeSpeech(text);
  return normalized.length > 0 && normalized.length <= 70 && GREETING_RE.test(normalized);
}

/** A fala chama o Jarvis pelo nome? (palavra de ativação do app que fica sempre ouvindo) */
export function hasWakeWord(text) {
  return / jarvis /.test(` ${normalizeSpeech(text)} `);
}
