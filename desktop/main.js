const { app, BrowserWindow, Tray, Menu, Notification, globalShortcut, ipcMain, nativeImage, session, shell, safeStorage } = require('electron');
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

const SHORTCUT = 'Control+Alt+J';
const ICON = path.join(__dirname, 'assets', 'icon.png');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Configuração (servidor + token do aparelho) ----------

const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configFile(), 'utf8'));
    let token = '';
    if (raw.token) token = raw.encrypted ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : raw.token;
    return { server: raw.server || '', token, name: raw.name || '', musicTarget: raw.musicTarget || 'browser' };
  } catch {
    return { server: '', token: '', name: '', musicTarget: 'browser' };
  }
}

function saveConfig({ server, token, name, musicTarget }) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  const encrypted = safeStorage.isEncryptionAvailable();
  const stored = token ? (encrypted ? safeStorage.encryptString(token).toString('base64') : token) : '';
  writeFileSync(configFile(), JSON.stringify({ server, name, token: stored, encrypted, musicTarget: musicTarget || 'browser' }), 'utf8');
}

let config = null;

// ---------- Janela principal e bandeja ----------

let win = null;
let tray = null;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 680,
    minWidth: 360,
    minHeight: 480,
    title: 'Jarvis',
    icon: ICON,
    backgroundColor: '#0b0d11',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show();
  win.focus();
}

function buildTray() {
  tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
  tray.setToolTip('Jarvis');
  const refresh = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Abrir Jarvis', click: showWindow },
        { label: `Falar com o Jarvis (${SHORTCUT.replace('Control', 'Ctrl')})`, click: toggleRecording },
        { type: 'separator' },
        {
          label: 'Iniciar com o Windows',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
        },
        {
          label: 'Tocar música',
          submenu: musicTargets().map(([value, label]) => ({
            label,
            type: 'radio',
            checked: config.musicTarget === value,
            click: () => {
              config.musicTarget = value;
              saveConfig(config);
            },
          })),
        },
        { label: 'Desconectar este computador', click: disconnect },
        { type: 'separator' },
        { label: 'Sair', click: () => { quitting = true; app.quit(); } },
      ]),
    );
  refresh();
  tray.on('click', showWindow);
}

function toggleRecording() {
  showWindow();
  win.webContents.send('toggle-record');
}

// ---------- Onde a música toca ----------
// Padrão: no navegador (YouTube Music), onde a pessoa já está logada: sem bloqueio de
// gravadora, sem verificação de robô e com a conta Premium dela. A alternativa é a janela
// de player do próprio Jarvis (mais controle, mas sujeita a esses bloqueios).

const BRAVE_PATHS = [
  path.join(process.env.ProgramFiles || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
];
const bravePath = () => BRAVE_PATHS.find((p) => existsSync(p)) || null;

function musicTargets() {
  const list = [['browser', 'No navegador padrão (YouTube Music)'], ['window', 'Na janela do Jarvis']];
  if (bravePath()) list.unshift(['brave', 'No Brave (YouTube Music)']);
  return list;
}

let lastBrowserTrack = null;

function playOnTarget(action) {
  const target = config.musicTarget;
  if (target === 'window') return playMusic(action);
  const url = `https://music.youtube.com/watch?v=${encodeURIComponent(action.videoId)}`;
  const brave = target === 'brave' ? bravePath() : null;
  if (brave) spawn(brave, [url], { detached: true, stdio: 'ignore' }).unref();
  else shell.openExternal(url);
  lastBrowserTrack = action.title;
  notifyRenderer('now-playing', { title: action.title, paused: false });
}

// Teclas de mídia do Windows: controlam a aba do navegador que estiver tocando.
const MEDIA_KEYS = { pause: 0xb3, resume: 0xb3, stop: 0xb2, volume_up: 0xaf, volume_down: 0xae };

function pressMediaKey(vk, times = 1) {
  const script =
    "Add-Type -Namespace J -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);';" +
    `1..${times} | ForEach-Object { [J.K]::keybd_event(${vk},0,0,[UIntPtr]::Zero); [J.K]::keybd_event(${vk},0,2,[UIntPtr]::Zero) }`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true }, () => {});
}

function controlOnTarget(action) {
  if (config.musicTarget === 'window') return controlMusic(action);
  const vk = MEDIA_KEYS[action];
  if (!vk) return;
  pressMediaKey(vk, action.startsWith('volume') ? 5 : 1);
  if (action === 'pause') notifyRenderer('now-playing', { title: lastBrowserTrack, paused: true });
  if (action === 'resume') notifyRenderer('now-playing', { title: lastBrowserTrack, paused: false });
  if (action === 'stop') notifyRenderer('now-playing', null);
}

// ---------- Player de música (janela do Jarvis) ----------
// Toca o vídeo do YouTube (player oficial incorporado) numa janelinha; o áudio sai dela.
// Sessão persistente: se a pessoa entrar na conta do YouTube/Premium uma vez, fica sem anúncios.

let player = null;
let nowPlaying = null;

function notifyRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Servidor local mínimo que entrega o player.html (o YouTube só aceita embed vindo de uma página http).
let playerServer = null;
let playerOrigin = '';

function ensurePlayerServer() {
  if (playerServer) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const html = readFileSync(path.join(__dirname, 'player.html'));
    playerServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    });
    playerServer.once('error', reject);
    playerServer.listen(0, '127.0.0.1', () => {
      playerOrigin = `http://127.0.0.1:${playerServer.address().port}`;
      resolve();
    });
  });
}

async function playMusic({ videoId, title, alternatives }) {
  await ensurePlayerServer();
  if (!player || player.isDestroyed()) {
    player = new BrowserWindow({
      width: 640,
      height: 400,
      title: 'Jarvis - Player',
      icon: ICON,
      autoHideMenuBar: true,
      show: false,
      webPreferences: { partition: 'persist:jarvis-player', autoplayPolicy: 'no-user-gesture-required', nodeIntegration: false, contextIsolation: true },
    });
    player.setMenu(null);
    // Fechar a janela do player = parar a música.
    player.on('closed', () => {
      player = null;
      nowPlaying = null;
      notifyRenderer('now-playing', null);
    });
    player.once('ready-to-show', () => player?.showInactive());
  }
  const queue = [{ videoId, title }, ...(Array.isArray(alternatives) ? alternatives : [])].filter((t) => t?.videoId);
  startTrack(queue, queue[0]);
}

/** Toca a faixa; se o YouTube recusar o embed, tenta a próxima da fila, e por fim abre no navegador. */
function startTrack(queue, track) {
  nowPlaying = { ...track, queue, first: queue[0] };
  player.loadURL(`${playerOrigin}/?v=${encodeURIComponent(track.videoId)}`);
  notifyRenderer('now-playing', { title: track.title, paused: false });
  checkPlayback(track.videoId, 0);
}

const PLAYING = 1;

async function checkPlayback(videoId, attempt) {
  if (!player || player.isDestroyed() || nowPlaying?.videoId !== videoId) return;
  let info = null;
  try {
    info = await player.webContents.executeJavaScript('window.ctl && window.ctl.state()');
  } catch {
    // página ainda carregando
  }
  if (process.env.JARVIS_DEBUG) console.log('player', videoId, attempt, JSON.stringify(info));
  if (info?.state === PLAYING) return;
  if (info?.error || attempt >= 8) return tryNext();
  setTimeout(() => checkPlayback(videoId, attempt + 1), 2000);
}

const MAX_EMBED_TRIES = 3;

function tryNext() {
  const { queue, videoId, first } = nowPlaying;
  const index = queue.findIndex((t) => t.videoId === videoId);
  if (index + 1 < Math.min(queue.length, MAX_EMBED_TRIES)) return startTrack(queue, queue[index + 1]);
  openWatchPage(first);
}

/**
 * Gravadoras costumam bloquear o player incorporado. Aí abre a página normal do YouTube na
 * própria janela do player: se ele pedir verificação ou login (comum em rede de empresa),
 * a pessoa resolve uma vez ali e a sessão fica salva pras próximas músicas.
 */
function openWatchPage(track) {
  if (!player || player.isDestroyed()) return;
  nowPlaying = { ...track, queue: [track], first: track, watch: true };
  player.loadURL(`https://www.youtube.com/watch?v=${encodeURIComponent(track.videoId)}`);
  player.show();
  notifyRenderer('now-playing', { title: track.title, paused: false });
  notifyRenderer('notice', 'Essa música não toca no player incorporado, então abri o YouTube na janela do player. Se ele pedir verificação ou login, faça uma vez ali e a música continua.');
}

async function runInPlayer(code) {
  if (!player || player.isDestroyed()) return false;
  try {
    await player.webContents.executeJavaScript(code);
    return true;
  } catch {
    return false;
  }
}

async function controlMusic(action) {
  switch (action) {
    case 'pause':
      if (await runInPlayer("window.ctl ? window.ctl.pause() : document.querySelector('video')?.pause()")) notifyRenderer('now-playing', { ...nowPlaying, paused: true });
      break;
    case 'resume':
      if (await runInPlayer("window.ctl ? window.ctl.play() : document.querySelector('video')?.play()")) notifyRenderer('now-playing', { ...nowPlaying, paused: false });
      break;
    case 'stop':
      if (player && !player.isDestroyed()) player.close();
      break;
    case 'volume_up':
      await runInPlayer("window.ctl ? window.ctl.volume(20) : (()=>{const v=document.querySelector('video'); if(v) v.volume=Math.min(1,v.volume+0.2)})()");
      break;
    case 'volume_down':
      await runInPlayer("window.ctl ? window.ctl.volume(-20) : (()=>{const v=document.querySelector('video'); if(v) v.volume=Math.max(0,v.volume-0.2)})()");
      break;
  }
}

function handleAction(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'play_music' && action.videoId) playOnTarget(action);
  else if (action.type === 'control_music') controlOnTarget(action.action);
  else if (action.type === 'chat') notifyRenderer('chat', { user: action.user, reply: action.reply });
  else if (action.type === 'notify') {
    new Notification({ title: action.title || 'Jarvis', body: action.body || '', icon: ICON }).show();
  }
}

// ---------- Canal de eventos do servidor (SSE) ----------

let eventsAbort = null;
let retryTimer = null;

let connectionStatus = 'offline';

function setStatus(status) {
  connectionStatus = status;
  notifyRenderer('connection', status);
}

async function connectEvents() {
  clearTimeout(retryTimer);
  eventsAbort?.abort();
  if (!config?.server || !config?.token) return;

  const abort = new AbortController();
  eventsAbort = abort;
  try {
    const res = await fetch(`${config.server}/api/desktop/events`, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: 'text/event-stream' },
      signal: abort.signal,
    });
    if (res.status === 401) {
      setStatus('unauthorized');
      return;
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    setStatus('online');

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
        if (!data) continue;
        try {
          handleAction(JSON.parse(data));
        } catch {
          // evento malformado: ignora
        }
      }
    }
  } catch (err) {
    if (abort.signal.aborted) return;
  }
  if (abort.signal.aborted) return;
  setStatus('offline');
  retryTimer = setTimeout(connectEvents, 5000);
}

function disconnect() {
  eventsAbort?.abort();
  clearTimeout(retryTimer);
  config = { server: config?.server || '', token: '', name: '', musicTarget: config?.musicTarget };
  saveConfig(config);
  controlOnTarget('stop');
  showWindow();
  notifyRenderer('config', publicConfig());
}

const publicConfig = () => ({ server: config.server, name: config.name, paired: !!config.token });

// ---------- IPC ----------

ipcMain.handle('config:get', () => ({ ...publicConfig(), token: config.token, shortcut: SHORTCUT.replace('Control', 'Ctrl'), status: connectionStatus, nowPlaying }));

ipcMain.handle('config:save', (_e, next) => {
  config = { server: String(next.server || '').replace(/\/+$/, ''), token: String(next.token || ''), name: String(next.name || ''), musicTarget: config.musicTarget };
  saveConfig(config);
  connectEvents();
  return publicConfig();
});

ipcMain.handle('config:disconnect', () => disconnect());
ipcMain.handle('actions:run', (_e, actions) => {
  for (const a of Array.isArray(actions) ? actions : []) handleAction(a);
});
ipcMain.handle('music:control', (_e, action) => controlOnTarget(action));
ipcMain.handle('music:show', () => {
  if (player && !player.isDestroyed()) {
    player.show();
    player.focus();
  }
});

// ---------- Ciclo de vida ----------

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  config = loadConfig();

  // Microfone liberado só pra nossa própria janela.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'notifications'));

  buildTray();
  if (!process.argv.includes('--hidden') || !config.token) createWindow();
  globalShortcut.register(SHORTCUT, toggleRecording);
  connectEvents();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  // Continua na bandeja (SSE + música).
});
