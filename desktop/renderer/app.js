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

function playVoice(base64) {
  currentAudio?.pause();
  currentAudio = new Audio(`data:audio/ogg;base64,${base64}`);
  currentAudio.play().catch(() => {});
}

function setBusy(on) {
  busy = on;
  $('send').disabled = on;
}

// ---------- Telas ----------

function showSetup(error = '') {
  $('chat').hidden = true;
  $('setup').hidden = false;
  $('server').value = config.server || 'http://192.168.3.122:4545';
  $('pair-error').textContent = error;
  (config.server ? $('code') : $('server')).focus();
}

function showChat() {
  $('setup').hidden = true;
  $('chat').hidden = false;
  $('hint').textContent = `Atalho para falar: ${config.shortcut}`;
  $('input').focus();
  loadHistory();
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
  if (body.actions?.length) window.jarvis.runActions(body.actions);
  if (body.audio) playVoice(body.audio);
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
window.jarvis.on('toggle-record', () => {
  if (!$('chat').hidden) toggleRecording();
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
