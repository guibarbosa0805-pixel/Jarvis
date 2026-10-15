const $ = (id) => document.getElementById(id);

let config = { server: '', token: '', name: '', paired: false, shortcut: 'Ctrl+Alt+J' };
let busy = false;
let recorder = null;
let currentAudio = null;

// ---------- Utilidades ----------

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
  let v = value.trim().replace(/\/+$/, '');
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
    showSetup('Este computador foi desconectado. Peça um novo código ao Jarvis.');
    throw new Error('unauthorized');
  }
  if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
  return body;
}

/** Toca a resposta falada; a promessa resolve quando termina (ou falha). */
function playVoice(base64) {
  currentAudio?.pause();
  const audio = new Audio(`data:audio/ogg;base64,${base64}`);
  currentAudio = audio;
  return new Promise((resolve) => {
    audio.onended = audio.onerror = audio.onpause = () => resolve();
    audio.play().catch(() => resolve());
  });
}

function setBusy(on) {
  busy = on;
  $('send').disabled = on;
}

// ---------- Telas ----------

function showSetup(error = '') {
  endCall({ silent: true });
  $('chat').hidden = true;
  $('setup').hidden = false;
  $('server').value = config.server || 'http://192.168.3.122:4545';
  $('pair-error').textContent = error;
  (config.server ? $('code') : $('server')).focus();
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
  showName(config.name);
  syncName();
  $('setup').hidden = true;
  $('chat').hidden = false;
  $('hint').textContent = `Atalho para falar: ${config.shortcut}`;
  $('input').focus();
  loadHistory();
  startCall({ silent: true }); // o app sempre abre ouvindo
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
    addMessage(`Olá${config.name ? `, ${config.name}` : ''}. Pode escrever ou falar comigo. Pelo WhatsApp eu continuo à disposição, é a mesma conversa.`, 'system');
  }
}

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const server = normalizeServer($('server').value);
  const code = $('code').value.trim();
  if (!server || !/^\d{6}$/.test(code)) {
    $('pair-error').textContent = 'Informe o endereço do servidor e o código de 6 dígitos.';
    return;
  }
  $('pair-btn').disabled = true;
  $('pair-error').textContent = '';
  try {
    const res = await fetch(`${server}/api/desktop/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Erro ${res.status}`);
    const saved = await window.jarvis.saveConfig({ server, token: body.token, name: body.name });
    config = { ...config, ...saved, token: body.token };
    $('code').value = '';
    showChat();
  } catch (err) {
    $('pair-error').textContent = err.message === 'Failed to fetch' ? 'Não consegui falar com o servidor. Confira o endereço e se está na mesma rede.' : err.message;
  } finally {
    $('pair-btn').disabled = false;
  }
});

// ---------- Conversa ----------

async function handleReply(body) {
  if (body.transcript) addMessage(body.transcript, 'user');
  addMessage(body.text, 'jarvis');

  // Ações (ex: tocar música) só começam depois que o Jarvis termina de falar.
  const speech = body.audio ? playVoice(body.audio) : body.voiceUnavailable ? speakLocally(body.text) : Promise.resolve();
  const done = speech.then(() => {
    if (body.actions?.length) window.jarvis.runActions(body.actions);
  });
  if (call) await done;
}

let warnedVoice = false;

/** Plano B quando a voz natural do servidor não está disponível (cota diária): voz pt-BR do Windows, se instalada. */
async function speakLocally(text) {
  const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('pt'));
  if (!voice) {
    if (!warnedVoice) {
      warnedVoice = true;
      addMessage('A voz natural do Jarvis atingiu o limite diário e este computador não tem voz em português instalada. Respondo por texto até a cota voltar (ou instale a voz Maria em Configurações do Windows > Hora e idioma > Fala).', 'system');
    }
    return;
  }
  const speech = new SpeechSynthesisUtterance(text.replace(/https?:\/\/\S+/g, '').replace(/[*_~`#>]/g, ''));
  speech.voice = voice;
  speech.lang = voice.lang;
  await new Promise((resolve) => {
    speech.onend = speech.onerror = () => resolve();
    speechSynthesis.speak(speech);
  });
}

async function sendText(text) {
  if (busy || !text) return;
  setBusy(true);
  addMessage(text, 'user');
  const thinking = addMessage('Jarvis está pensando...', 'system thinking');
  try {
    const body = await api(`/message${$('voice-toggle').checked ? '?voice=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    thinking.remove();
    await handleReply(body);
  } catch (err) {
    thinking.remove();
    if (err.message !== 'unauthorized') addMessage(err.message === 'Failed to fetch' ? 'Sem conexão com o servidor. Vou continuar tentando.' : err.message, 'system error');
  } finally {
    setBusy(false);
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

// ---------- Voz ----------

async function startRecording() {
  if (busy || recorder) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder = null;
      $('mic').classList.remove('recording');
      const blob = new Blob(chunks, { type: 'audio/webm' });
      if (blob.size < 2000) return;
      await sendAudio(blob);
    };
    rec.start();
    recorder = rec;
    currentAudio?.pause();
    $('mic').classList.add('recording');
  } catch {
    addMessage('Não consegui acessar o microfone. Verifique a permissão do Windows para aplicativos.', 'system error');
  }
}

function stopRecording() {
  if (recorder?.state === 'recording') recorder.stop();
}

function toggleRecording() {
  if (recorder) stopRecording();
  else startRecording();
}

async function sendAudio(blob) {
  setBusy(true);
  const thinking = addMessage('Jarvis está ouvindo...', 'system thinking');
  try {
    const body = await api('/audio', { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: blob });
    thinking.remove();
    await handleReply(body);
  } catch (err) {
    thinking.remove();
    if (err.message !== 'unauthorized') addMessage(err.message, 'system error');
  } finally {
    setBusy(false);
  }
}

$('mic').addEventListener('click', toggleRecording);
// Ctrl+Alt+J liga/desliga a chamada de voz.
window.jarvis.on('toggle-record', () => {
  if (!$('chat').hidden) toggleCall();
});

// ---------- Música ----------

let paused = false;

function showNowPlaying(info) {
  $('player').hidden = !info;
  if (!info) return;
  paused = !!info.paused;
  $('player-title').textContent = info.title || '';
  $('player-toggle').textContent = paused ? 'Continuar' : 'Pausar';
}

window.jarvis.on('now-playing', showNowPlaying);

$('player-toggle').addEventListener('click', () => window.jarvis.musicControl(paused ? 'resume' : 'pause'));
$('player-stop').addEventListener('click', () => window.jarvis.musicControl('stop'));
$('player-show').addEventListener('click', () => window.jarvis.showPlayer());

// ---------- Conexão ----------

let lastStatus = '';

function applyStatus(status) {
  // Voltou a conectar: busca o que rolou no WhatsApp enquanto estava fora.
  if (status === 'online' && lastStatus && lastStatus !== 'online' && !$('chat').hidden) loadHistory();
  lastStatus = status;
  $('status-dot').className = `dot ${status}`;
  $('status-dot').title = { online: 'Conectado ao servidor', offline: 'Sem conexão. Tentando de novo...', unauthorized: 'Aparelho desconectado' }[status] || '';
  if (status === 'unauthorized') showSetup('Este computador foi desconectado. Peça um novo código ao Jarvis.');
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

$('voice-toggle').checked = (() => {
  try {
    return localStorage.getItem('voice') === '1';
  } catch {
    return false;
  }
})();
$('voice-toggle').addEventListener('change', () => {
  try {
    localStorage.setItem('voice', $('voice-toggle').checked ? '1' : '0');
  } catch {
    // preferência só cosmética
  }
});

(async function init() {
  config = await window.jarvis.getConfig();
  applyStatus(config.status);
  if (config.nowPlaying) showNowPlaying({ ...config.nowPlaying, paused: false });
  if (config.paired) showChat();
  else showSetup();
})();

// ---------- Chamada de voz (conversa sem usar as mãos) ----------
// Escuta o microfone, detecta quando você começa e termina de falar (por volume),
// manda o trecho pro Jarvis e toca a resposta falada; depois volta a escutar.

const CALL = { minVoiceMs: 350, silenceMs: 1300, maxUtteranceMs: 30000, tickMs: 50, conversationMs: 20000, preRollSec: 0.6 };
let call = null;
// Depois que o Jarvis responde, a conversa segue sem precisar chamar o nome por alguns segundos.
let conversationUntil = 0;
const inConversation = () => performance.now() < conversationUntil;
const listeningLabel = () => (inConversation() ? 'Ouvindo...' : 'Ouvindo (diga "Jarvis")');

function setCallStatus(text) {
  $('call-status').textContent = text;
}

function beep(freq, ms) {
  try {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, ms);
  } catch {
    // som é só um detalhe
  }
}

async function startCall({ silent = false } = {}) {
  if (call || busy) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    addMessage('Não consegui acessar o microfone. Verifique a permissão do Windows para aplicativos.', 'system error');
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

  call = { stream, ctx, analyser, processor, state: 'listening', floor: 0.01, loud: 0, ring: [], ringSamples: 0, utter: [], startedAt: 0, lastVoiceAt: 0, voicedMs: 0 };
  call.timer = setInterval(callTick, CALL.tickMs);
  currentAudio?.pause();
  $('call-bar').hidden = false;
  $('call-btn').textContent = 'Desligar';
  $('call-btn').classList.add('on');
  setCallStatus(listeningLabel());
  if (!silent) beep(880, 120);
}

function endCall({ silent = false } = {}) {
  if (!call) return;
  const finished = call;
  call = null;
  clearInterval(finished.timer);
  finished.processor.onaudioprocess = null;
  finished.processor.disconnect();
  finished.stream.getTracks().forEach((t) => t.stop());
  finished.ctx.close().catch(() => {});
  currentAudio?.pause();
  $('call-bar').hidden = true;
  $('call-btn').textContent = 'Ligar';
  $('call-btn').classList.remove('on');
  $('call-level').style.width = '0';
  if (!silent) beep(520, 150);
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
  $('call-level').style.width = `${Math.min(100, rms * 600)}%`;

  const now = performance.now();
  const threshold = Math.max(0.025, call.floor * 3);
  const voiced = rms > threshold;

  if (call.state === 'listening') {
    call.floor = call.floor * 0.97 + rms * 0.03;
    call.loud = voiced ? call.loud + 1 : 0;
    if (call.loud >= 3) startUtterance(now);
  } else if (call.state === 'recording') {
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
  // Começa com a folga gravada antes da detecção, senão o início da fala (o "Jarvis") se perde.
  call.utter = call.ring;
  call.ring = [];
  call.ringSamples = 0;
  setCallStatus('Ouvindo você...');
}

function finishUtterance() {
  if (!call) return;
  call.state = 'processing';
  const samples = call.utter;
  const rate = call.ctx.sampleRate;
  call.utter = [];
  onUtteranceEnd(samples, rate);
}

/** Recebe o áudio cru do microfone: guarda uma folga enquanto escuta e acumula durante a fala. */
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

/** PCM float -> WAV 16 bits mono a 16 kHz (leve o bastante pra enviar, suficiente pra reconhecer fala). */
function encodeWav(chunks, sampleRate) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const step = Math.max(1, Math.round(sampleRate / 16000));
  const outRate = Math.round(sampleRate / step);
  const outLen = Math.floor(total / step);
  const pcm = new Int16Array(outLen);
  let i = 0;
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
  const active = call;
  if (active.voicedMs < CALL.minVoiceMs) {
    resumeListening();
    return;
  }
  const blob = encodeWav(samples, rate);
  setCallStatus('Pensando...');
  setBusy(true);
  try {
    const body = await api(`/audio?call=1&wake=${inConversation() ? 0 : 1}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob });
    if (!call) return;
    if (body.ignored) return; // não chamaram o Jarvis: era conversa ao fundo ou música
    setCallStatus('Falando...');
    await handleReply(body);
    conversationUntil = performance.now() + CALL.conversationMs;
  } catch (err) {
    if (err.message !== 'unauthorized') addMessage(err.message === 'Failed to fetch' ? 'Sem conexão com o servidor.' : err.message, 'system error');
  } finally {
    setBusy(false);
    resumeListening();
  }
}

function resumeListening() {
  if (!call) return;
  call.state = 'listening';
  call.loud = 0;
  call.ring = [];
  call.ringSamples = 0;
  setCallStatus(listeningLabel());
}

$('call-btn').addEventListener('click', toggleCall);
