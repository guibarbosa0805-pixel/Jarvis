import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { tools, buildSystemInstruction, runFunction } from './gemini.js';
import { getBrain, mirrorDesktopExchange } from './jarvis.js';
import { findPersonById } from './people.js';
import { createStore } from './store.js';
import { createMemory, readableMessages } from './memory.js';
import { personIdFromToken } from './desktop.js';
import { searchMusic } from './music.js';

// Conversa por voz em tempo real com o app do computador (Gemini Live). Em vez de
// transcrever -> pensar -> gerar voz em três chamadas, o áudio da pessoa vai direto pro
// modelo e a resposta falada volta em pedaços, começando ~1 s depois que ela para de
// falar. Mesmas funções, memória e conversa do WhatsApp: cada turno entra no histórico.
//
// Protocolo com o app (WebSocket em /api/desktop/live, token no subprotocolo):
//   app -> servidor: binário = áudio PCM 16 kHz mono 16 bits; JSON {type: 'warm'|'start'|'end'|'text'}
//   servidor -> app: binário = áudio PCM 24 kHz da resposta; JSON {type: 'input'|'output'|'actions'|'turn-complete'|'interrupted'|'live-closed'|'error'}

const TAG = '[painel]';
const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const IDLE_CLOSE_MS = 3 * 60 * 1000;
const HISTORY_TURNS = 20;

const VOICE_RULES = `

Agora vocês estão numa CONVERSA POR VOZ em tempo real, pelo app do computador. A pessoa ouve, não lê:
- Responda como numa ligação: 1 a 3 frases curtas e naturais. Nada de listas, emojis, asteriscos ou links falados — se houver link, diga que ele aparece na tela.
- A transcrição do que a pessoa disse pode ter erros de ouvido; interprete com bom senso.
- Se a pessoa só cumprimentar com "bom dia" (ex: "bom dia", "bom dia, Jarvis", "bom dia crianças, papai chegou") ou chamar "ei Jarvis, tá aí?", chame run_good_morning_routine. Se o resultado trouxer "say", diga exatamente essa frase e nada mais.`;

const ROUTINE_TOOL = {
  name: 'run_good_morning_routine',
  description: 'Rotina de bom dia configurada pela pessoa (frase falada + música no computador). Chame quando ela só cumprimentar com bom dia ou chamar "ei Jarvis, tá aí?".',
  parameters: { type: Type.OBJECT, properties: {} },
};

const liveTools = [{ functionDeclarations: [...tools[0].functionDeclarations, ROUTINE_TOOL] }];

export function attachLiveServer(server) {
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('jarvis') ? 'jarvis' : false) });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/desktop/live')) {
      socket.destroy();
      return;
    }
    const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
    const person = findPersonById(personIdFromToken(protocols.find((p) => p && p !== 'jarvis')));
    if (!person) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, person));
  });
}

function handleClient(ws, person) {
  const store = createStore(person.id);
  const memory = createMemory(person.id);
  const send = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));

  let session = null;
  let connecting = null;
  let pendingAudio = [];
  let idleTimer = null;
  let chain = Promise.resolve();

  // Estado do turno atual.
  let turn = null;
  const newTurn = () => ({ user: '', reply: '', audio: false, tool: false, wipe: false, endedAt: 0, firstAudioAt: 0 });

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(closeSession, IDLE_CLOSE_MS);
  }

  function closeSession() {
    clearTimeout(idleTimer);
    try {
      session?.close();
    } catch {
      // já fechada
    }
    session = null;
  }

  async function goodMorning(flags) {
    const routine = findPersonById(person.id)?.goodMorning;
    if (!routine?.reply) return { ok: false, note: 'Sem rotina de bom dia configurada: cumprimente normalmente.' };
    if (routine.music) {
      const track = await searchMusic(routine.music).catch(() => null);
      if (track) flags.actions.push({ type: 'play_music', routine: 'goodMorning', videoId: track.videoId, title: track.title, url: track.url, alternatives: track.alternatives });
    }
    return { ok: true, say: routine.reply };
  }

  async function onToolCall(call) {
    turn ??= newTurn();
    turn.tool = true;
    const flags = { wipe: false, voice: true, channel: 'desktop', actions: [] };
    const functionResponses = [];
    for (const fc of call.functionCalls || []) {
      let response;
      try {
        response = fc.name === ROUTINE_TOOL.name ? await goodMorning(flags) : await runFunction({ store, memory, flags, personId: person.id }, fc.name, fc.args || {});
      } catch (err) {
        response = { ok: false, error: err.message };
      }
      functionResponses.push({ id: fc.id, name: fc.name, response });
    }
    if (flags.wipe) turn.wipe = true;
    if (flags.actions.length) send({ type: 'actions', actions: flags.actions });
    session?.sendToolResponse({ functionResponses });
  }

  function finishTurn() {
    const t = turn;
    // Depois de uma função vem um turnComplete sem fala; a resposta chega no turno seguinte.
    if (!t || (t.tool && !t.audio && !t.reply)) return;
    turn = null;
    const user = t.user.trim();
    const reply = t.reply.trim();
    if (t.endedAt && t.firstAudioAt) console.log(`${TAG} [${person.id}] Voz em tempo real: 1º áudio ${t.firstAudioAt - t.endedAt} ms após a fala`);
    send({ type: 'turn-complete', user, reply });
    if (t.wipe) {
      closeSession(); // memória apagada: a próxima conversa começa do zero
      return;
    }
    if (user || reply) {
      getBrain(findPersonById(person.id) || person).recordTurn(user || '(fala)', reply || '(resposta por voz)').catch(() => {});
      if (user && reply) {
        mirrorDesktopExchange(findPersonById(person.id) || person, user, reply).catch((err) =>
          console.error(`${TAG} [${person.id}] Falha ao copiar a conversa no WhatsApp:`, err?.message || err),
        );
      }
    }
  }

  function onMessage(m) {
    if (m.toolCall) {
      chain = chain.then(() => onToolCall(m.toolCall)).catch(() => {});
      return;
    }
    if (m.goAway) {
      session = null; // o Gemini vai fechar; a próxima fala abre outra sessão
      return;
    }
    const sc = m.serverContent;
    if (!sc) return;
    turn ??= newTurn();
    if (sc.inputTranscription?.text) {
      turn.user += sc.inputTranscription.text;
      send({ type: 'input', text: turn.user });
    }
    if (sc.outputTranscription?.text) {
      turn.reply += sc.outputTranscription.text;
      send({ type: 'output', text: turn.reply });
    }
    for (const part of sc.modelTurn?.parts || []) {
      if (!part.inlineData?.data) continue;
      if (!turn.firstAudioAt) turn.firstAudioAt = Date.now();
      turn.audio = true;
      if (ws.readyState === ws.OPEN) ws.send(Buffer.from(part.inlineData.data, 'base64'));
    }
    if (sc.interrupted) send({ type: 'interrupted' });
    if (sc.turnComplete) finishTurn();
  }

  async function ensureSession() {
    if (session) return session;
    if (connecting) return connecting;
    connecting = (async () => {
      const fresh = findPersonById(person.id) || person;
      const ai = new GoogleGenAI({ apiKey: fresh.geminiApiKey });
      const now = new Date().toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
      const s = await ai.live.connect({
        model: LIVE_MODEL,
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: `${buildSystemInstruction(fresh.displayName, 'por voz, no app do computador', memory.getProfile())}${VOICE_RULES}\n\n[Data/hora no início desta conversa: ${now}]`,
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.JARVIS_VOICE || 'Charon' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          // O app detecta o início e o fim da fala (e a palavra "Jarvis"); o Gemini responde assim que ela termina.
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
          tools: liveTools,
        },
        callbacks: {
          onmessage: onMessage,
          onerror: (e) => {
            console.error(`${TAG} [${person.id}] Erro na voz em tempo real:`, e?.message || e);
            send({ type: 'error', message: 'A conversa por voz caiu. Tente de novo.' });
          },
          onclose: () => {
            if (session === s) session = null;
            send({ type: 'live-closed' });
          },
        },
      });
      // Contexto: a conversa recente (inclui o que foi dito no WhatsApp).
      const history = readableMessages(memory.loadHistory(), HISTORY_TURNS);
      if (history.length) {
        s.sendClientContent({ turns: history.map((h) => ({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] })), turnComplete: false });
      }
      session = s;
      for (const chunk of pendingAudio) s.sendRealtimeInput({ audio: chunk });
      pendingAudio = [];
      touch();
      return s;
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  async function handle(raw, isBinary) {
    if (isBinary) {
      const audio = { data: Buffer.from(raw).toString('base64'), mimeType: 'audio/pcm;rate=16000' };
      if (session) session.sendRealtimeInput({ audio });
      else pendingAudio.push(audio);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    touch();
    if (msg.type === 'warm') {
      await ensureSession();
    } else if (msg.type === 'start') {
      turn = newTurn();
      const s = await ensureSession();
      s.sendRealtimeInput({ activityStart: {} });
    } else if (msg.type === 'end') {
      const s = await ensureSession();
      s.sendRealtimeInput({ activityEnd: {} });
      if (turn) turn.endedAt = Date.now();
    } else if (msg.type === 'text' && msg.text) {
      turn = newTurn();
      turn.user = String(msg.text);
      turn.endedAt = Date.now();
      const s = await ensureSession();
      s.sendClientContent({ turns: [{ role: 'user', parts: [{ text: String(msg.text) }] }], turnComplete: true });
    }
  }

  ws.on('message', (raw, isBinary) => {
    chain = chain
      .then(() => handle(raw, isBinary))
      .catch((err) => {
        console.error(`${TAG} [${person.id}] Falha na voz em tempo real:`, err?.message || err);
        send({ type: 'error', message: 'Não consegui abrir a conversa por voz agora.' });
      });
  });
  ws.on('close', closeSession);
}
