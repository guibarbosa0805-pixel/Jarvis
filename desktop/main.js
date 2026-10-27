const { app, BrowserWindow, Tray, Menu, Notification, clipboard, dialog, globalShortcut, ipcMain, nativeImage, screen, session, shell, safeStorage } = require('electron');
const { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn, execFile } = require('node:child_process');

const SHORTCUT = 'Control+Alt+J';
const ICON = path.join(__dirname, 'assets', 'icon.png');
const CONFIG_VERSION = 2;
// O YouTube trata o Electron como navegador "não suportado"; o player se apresenta como Chrome.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------- Configuração (servidor + token do aparelho + preferências) ----------

const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configFile(), 'utf8'));
  } catch {
    // primeira execução
  }
  let token = '';
  try {
    if (raw.token) token = raw.encrypted ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : raw.token;
  } catch {
    token = '';
  }
  // Versões antigas abriam a música no navegador; agora o padrão é tocar dentro do app.
  const musicTarget = (raw.version || 1) < CONFIG_VERSION ? 'app' : raw.musicTarget || 'app';
  return {
    server: raw.server || '',
    token,
    name: raw.name || '',
    musicTarget,
    autoStartSet: !!raw.autoStartSet,
    morningMusic: raw.morningMusic && existsSync(raw.morningMusic) ? raw.morningMusic : '',
    miniMode: !!raw.miniMode,
    miniPos: raw.miniPos || null,
  };
}

function saveConfig() {
  mkdirSync(app.getPath('userData'), { recursive: true });
  const encrypted = safeStorage.isEncryptionAvailable();
  const token = config.token ? (encrypted ? safeStorage.encryptString(config.token).toString('base64') : config.token) : '';
  writeFileSync(
    configFile(),
    JSON.stringify({
      version: CONFIG_VERSION,
      server: config.server,
      name: config.name,
      token,
      encrypted,
      musicTarget: config.musicTarget,
      autoStartSet: config.autoStartSet,
      morningMusic: config.morningMusic,
      miniMode: config.miniMode,
      miniPos: config.miniPos,
    }),
    'utf8',
  );
}

let config = null;

// ---------- Janela principal e bandeja ----------

let win = null;
let tray = null;
let quitting = false;

function createWindow(visible = true) {
  win = new BrowserWindow({
    show: visible,
    width: 430,
    height: 760,
    minWidth: 380,
    minHeight: 560,
    title: 'Jarvis',
    icon: ICON,
    backgroundColor: '#07090d',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#07090d', symbolColor: '#8b93a3', height: 40 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Iniciado com o Windows a janela fica escondida na bandeja, mas carrega: o Jarvis já está ouvindo.
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
  tray.on('click', expandFromMini);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Jarvis', click: expandFromMini },
      { label: 'Modo compacto (canto da tela)', click: () => showMini() },
      { label: `Ligar/desligar escuta (${SHORTCUT.replace('Control', 'Ctrl')})`, click: toggleListening },
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
            saveConfig();
          },
        })),
      },
      {
        label: 'Música do bom dia',
        submenu: [
          { label: config.morningMusic ? `Arquivo: ${path.basename(config.morningMusic)}` : 'Usando a música do YouTube', enabled: false },
          { label: 'Escolher arquivo de música...', click: chooseMorningMusic },
          { label: 'Usar a música do YouTube', enabled: !!config.morningMusic, click: () => setMorningMusic('') },
        ],
      },
      { label: 'Desconectar este computador', click: disconnect },
      { type: 'separator' },
      { label: 'Sair', click: () => { quitting = true; app.quit(); } },
    ]),
  );
}

// ---------- Música do bom dia (arquivo local) ----------
// Um arquivo de música da pessoa toca no lugar do YouTube na rotina de bom dia: na hora,
// sem anúncio e sem internet. O arquivo é copiado pra pasta do app (fica só neste PC).

const musicDir = () => path.join(app.getPath('userData'), 'musicas');

function setMorningMusic(file) {
  config.morningMusic = file;
  saveConfig();
  refreshTrayMenu();
}

async function chooseMorningMusic() {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Música do bom dia',
    properties: ['openFile'],
    filters: [{ name: 'Música', extensions: ['mp3', 'm4a', 'aac', 'ogg', 'wav', 'flac'] }],
  });
  if (canceled || !filePaths[0]) return;
  mkdirSync(musicDir(), { recursive: true });
  const target = path.join(musicDir(), `bom-dia${path.extname(filePaths[0]).toLowerCase()}`);
  copyFileSync(filePaths[0], target);
  setMorningMusic(target);
  notifyRenderer('notice', `Música do bom dia definida: ${path.basename(filePaths[0])}.`);
}

function toggleListening() {
  notifyRenderer('toggle-record');
}

function notifyRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- Música ----------
// Padrão: toca dentro do app, em segundo plano (uma janela oculta com o YouTube). A janela
// aparece só se o YouTube pedir verificação, ou quando a pessoa clica em "Player" (pra
// entrar na conta e ficar sem anúncios). Alternativa: abrir no Brave/navegador.

const BRAVE_PATHS = [
  path.join(process.env.ProgramFiles || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env['ProgramFiles(x86)'] || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
];
const bravePath = () => BRAVE_PATHS.find((p) => existsSync(p)) || null;

function musicTargets() {
  const list = [['app', 'Em segundo plano, no app'], ['browser', 'No navegador padrão (YouTube Music)']];
  if (bravePath()) list.push(['brave', 'No Brave (YouTube Music)']);
  return list;
}

let player = null;
let nowPlaying = null;
let watchTimer = null;

function setNowPlaying(info) {
  nowPlaying = info;
  notifyRenderer('now-playing', info);
  notifyMini('now-playing', info);
}

function ensurePlayer() {
  if (player && !player.isDestroyed()) return player;
  player = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Jarvis - Player',
    icon: ICON,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'persist:jarvis-player',
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  player.setMenu(null);
  player.webContents.setUserAgent(CHROME_UA);
  // Fechar o player pelo X só esconde: a música continua (parar é pelo app ou pela voz).
  player.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    player.hide();
  });
  player.on('closed', () => {
    player = null;
  });
  // Verificação de robô ou tela de consentimento: mostra a janela pra pessoa resolver uma vez.
  player.webContents.on('did-navigate', (_e, url) => {
    if (/google\.com\/sorry|consent\.(youtube|google)\.com|accounts\.google\.com/.test(url)) {
      player.show();
      notifyRenderer('notice', 'O YouTube pediu uma confirmação. Resolva na janela do player uma vez e a música continua.');
    }
  });
  return player;
}

function playInApp({ videoId, title }) {
  const p = ensurePlayer();
  p.loadURL(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
  setNowPlaying({ title, paused: false, source: 'app' });
  clearInterval(watchTimer);
  // Acompanha o vídeo: atualiza pausado/tocando e para no fim (sem emendar outros vídeos).
  watchTimer = setInterval(async () => {
    if (!player || player.isDestroyed() || nowPlaying?.source !== 'app') return clearInterval(watchTimer);
    const state = await player.webContents
      .executeJavaScript("(()=>{const v=document.querySelector('video.html5-main-video')||document.querySelector('video');const ad=!!document.querySelector('.ad-showing');return v?{paused:v.paused,ended:v.ended,ad}:null})()")
      .catch(() => null);
    if (!state) return;
    if (state.ended && !state.ad) return stopMusic();
    if (state.paused !== nowPlaying.paused) setNowPlaying({ ...nowPlaying, paused: state.paused });
  }, 3000);
}

function stopMusic() {
  if (nowPlaying?.source === 'local') notifyRenderer('local-music', { cmd: 'stop' });
  clearInterval(watchTimer);
  if (player && !player.isDestroyed()) player.webContents.loadURL('about:blank');
  setNowPlaying(null);
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

const VIDEO = "(document.querySelector('video.html5-main-video')||document.querySelector('video'))";

// Teclas de mídia do Windows: controlam a aba do navegador quando a música toca fora do app.
const MEDIA_KEYS = { pause: 0xb3, resume: 0xb3, stop: 0xb2, volume_up: 0xaf, volume_down: 0xae };

function pressMediaKey(vk, times = 1) {
  const script =
    "Add-Type -Namespace J -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);';" +
    `1..${times} | ForEach-Object { [J.K]::keybd_event(${vk},0,0,[UIntPtr]::Zero); [J.K]::keybd_event(${vk},0,2,[UIntPtr]::Zero) }`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true }, () => {});
}

/** Arquivo local toca na janela principal (que fica sempre carregada, mesmo escondida). */
function playLocal(file, title) {
  stopMusic();
  notifyRenderer('local-music', { cmd: 'play', url: pathToFileURL(file).href });
  setNowPlaying({ title: title || path.basename(file, path.extname(file)), paused: false, source: 'local' });
}

function playMusic(action) {
  if (action.routine === 'goodMorning' && config.morningMusic && existsSync(config.morningMusic)) {
    return playLocal(config.morningMusic, action.title);
  }
  if (config.musicTarget === 'app') return playInApp(action);
  stopMusic();
  const url = `https://music.youtube.com/watch?v=${encodeURIComponent(action.videoId)}`;
  const brave = config.musicTarget === 'brave' ? bravePath() : null;
  if (brave) spawn(brave, [url], { detached: true, stdio: 'ignore' }).unref();
  else shell.openExternal(url);
  setNowPlaying({ title: action.title, paused: false, source: 'browser' });
}

async function controlMusic(action) {
  if (nowPlaying?.source === 'local') {
    if (action === 'stop') return stopMusic();
    notifyRenderer('local-music', { cmd: action });
    if (action === 'pause' || action === 'resume') setNowPlaying({ ...nowPlaying, paused: action === 'pause' });
    return;
  }
  if (nowPlaying?.source === 'browser') {
    const vk = MEDIA_KEYS[action];
    if (vk) pressMediaKey(vk, action.startsWith('volume') ? 5 : 1);
    if (action === 'stop') setNowPlaying(null);
    else if (action === 'pause' || action === 'resume') setNowPlaying({ ...nowPlaying, paused: action === 'pause' });
    return;
  }
  switch (action) {
    case 'pause':
      if (await runInPlayer(`${VIDEO}?.pause()`)) setNowPlaying({ ...nowPlaying, paused: true });
      break;
    case 'resume':
      if (await runInPlayer(`${VIDEO}?.play()`)) setNowPlaying({ ...nowPlaying, paused: false });
      break;
    case 'stop':
      stopMusic();
      break;
    case 'volume_up':
      await runInPlayer(`(()=>{const v=${VIDEO}; if(v) v.volume=Math.min(1,v.volume+0.2)})()`);
      break;
    case 'volume_down':
      await runInPlayer(`(()=>{const v=${VIDEO}; if(v) v.volume=Math.max(0,v.volume-0.2)})()`);
      break;
  }
}

/** Abaixa a música enquanto o Jarvis fala ou ouve, e devolve o volume depois. */
async function duckMusic(on) {
  if (nowPlaying?.source === 'local') return notifyRenderer('local-music', { cmd: 'duck', on });
  if (nowPlaying?.source !== 'app') return;
  await runInPlayer(`(()=>{const v=${VIDEO}; if(!v) return; if(${on}){ if(window.__jv==null) window.__jv=v.volume; v.volume=Math.min(v.volume,0.15);} else if(window.__jv!=null){ v.volume=window.__jv; window.__jv=null; }})()`);
}

function handleAction(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'play_music' && action.videoId) playMusic(action);
  else if (action.type === 'control_music') controlMusic(action.action);
  else if (action.type === 'chat') notifyRenderer('chat', { user: action.user, reply: action.reply });
  else if (action.type === 'notify') showReminder(action);
  else if (action.type === 'open') openOnComputer(action);
  else if (action.type === 'type_text') typeText(action.text);
  else if (action.type === 'rpc') answerRpc(action);
}

// ---------- Ações no computador (pedidas pelo Jarvis) ----------
// O servidor só manda nomes da lista dele ou links http(s); aqui confere de novo.

const ALLOWED_APPS = new Set(['chrome', 'brave', 'msedge', 'excel', 'winword', 'powerpnt', 'outlook', 'calc', 'notepad', 'mspaint', 'explorer']);
const ALLOWED_URIS = new Set(['ms-teams:', 'whatsapp:', 'spotify:', 'ms-settings:']);

function openOnComputer({ kind, target }) {
  if (kind === 'url' && /^https?:\/\/\S+$/i.test(target)) return shell.openExternal(target);
  if (ALLOWED_URIS.has(target)) return shell.openExternal(target);
  if (ALLOWED_APPS.has(target)) {
    // "start" acha os programas registrados no Windows (Excel, Word, Chrome...).
    spawn('cmd.exe', ['/d', '/s', '/c', `start "" ${target}`], { windowsVerbatimArguments: true, windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  }
}

const KEY_SCRIPT_PREFIX = "Add-Type -Namespace J -Name K -MemberDefinition '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte b, byte s, uint f, UIntPtr e);';";

function pressCtrlV(done) {
  const script = `${KEY_SCRIPT_PREFIX} [J.K]::keybd_event(0x11,0,0,[UIntPtr]::Zero); [J.K]::keybd_event(0x56,0,0,[UIntPtr]::Zero); [J.K]::keybd_event(0x56,0,2,[UIntPtr]::Zero); [J.K]::keybd_event(0x11,0,2,[UIntPtr]::Zero)`;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true }, () => done());
}

/** Escreve o texto onde está o cursor: cola pela área de transferência e depois devolve o que estava lá. */
function typeText(text) {
  if (!text) return;
  // Se a janela do Jarvis estiver na frente, sai do caminho pra o texto ir pro programa de antes.
  if (win && !win.isDestroyed() && win.isFocused()) win.minimize();
  setTimeout(() => {
    const previous = clipboard.readText();
    clipboard.writeText(String(text));
    pressCtrlV(() => setTimeout(() => clipboard.writeText(previous), 400));
  }, 450);
}

/** O servidor pergunta algo ao PC (ex: o texto copiado) e espera a resposta. */
async function answerRpc({ id, kind }) {
  let result = null;
  let error = null;
  if (kind === 'clipboard') result = clipboard.readText();
  else error = 'Pergunta desconhecida.';
  try {
    await fetch(`${config.server}/api/desktop/rpc/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ result, error }),
    });
  } catch {
    // servidor fora do ar: ele desiste sozinho por tempo
  }
}

// ---------- Modo compacto ----------
// Janelinha flutuante, sempre por cima das outras, no canto da tela. A escuta continua
// na janela principal (que fica carregada, só escondida); a compacta mostra o estado e
// manda comandos.

let mini = null;
const MINI_SIZE = { width: 340, height: 92 };

function miniPosition() {
  const area = screen.getPrimaryDisplay().workArea;
  const saved = config.miniPos;
  if (saved && screen.getAllDisplays().some((d) => saved.x >= d.workArea.x && saved.y >= d.workArea.y && saved.x < d.workArea.x + d.workArea.width && saved.y < d.workArea.y + d.workArea.height)) {
    return saved;
  }
  return { x: area.x + area.width - MINI_SIZE.width - 16, y: area.y + area.height - MINI_SIZE.height - 16 };
}

function ensureMini() {
  if (mini && !mini.isDestroyed()) return mini;
  mini = new BrowserWindow({
    ...MINI_SIZE,
    ...miniPosition(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    title: 'Jarvis',
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  mini.setAlwaysOnTop(true, 'floating');
  mini.loadFile(path.join(__dirname, 'renderer', 'mini.html'));
  mini.on('moved', () => {
    const [x, y] = mini.getPosition();
    config.miniPos = { x, y };
    saveConfig();
  });
  // Com a compacta em foco, a pessoa está falando com o Jarvis: não precisa dizer o nome.
  mini.on('focus', () => notifyRenderer('mini-focus', true));
  mini.on('blur', () => notifyRenderer('mini-focus', false));
  mini.on('closed', () => {
    mini = null;
  });
  return mini;
}

function notifyMini(channel, payload) {
  if (mini && !mini.isDestroyed()) mini.webContents.send(channel, payload);
}

function showMini() {
  const m = ensureMini();
  m.showInactive();
  win?.hide();
  config.miniMode = true;
  saveConfig();
  notifyRenderer('ui-refresh');
}

function expandFromMini() {
  mini?.hide();
  config.miniMode = false;
  saveConfig();
  showWindow();
}

// ---------- Notificações do Windows ----------
// O Windows só mostra a notificação de um app identificado (AppUserModelID) com atalho no
// Menu Iniciar; o app cria esse atalho sozinho na primeira vez.

const APP_ID = 'br.com.bookplay.jarvis';
const notifications = new Set(); // mantém referência até fechar (senão o clique se perde)

function ensureStartMenuShortcut() {
  if (!app.isPackaged) return;
  const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Jarvis.lnk');
  const details = { target: process.execPath, appUserModelId: APP_ID, icon: process.execPath, iconIndex: 0, description: 'Jarvis' };
  try {
    const current = existsSync(lnk) ? shell.readShortcutLink(lnk) : null;
    if (current?.target !== details.target || current?.appUserModelId !== APP_ID) shell.writeShortcutLink(lnk, current ? 'replace' : 'create', details);
  } catch (err) {
    console.error('Não consegui criar o atalho do Menu Iniciar:', err.message);
  }
}

function showReminder({ kind, minutes, taskTitle, title, body, link }) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: title || 'Lembrete', body: `${body || ''}${link ? '\nClique para abrir o link' : ''}`, icon: ICON, urgency: 'critical' });
  notifications.add(n);
  const release = () => notifications.delete(n);
  n.on('click', () => {
    if (link && /^https?:\/\//.test(link)) shell.openExternal(link);
    else showWindow();
    release();
  });
  n.on('close', release);
  n.show();
  notifyMini('reminder', { title, body });
  notifyRenderer('reminder', { kind, minutes, taskTitle, title, body, link });
}

// ---------- Canal de eventos do servidor (SSE) ----------

let eventsAbort = null;
let retryTimer = null;
let connectionStatus = 'offline';

function setStatus(status) {
  connectionStatus = status;
  notifyRenderer('connection', status);
  notifyMini('connection', status);
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
  } catch {
    if (abort.signal.aborted) return;
  }
  if (abort.signal.aborted) return;
  setStatus('offline');
  retryTimer = setTimeout(connectEvents, 5000);
}

function disconnect() {
  eventsAbort?.abort();
  clearTimeout(retryTimer);
  config.token = '';
  config.name = '';
  saveConfig();
  controlMusic('stop');
  showWindow();
  notifyRenderer('config', publicConfig());
}

const publicConfig = () => ({ server: config.server, name: config.name, paired: !!config.token });

// ---------- IPC ----------

ipcMain.handle('config:get', () => ({ ...publicConfig(), token: config.token, shortcut: SHORTCUT.replace('Control', 'Ctrl'), status: connectionStatus, nowPlaying }));

ipcMain.handle('config:save', (_e, next) => {
  config.server = String(next.server || '').replace(/\/+$/, '');
  config.token = String(next.token || '');
  config.name = String(next.name || '');
  saveConfig();
  connectEvents();
  return publicConfig();
});

ipcMain.handle('config:disconnect', () => disconnect());
ipcMain.handle('actions:run', (_e, actions) => {
  for (const a of Array.isArray(actions) ? actions : []) handleAction(a);
});
ipcMain.handle('music:control', (_e, action) => controlMusic(action));
ipcMain.handle('music:duck', (_e, on) => duckMusic(!!on));
// Estado da voz (vem da janela principal) espelhado na compacta.
ipcMain.on('ui:state', (_e, state) => notifyMini('ui-state', state));
ipcMain.handle('mini:show', () => showMini());
ipcMain.handle('mini:info', () => ({ nowPlaying, status: connectionStatus }));
ipcMain.handle('mini:command', (_e, cmd) => {
  if (cmd === 'expand') expandFromMini();
  else if (cmd === 'toggle-listen') notifyRenderer('toggle-record');
  else if (['pause', 'resume', 'stop'].includes(cmd)) controlMusic(cmd);
});

ipcMain.handle('music:show', () => {
  if (nowPlaying?.source === 'app' && player && !player.isDestroyed()) {
    player.show();
    player.focus();
  }
});

// ---------- Ciclo de vida ----------

app.on('second-instance', expandFromMini);

app.setAppUserModelId(APP_ID);

app.whenReady().then(() => {
  config = loadConfig();
  ensureStartMenuShortcut();

  // Na primeira execução do app instalado, já liga "Iniciar com o Windows" (dá pra desligar na bandeja).
  if (app.isPackaged && !config.autoStartSet) {
    app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
    config.autoStartSet = true;
  }
  saveConfig();

  // Microfone e notificações liberados só pra nossa própria janela.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'notifications'));

  buildTray();
  const startHidden = process.argv.includes('--hidden') && config.token;
  // Se a pessoa deixou no modo compacto, volta nele.
  createWindow(!startHidden && !(config.miniMode && config.token));
  if (config.miniMode && config.token) win.webContents.once('did-finish-load', showMini);
  globalShortcut.register(SHORTCUT, toggleListening);
  connectEvents();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  // Continua na bandeja (eventos do servidor + música).
});
