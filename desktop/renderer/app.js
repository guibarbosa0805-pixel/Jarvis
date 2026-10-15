const $ = (id) => document.getElementById(id);

const DEFAULT_SERVER = 'http://192.168.3.122:4545';

let config = { server: '', token: '', name: '', paired: false, shortcut: 'Ctrl+Alt+J' };
let busy = false;
let currentAudio = null;
let voiceOn = readPref('voice', '1') === '1';

// ---------- Utilidades ----------

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // preferência é só conveniência
  }
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

function addMessage(text, kind = 'jarvis') {
  const el = document.createElement('div');
  el.className = `msg ${kind}`;
  for (const part of String(text).split(URL_RE)) {
    if (/^https?:\/\//.test(part)) {
      const a = document.createElement('a');
      a.href = part;
      a.target = '_blank';
      a.rel = 'noreferrer';
      a.textContent = part;
      el.append(a);
    } else {
      el.append(part);
    }
  }
  const list = $('messages');
  list.append(el);
  list.scrollTop = list.scrollHeight;
  return el;
}

function normalizeServer(value) {
  let v = String(value || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = `http://${v}`;
  return v;
}

async function api(path, options = {}) {
  const res = await fetch(`${config.server}/api/desktop${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.token}`, ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    showSetup('Este computador foi desconectado. Conecte de novo pelo WhatsApp.');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
  return body;
}

function friendly(err) {
  return err.message === 'Failed to fetch' ? 'Sem conexão com o servidor. Tentando de novo...' : err.message;
}

// ---------- Orb: o estado da voz num relance ----------

const STATE_LABELS = {
  off: 'Escuta pausada. Toque no círculo para ouvir',
  listening: () => (inConversation() ? 'Pode falar' : 'Ouvindo. Diga "Jarvis"'),
  recording: 'Ouvindo você...',
  thinking: 'Pensando...',
  speaking: 'Falando...',
};

function setOrb(state) {
  $('orb').dataset.state = state;
  const label = STATE_LABELS[state];
  $('state-label').textContent = typeof label === 'function' ? label() : label;
  $('state-label').classList.toggle('active', state !== 'off' && state !== 'listening');
  if (state !== 'listening' && state !== 'recording') $('orb').style.setProperty('--level', 0);
}

/** Estado "de repouso": ouvindo se a escuta estiver ligada, senão pausado. */
function restOrb() {
  setOrb(call ? 'listening' : 'off');
}

// ---------- Voz ----------

function playBlob(blob) {
  currentAudio?.pause();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  return new Promise((resolve) => {
    const done = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    audio.onended = audio.onerror = audio.onpause = done;
    audio.play().catch(done);
  });
}

let warnedVoice = false;

/** Plano B quando a voz do servidor não está disponível (cota diária): voz pt-BR do Windows, se houver. */
async function speakLocally(text) {
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('pt'));
  if (!voice) {
    if (!warnedVoice) {
      warnedVoice = true;
      addMessage('A voz do Jarvis atingiu o limite de hoje. Sigo respondendo por texto até ela voltar.', 'system');
    }
    return;
  }
  const speech = new SpeechSynthesisUtterance(text.replace(URL_RE, '').replace(/[*_~`#>]/g, ''));
  speech.voice = voice;
  speech.lang = voice.lang;
  await new Promise((resolve) => {
    speech.onend = speech.onerror = () => resolve();
    speechSynthesis.speak(speech);
  });
}

async function fetchSpeech(id) {
  const res = await fetch(`${config.server}/api/desktop/speech/${id}`, { headers: { Authorization: `Bearer ${config.token}` } });
  if (!res.ok) return null;
  return res.blob();
}

/**
 * Mostra a resposta na hora e fala em seguida (o áudio é gerado em paralelo no servidor).
 * Ações como tocar música só começam depois que o Jarvis termina de falar.
 */
async function handleReply(body) {
  if (body.transcript) addMessage(body.transcript, 'user');
  addMessage(body.text, 'jarvis');

  if (body.speechId && voiceOn) {
    setOrb('thinking');
    const blob = await fetchSpeech(body.speechId).catch(() => null);
    window.jarvis.duckMusic(true);
    setOrb('speaking');
    if (blob) await playBlob(blob);
    else await speakLocally(body.text);
    window.jarvis.duckMusic(false);
  }
  if (body.actions?.length) window.jarvis.runActions(body.actions);
  conversationUntil = performance.now() + CALL.conversationMs;
}

function setVoice(on) {
  voiceOn = on;
  writePref('voice', on ? '1' : '0');
  $('voice-btn').classList.toggle('on', on);
  $('voice-btn').setAttribute('aria-pressed', String(on));
  $('voice-label').textContent = on ? 'Respondendo por voz' : 'Respondendo em texto';
  if (!on) currentAudio?.pause();
}

$('voice-btn').addEventListener('click', () => setVoice(!voiceOn));

// ---------- Conexão com o WhatsApp ----------

let pairing = null; // { server, code, secret, link, message, timer }

function currentServer() {
  return normalizeServer($('server').value) || DEFAULT_SERVER;
}

function showPairStep(waiting) {
  $('pair-start').hidden = waiting;
  $('pair-wait').hidden = !waiting;
}

function stopPairing() {
  if (pairing?.timer) clearInterval(pairing.timer);
  pairing = null;
  showPairStep(false);
}

async function finishPairing(server, token, name) {
  stopPairing();
  const saved = await window.jarvis.saveConfig({ server, token, name });
  config = { ...config, ...saved, token };
  showChat();
}

async function startWhatsAppPairing() {
  $('pair-error').textContent = '';
  const server = currentServer();
  $('whatsapp-btn').disabled = true;
  try {
    const res = await fetch(`${server}/api/desktop/pair/start`, { method: 'POST' });
    if (res.status === 404) throw new Error('O servidor ainda está numa versão antiga. Use "Já recebi um código do Jarvis" abaixo.');
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);

    pairing = { server, ...body };
    $('pair-message').textContent = body.message;
    showPairStep(true);
    if (body.link) window.open(body.link);
    pairing.timer = setInterval(pollPairing, 2000);
  } catch (err) {
    $('pair-error').textContent = err.message === 'Failed to fetch' ? 'Não consegui falar com o servidor. Confira se está na mesma rede.' : err.message;
  } finally {
    $('whatsapp-btn').disabled = false;
  }
}

async function pollPairing() {
  if (!pairing) return;
  const { server, code, secret } = pairing;
  try {
    const res = await fetch(`${server}/api/desktop/pair/status?code=${code}&secret=${secret}`);
    const body = await res.json();
    if (body.status === 'approved') return finishPairing(server, body.token, body.name);
    if (body.status === 'expired') {
      stopPairing();
      $('pair-error').textContent = 'O tempo para enviar a mensagem acabou. Tente de novo.';
    }
  } catch {
    // servidor fora do ar por um instante: tenta no próximo ciclo
  }
}

$('whatsapp-btn').addEventListener('click', startWhatsAppPairing);
$('pair-reopen').addEventListener('click', () => pairing?.link && window.open(pairing.link));
$('pair-cancel').addEventListener('click', stopPairing);
$('pair-message').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('pair-message').textContent);
    $('pair-error').textContent = '';
    $('pair-message').dataset.copied = '1';
    const original = $('pair-message').textContent;
    $('pair-message').textContent = 'Copiado!';
    setTimeout(() => ($('pair-message').textContent = original), 1200);
  } catch {
    // sem área de transferência: a pessoa digita
  }
});

async function pairWithCode(code) {
  const server = currentServer();
  $('pair-error').textContent = '';
  try {
    const res = await fetch(`${server}/api/desktop/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
    $('code').value = '';
    await finishPairing(server, body.token, body.name);
  } catch (err) {
    $('pair-error').textContent = err.message === 'Failed to fetch' ? 'Não consegui falar com o servidor. Confira se está na mesma rede.' : err.message;
  }
}

$('code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('code').value.trim();
  if (/^\d{6}$/.test(code)) pairWithCode(code);
  else $('pair-error').textContent = 'O código tem 6 dígitos.';
});
$('code').addEventListener('input', () => {
  $('code').value = $('code').value.replace(/\D/g, '').slice(0, 6);
  if ($('code').value.length === 6) pairWithCode($('code').value);
});
$('server').addEventListener('input', () => {
  $('server-label').textContent = currentServer().replace(/^https?:\/\//, '');
});

// ---------- Telas ----------

function showSetup(error = '') {
  endCall();
  document.body.classList.add('setup-mode');
  $('chat').hidden = true;
  $('setup').hidden = false;
  $('server').value = config.server || DEFAULT_SERVER;
  $('server-label').textContent = currentServer().replace(/^https?:\/\//, '');
  $('pair-error').textContent = error;
  showName('');
  showPairStep(!!pairing);
}

function showName(name) {
  $('person-name').textContent = name || '';
  document.title = name ? `Jarvis - ${name}` : 'Jarvis';
}

/** O nome mostrado é sempre o cadastrado no servidor (o mesmo do WhatsApp). */
async function syncName() {
  try {
    const { name } = await api('/me');
    if (name && name !== config.name) {
      config.name = name;
      await window.jarvis.saveConfig({ server: config.server, token: config.token, name });
    }
    showName(name || config.name);
  } catch {
    showName(config.name);
  }
}

function showChat() {
  document.body.classList.remove('setup-mode');
  $('setup').hidden = true;
  $('chat').hidden = false;
  $('hint').textContent = `${config.shortcut} liga/desliga a escuta`;
  showName(config.name);
  syncName();
  loadHistory();
  startCall(); // o app sempre abre ouvindo
}

// A conversa é a mesma do WhatsApp: mostra o que já foi dito lá (e aqui).
async function loadHistory() {
  let history = [];
  try {
    history = await api('/history');
  } catch {
    // sem histórico agora: mostra só a saudação
  }
  if (busy) return;
  $('messages').replaceChildren();
  for (const m of history) addMessage(m.text, m.role === 'user' ? 'user' : 'jarvis');
  if (!history.length) {
    addMessage(`Olá${config.name ? `, ${config.name}` : ''}. Estou ouvindo: é só dizer "Jarvis". Pelo WhatsApp eu continuo à disposição, é a mesma conversa.`, 'system');
  }
}

// ---------- Conversa por texto ----------

function setBusy(on) {
  busy = on;
  $('send').disabled = on;
}

async function sendText(text) {
  if (busy || !text) return;
  setBusy(true);
  if (call) call.state = 'processing';
  addMessage(text, 'user');
  setOrb('thinking');
  try {
    const body = await api(`/message${voiceOn ? '' : '?voice=0'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    await handleReply(body);
  } catch (err) {
    if (err.message !== 'unauthorized') addMessage(friendly(err), 'system error');
  } finally {
    setBusy(false);
    resumeListening();
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  $('input').value = '';
  autoGrow();
  sendText(text);
});

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

function autoGrow() {
  const el = $('input');
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  el.style.overflowY = el.scrollHeight > 120 ? 'auto' : 'hidden';
}
$('input').addEventListener('input', autoGrow);

// ---------- Escuta contínua ----------
// Mede o volume do microfone, detecta início e fim da fala, e manda só esse trecho
// (com uma folga antes, pra não cortar o "Jarvis"). Fora de uma conversa em andamento,
// o servidor só responde se ouvir "Jarvis" ou uma saudação.

const CALL = { minVoiceMs: 300, silenceMs: 850, maxUtteranceMs: 30000, tickMs: 40, conversationMs: 20000, preRollSec: 0.6 };
let call = null;
let conversationUntil = 0;
const inConversation = () => performance.now() < conversationUntil;

async function startCall() {
  if (call) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    addMessage('Não consegui acessar o microfone. Verifique em Configurações do Windows > Privacidade > Microfone.', 'system error');
    restOrb();
    return;
  }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(ctx.destination); // precisa estar ligado pra rodar; não emite som (saída vazia)

  call = { stream, ctx, analyser, processor, state: busy ? 'processing' : 'listening', floor: 0.01, loud: 0, ring: [], ringSamples: 0, utter: [], startedAt: 0, lastVoiceAt: 0, voicedMs: 0 };
  call.timer = setInterval(callTick, CALL.tickMs);
  if (!busy) setOrb('listening');
}

function endCall() {
  if (!call) return;
  const finished = call;
  call = null;
  clearInterval(finished.timer);
  finished.processor.onaudioprocess = null;
  finished.processor.disconnect();
  finished.stream.getTracks().forEach((t) => t.stop());
  finished.ctx.close().catch(() => {});
  if (!busy) setOrb('off');
}

function toggleCall() {
  if (call) endCall();
  else startCall();
}

function callTick() {
  if (!call) return;
  const data = new Float32Array(call.analyser.fftSize);
  call.analyser.getFloatTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += v * v;
  const rms = Math.sqrt(sum / data.length);

  const now = performance.now();
  const threshold = Math.max(0.025, call.floor * 3);
  const voiced = rms > threshold;

  if (call.state === 'listening') {
    $('orb').style.setProperty('--level', Math.min(1, rms * 6).toFixed(3));
    call.floor = call.floor * 0.97 + rms * 0.03;
    call.loud = voiced ? call.loud + 1 : 0;
    if (call.loud >= 3) startUtterance(now);
  } else if (call.state === 'recording') {
    $('orb').style.setProperty('--level', Math.min(1, rms * 8).toFixed(3));
    if (voiced) {
      call.lastVoiceAt = now;
      call.voicedMs += CALL.tickMs;
    }
    if (now - call.lastVoiceAt > CALL.silenceMs || now - call.startedAt > CALL.maxUtteranceMs) finishUtterance();
  }
}

function startUtterance(now) {
  call.state = 'recording';
  call.startedAt = now;
  call.lastVoiceAt = now;
  call.voicedMs = CALL.tickMs * call.loud;
  call.utter = call.ring;
  call.ring = [];
  call.ringSamples = 0;
  currentAudio?.pause();
  setOrb('recording');
}

function finishUtterance() {
  if (!call) return;
  call.state = 'processing';
  const samples = call.utter;
  const rate = call.ctx.sampleRate;
  call.utter = [];
  onUtteranceEnd(samples, rate);
}

/** Áudio cru do microfone: guarda uma folga enquanto escuta e acumula durante a fala. */
function onSamples(chunk) {
  if (!call) return;
  if (call.state === 'recording') {
    call.utter.push(chunk);
  } else if (call.state === 'listening') {
    call.ring.push(chunk);
    call.ringSamples += chunk.length;
    const keep = call.ctx.sampleRate * CALL.preRollSec;
    while (call.ring.length > 1 && call.ringSamples - call.ring[0].length >= keep) call.ringSamples -= call.ring.shift().length;
  }
}

/** PCM float -> WAV 16 bits mono a 16 kHz (leve pra enviar, suficiente pra reconhecer fala). */
function encodeWav(chunks, sampleRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const step = Math.max(1, Math.round(sampleRate / 16000));
  const outRate = Math.round(sampleRate / step);
  const outLen = Math.floor(total / step);
  const pcm = new Int16Array(outLen);
  let acc = 0;
  let count = 0;
  let o = 0;
  for (const chunk of chunks) {
    for (let k = 0; k < chunk.length && o < outLen; k++) {
      acc += chunk[k];
      if (++count === step) {
        pcm[o++] = Math.max(-1, Math.min(1, acc / step)) * 0x7fff;
        acc = 0;
        count = 0;
      }
    }
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => [...text].forEach((ch, idx) => view.setUint8(offset + idx, ch.charCodeAt(0)));
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  write(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outRate, true);
  view.setUint32(28, outRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

async function onUtteranceEnd(samples, rate) {
  if (!call) return;
  if (call.voicedMs < CALL.minVoiceMs) {
    resumeListening();
    return;
  }
  const blob = encodeWav(samples, rate);
  setOrb('thinking');
  setBusy(true);
  try {
    const params = [`call=1`, `wake=${inConversation() ? 0 : 1}`];
    if (!voiceOn) params.push('voice=0');
    const body = await api(`/audio?${params.join('&')}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob });
    if (!body.ignored) await handleReply(body); // ignorado: conversa ao fundo ou música, sem "Jarvis"
  } catch (err) {
    if (err.message !== 'unauthorized') addMessage(friendly(err), 'system error');
  } finally {
    setBusy(false);
    resumeListening();
  }
}

function resumeListening() {
  if (!call) return restOrb();
  call.state = 'listening';
  call.loud = 0;
  call.ring = [];
  call.ringSamples = 0;
  setOrb('listening');
}

$('orb-btn').addEventListener('click', toggleCall);
window.jarvis.on('toggle-record', () => {
  if (!$('chat').hidden) toggleCall();
});

// ---------- Música ----------

let paused = false;

function showNowPlaying(info) {
  $('player').hidden = !info;
  if (!info) return;
  paused = !!info.paused;
  $('player').classList.toggle('paused', paused);
  $('player-title').textContent = info.title || '';
  $('icon-pause').hidden = paused;
  $('icon-play').hidden = !paused;
  $('player-toggle').setAttribute('aria-label', paused ? 'Continuar' : 'Pausar');
  $('player-show').hidden = info.source !== 'app';
}

window.jarvis.on('now-playing', showNowPlaying);
$('player-toggle').addEventListener('click', () => window.jarvis.musicControl(paused ? 'resume' : 'pause'));
$('player-stop').addEventListener('click', () => window.jarvis.musicControl('stop'));
$('player-show').addEventListener('click', () => window.jarvis.showPlayer());

// ---------- Conexão com o servidor ----------

let lastStatus = '';

function applyStatus(status) {
  // Voltou a conectar: busca o que rolou no WhatsApp enquanto estava fora.
  if (status === 'online' && lastStatus && lastStatus !== 'online' && !$('chat').hidden) loadHistory();
  lastStatus = status;
  $('status-dot').className = `dot ${status}`;
  $('status-dot').title = { online: 'Conectado ao servidor', offline: 'Sem conexão. Tentando de novo...', unauthorized: 'Computador desconectado' }[status] || '';
  if (status === 'unauthorized') showSetup('Este computador foi desconectado. Conecte de novo pelo WhatsApp.');
}

window.jarvis.on('connection', applyStatus);

window.jarvis.on('chat', ({ user, reply }) => {
  if (user) addMessage(user, 'user');
  if (reply) addMessage(reply, 'jarvis');
});

window.jarvis.on('notice', (text) => addMessage(text, 'system'));

window.jarvis.on('config', (next) => {
  config = { ...config, ...next, token: next.paired ? config.token : '' };
  if (!next.paired) showSetup();
});

$('disconnect').addEventListener('click', () => window.jarvis.disconnect());

(async function init() {
  setVoice(voiceOn);
  config = await window.jarvis.getConfig();
  applyStatus(config.status);
  if (config.nowPlaying) showNowPlaying(config.nowPlaying);
  if (config.paired) showChat();
  else showSetup();
})();
