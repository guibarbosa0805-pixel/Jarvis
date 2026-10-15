import express from 'express';
import { getBrain } from './jarvis.js';
import { findPersonById } from './people.js';
import { createStore } from './store.js';
import { createMemory, readableMessages } from './memory.js';
import { redeemPairingCode, personIdFromToken, attachClient } from './desktop.js';
import { hasLink, MAX_SPOKEN_CHARS, wavToOggOpus } from './voice.js';

const TAG = '[painel]';
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const VOICE_TIMEOUT_MS = 60000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Tempo esgotado gerando a voz')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function friendlyError(err) {
  const overloaded = err?.status === 503 || /UNAVAILABLE|high demand/i.test(String(err?.message));
  return overloaded ? 'O serviço de IA está com muita demanda agora, tente de novo em um minutinho.' : 'Deu um erro aqui do meu lado, tente de novo.';
}

/**
 * API do app do computador. Fica fora da senha do painel: usa token por aparelho
 * (gerado no pareamento por código). Sem cookies, então CORS aberto não expõe nada.
 */
export function createDesktopRouter() {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  router.post('/pair', express.json(), (req, res) => {
    const result = redeemPairingCode(req.body?.code);
    if (result.error) return res.status(400).json({ error: result.error });
    const person = findPersonById(result.personId);
    res.json({ token: result.token, name: person?.displayName ?? '' });
  });

  router.use((req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const person = findPersonById(personIdFromToken(token));
    if (!person) return res.status(401).json({ error: 'Aparelho não autorizado. Conecte de novo com um código.' });
    req.person = person;
    next();
  });

  router.get('/me', (req, res) => {
    res.json({ name: req.person.displayName });
  });

  // A mesma conversa do WhatsApp: o app abre já mostrando o que foi dito lá.
  router.get('/history', (req, res) => {
    res.json(readableMessages(createMemory(req.person.id).loadHistory()));
  });

  router.get('/tasks', (req, res) => {
    res.json(createStore(req.person.id).listPending());
  });

  // Canal de eventos: o servidor manda ações ao PC (tocar música, notificações).
  router.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    attachClient(req.person.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => clearInterval(ping));
  });

  async function reply(req, res, text, extra = {}) {
    const person = req.person;
    try {
      const brain = getBrain(person);
      const call = req.query.call === '1';
      const result = await brain.converse(text, undefined, { channel: 'desktop', call });
      const body = { ...extra, text: result.text, actions: result.actions };

      // Em chamada sempre fala (links saem da fala e ficam só no texto da tela).
      const wantVoice = call || result.voice || extra.spoken === true || req.query.voice === '1';
      if (wantVoice && (call || !hasLink(result.text)) && result.text.length <= MAX_SPOKEN_CHARS) {
        try {
          const ogg = await withTimeout(brain.speak(result.text), VOICE_TIMEOUT_MS);
          if (ogg) body.audio = ogg.toString('base64');
        } catch (err) {
          console.error(`${TAG} [${person.id}] Voz indisponível no app:`, err?.message || err);
        }
        // O app usa uma voz local (se houver) ou avisa, em vez de ficar mudo.
        if (!body.audio) body.voiceUnavailable = true;
      }
      delete body.spoken;
      res.json(body);
    } catch (err) {
      console.error(`${TAG} [${person.id}] Erro no app do computador:`, err?.message || err);
      res.status(502).json({ error: friendlyError(err) });
    }
  }

  router.post('/message', express.json({ limit: '100kb' }), (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Mensagem vazia.' });
    return reply(req, res, text);
  });

  // Áudio gravado no app (webm/opus do navegador): transcreve e responde, por voz também.
  router.post('/audio', express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Áudio vazio.' });
    try {
      const ogg = await wavToOggOpus(req.body, req.get('content-type') || '');
      const transcript = await getBrain(req.person).transcribeAudio(ogg, 'audio/ogg');
      if (!transcript) return res.json({ transcript: '', text: 'Não consegui entender o áudio, pode tentar de novo?', actions: [] });
      return reply(req, res, transcript, { transcript, spoken: true });
    } catch (err) {
      console.error(`${TAG} [${req.person.id}] Erro ao processar áudio do app:`, err?.message || err);
      res.status(502).json({ error: friendlyError(err) });
    }
  });

  return router;
}
