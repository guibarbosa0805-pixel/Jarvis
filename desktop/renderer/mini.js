// Janelinha do canto: só mostra o estado que a janela principal publica e manda comandos.
const $ = (id) => document.getElementById(id);
const orbView = createOrb($('orb-canvas'));

let lastText = '';
let nowPlaying = null;
let flashTimer = null;

function render() {
  const last = $('last');
  if (flashTimer) return; // um lembrete está em destaque
  if (nowPlaying && !lastText) {
    last.textContent = `♪ ${nowPlaying.title || 'Música'}`;
    last.classList.add('music');
  } else {
    last.textContent = lastText;
    last.classList.remove('music');
  }
}

// Rótulos curtos: a janelinha não tem espaço pras frases da janela principal.
function shortLabel(state, label) {
  if (state === 'listening') return /Jarvis/.test(label) ? 'Diga "Jarvis"' : 'Ouvindo';
  return { off: 'Escuta pausada', recording: 'Ouvindo você', thinking: 'Pensando...', speaking: 'Falando...' }[state] || 'Jarvis';
}

function applyState({ state, label, last, level }) {
  if (state) {
    $('orb').dataset.state = state;
    orbView.setState(state);
    $('label').classList.toggle('active', state !== 'off' && state !== 'listening');
  }
  if (label !== undefined) $('label').textContent = shortLabel($('orb').dataset.state, label);
  if (level !== undefined) orbView.setLevel(level);
  if (last !== undefined) {
    lastText = last;
    render();
  }
}

function applyNowPlaying(info) {
  nowPlaying = info;
  $('music-btn').hidden = !info;
  if (info) {
    $('icon-pause').hidden = !!info.paused;
    $('icon-play').hidden = !info.paused;
    $('music-btn').setAttribute('aria-label', info.paused ? 'Continuar a música' : 'Pausar a música');
  }
  render();
}

window.jarvis.on('ui-state', applyState);
window.jarvis.on('now-playing', applyNowPlaying);
window.jarvis.on('connection', (status) => ($('dot').className = `dot ${status}`));

// Lembrete chega: fica em destaque por alguns segundos.
window.jarvis.on('reminder', ({ title, body }) => {
  clearTimeout(flashTimer);
  $('mini').classList.add('flash');
  $('last').textContent = `${title}: ${body}`;
  $('last').classList.remove('music');
  flashTimer = setTimeout(() => {
    flashTimer = null;
    $('mini').classList.remove('flash');
    render();
  }, 15000);
});

$('orb-btn').addEventListener('click', () => window.jarvis.miniCommand('toggle-listen'));
$('expand-btn').addEventListener('click', () => window.jarvis.miniCommand('expand'));
$('music-btn').addEventListener('click', () => window.jarvis.miniCommand(nowPlaying?.paused ? 'resume' : 'pause'));
// Duplo clique no cartão abre a janela completa.
$('mini').addEventListener('dblclick', (e) => {
  if (!e.target.closest('button')) window.jarvis.miniCommand('expand');
});

(async function init() {
  const info = await window.jarvis.miniInfo();
  applyNowPlaying(info.nowPlaying);
  $('dot').className = `dot ${info.status}`;
})();
