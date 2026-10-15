import express from 'express';
import { randomBytes } from 'node:crypto';
import { getBrain, getJarvisNumber, mirrorDesktopExchange } from './jarvis.js';
import { findPersonById } from './people.js';
import { createStore } from './store.js';
import { createMemory, readableMessages } from './memory.js';
import { redeemPairingCode, personIdFromToken, attachClient, createDesktopRequest, pollDesktopRequest } from './desktop.js';
import { hasWakeWord, isGreeting, wavToOggOpus } from './voice.js';

const TAG = '[painel]';
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const SPEECH_TTL_MS = 2 * 60 * 1000;

function friendlyError(err) {
  const overloaded = err?.status === 503 || /UNAVAILABLE|high demand/i.test(String(err?.message));
  return overloaded ? 'O serviço de IA está com muita demanda agora, tente de novo em um minutinho.' : 'Deu um erro aqui do meu lado, tente de novo.';
}

// Falas sendo geradas: o texto da resposta vai na hora e o app busca o áudio em seguida,
// então a pessoa já lê a resposta enquanto a voz termina de ser sintetizada.
const speeches = new Map(); // id -> { personId, promise, expiresAt }

function startSpeech(person, brain, text) {
  const now = Date.now();
  for (const [id, job] of speeches) if (job.expiresAt < now) speeches.delete(id);
  const id = randomBytes(12).toString('hex');
  const startedAt = now;
  const promise = brain.synthesize(text).then(
    (wav) => {
      console.log(`${TAG} [${person.id}] App: voz pronta em ${Date.now() - startedAt} ms`);
      return wav;
    },
    (err) => {
      console.error(`${TAG} [${person.id}] Voz indisponível no app:`, err?.message || err);
      return null;
    },
  );
  speeches.set(id, { personId: person.id, promise, expiresAt: now + SPEECH_TTL_MS });
  return id;
}

/**
 * API do app do computador. Fica fora da senha do painel: usa token por aparelho
 * (gerado no pareamento). Sem cookies, então CORS aberto não expõe nada.
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

  // Pareamento pelo código que o Jarvis manda no WhatsApp (caminho manual).
  router.post('/pair', express.json(), (req, res) => {
    const result = redeemPairingCode(req.body?.code);
    if (result.error) return res.status(400).json({ error: result.error });
    const person = findPersonById(result.personId);
    res.json({ token: result.token, name: person?.displayName ?? '' });
  });

  // Pareamento iniciado no app: ele abre o WhatsApp com a mensagem pronta e espera a aprovação.
  router.post('/pair/start', (req, res) => {
    const { code, secret, expiresInMinutes } = createDesktopRequest();
    const number = getJarvisNumber();
    const message = `conectar computador ${code}`;
    res.json({
      code,
      secret,
      expiresInMinutes,
      message,
      number,
      link: number ? `https://wa.me/${number}?text=${encodeURIComponent(message)}` : '',
    });
  });

  router.get('/pair/status', (req, res) => {
    const result = pollDesktopRequest(String(req.query.code || ''), String(req.query.secret || ''));
    if (result.status !== 'approved') return res.json({ status: result.status });
    const person = findPersonById(result.personId);
    res.json({ status: 'approved', token: result.token, name: person?.displayName ?? '' });
  });

  router.use((req, res, next) => {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const person = findPersonById(personIdFromToken(token));
    if (!person) return res.status(401).json({ error: 'Aparelho não autorizado. Conecte de novo pelo WhatsApp.' });
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

  // Canal de eventos: o servidor manda ações ao PC (tocar música, notificações, conversa do WhatsApp).
  router.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 5000\n\n');
    attachClient(req.person.id, res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    res.on('close', () => clearInterval(ping));
  });

  // Áudio da resposta (WAV), gerado em paralelo enquanto o app já mostra o texto.
  router.get('/speech/:id', async (req, res) => {
    const job = speeches.get(req.params.id);
    if (!job || job.personId !== req.person.id) return res.status(404).json({ error: 'Fala não encontrada.' });
    const wav = await job.promise;
    speeches.delete(req.params.id);
    if (!wav) return res.status(503).json({ error: 'Voz indisponível agora.' });
    res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).send(wav);
  });

  async function reply(req, res, text, extra = {}) {
    const person = req.person;
    const startedAt = Date.now();
    try {
      const brain = getBrain(person);
      const call = req.query.call === '1';
      const result = await brain.converse(text, undefined, { channel: 'desktop', call });
      console.log(`${TAG} [${person.id}] App: resposta em ${Date.now() - startedAt} ms`);
      const body = { ...extra, text: result.text, actions: result.actions };
      // No app a voz é o padrão: só não fala se o app pedir texto (voice=0).
      if (req.query.voice !== '0') body.speechId = startSpeech(person, brain, result.text);
      res.json(body);
      // Mesma conversa nos dois lugares: a troca feita no computador fica registrada no WhatsApp.
      mirrorDesktopExchange(person, text, result.text).catch((err) =>
        console.error(`${TAG} [${person.id}] Falha ao copiar a conversa do app no WhatsApp:`, err?.message || err),
      );
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

  // Fala gravada no app (WAV do modo ouvindo, ou webm do botão de microfone).
  router.post('/audio', express.raw({ type: () => true, limit: MAX_AUDIO_BYTES }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Áudio vazio.' });
    const startedAt = Date.now();
    try {
      // Comprimir em Opus antes (~0,1 s) deixa o envio ao Gemini menor e a transcrição mais rápida.
      const ogg = await wavToOggOpus(req.body, req.get('content-type') || '');
      const transcript = await getBrain(req.person).transcribeAudio(ogg, 'audio/ogg');
      console.log(`${TAG} [${req.person.id}] App: transcrição em ${Date.now() - startedAt} ms`);
      if (!transcript) return res.json({ transcript: '', ignored: req.query.wake === '1', text: 'Não consegui entender, pode repetir?', actions: [] });
      // App sempre ouvindo: fora de uma conversa em andamento, só reage se chamarem o Jarvis (ou saudarem).
      if (req.query.wake === '1' && !hasWakeWord(transcript) && !isGreeting(transcript)) {
        return res.json({ transcript, ignored: true, actions: [] });
      }
      return reply(req, res, transcript, { transcript });
    } catch (err) {
      console.error(`${TAG} [${req.person.id}] Erro ao processar áudio do app:`, err?.message || err);
      res.status(502).json({ error: friendlyError(err) });
    }
  });

  return router;
}
