import express from 'express';
import { config as loadEnv } from 'dotenv';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  readdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  openSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStatus } from './status.js';
import { startJarvisConnection, stopJarvisConnection, forgetBrain } from './jarvis.js';
import { startPeopleScheduler } from './scheduler-people.js';
import { listPeople, addPerson, updatePerson, removePerson, listPending, removePending, migrateDigestDefaults } from './people.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Normalizado (sem "..") porque res.sendFile recusa com 403 qualquer caminho
// que contenha ".." nos componentes, mesmo sendo absoluto.
const ROOT = resolve(__dirname, '..');

// panel.env (fora do git) define PANEL_HOST / PANEL_PASSWORD / PANEL_PORT.
loadEnv({ path: `${ROOT}/panel.env`, quiet: true });

const INSTANCES_DIR = `${ROOT}/instances`;
const LOGS_DIR = `${ROOT}/logs`;
const STATUS_DIR = `${ROOT}/status`;
const PIDS_FILE = `${STATUS_DIR}/pids.json`;
const PORT = Number(process.env.PANEL_PORT) || 4545;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';
let HOST = process.env.PANEL_HOST || '127.0.0.1';
const isLoopback = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1';
if (!isLoopback(HOST) && !PANEL_PASSWORD) {
  console.warn('[painel] PANEL_HOST aberto na rede, mas sem PANEL_PASSWORD — voltando pra 127.0.0.1 por segurança.');
  HOST = '127.0.0.1';
}

const sha256 = (s) => createHash('sha256').update(s).digest();

function requireAuth(req, res, next) {
  if (!PANEL_PASSWORD) return next();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const given = Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':');
    if (timingSafeEqual(sha256(given), sha256(PANEL_PASSWORD))) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Jarvis"').status(401).send('Autenticação necessária.');
}

for (const dir of [INSTANCES_DIR, LOGS_DIR, STATUS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function loadPids() {
  if (!existsSync(PIDS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PIDS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function savePids() {
  writeFileSync(PIDS_FILE, JSON.stringify(pids, null, 2), 'utf8');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let pids = loadPids();
for (const name of Object.keys(pids)) {
  if (!isAlive(pids[name])) delete pids[name];
}
savePids();

function listInstanceNames() {
  if (!existsSync(INSTANCES_DIR)) return [];
  return readdirSync(INSTANCES_DIR)
    .filter((f) => f.endsWith('.env') && f !== 'example.env')
    .map((f) => f.replace(/\.env$/, ''));
}

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

function startInstance(name) {
  if (pids[name] && isAlive(pids[name])) return { ok: true, already: true };
  const logFile = `${LOGS_DIR}/${name}.log`;
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, [`${__dirname}/index.js`, name], {
    cwd: ROOT,
    stdio: ['ignore', fd, fd],
    detached: true,
    windowsHide: true,
  });
  closeSync(fd);
  pids[name] = child.pid;
  savePids();
  child.on('exit', (code) => {
    if (pids[name] === child.pid) {
      delete pids[name];
      savePids();
    }
  });
  child.unref();
  return { ok: true, started: true, pid: child.pid };
}

function stopInstance(name) {
  const pid = pids[name];
  if (!pid) return { ok: true, already: true };
  try {
    process.kill(pid);
  } catch {
    // already dead
  }
  delete pids[name];
  savePids();
  return { ok: true, stopped: true };
}

const app = express();
app.use(requireAuth);
app.use(express.json());
app.use(express.static(`${ROOT}/public`));

app.get('/api/instances', (req, res) => {
  const list = listInstanceNames().map((name) => {
    const env = parseEnvFile(`${INSTANCES_DIR}/${name}.env`);
    const running = !!pids[name] && isAlive(pids[name]);
    return {
      name,
      groupName: env.GROUP_NAME || '',
      hasPhoneNumber: !!env.PHONE_NUMBER,
      running,
      status: readStatus(name),
      qrUrl: existsSync(`${ROOT}/qr-${name}.png`) ? `/api/instances/${name}/qr?t=${Date.now()}` : null,
    };
  });
  res.json(list);
});

app.get('/api/default-gemini-key', (req, res) => {
  const existingPerson = listPeople().find((p) => p.geminiApiKey);
  if (existingPerson) return res.json({ key: existingPerson.geminiApiKey });
  for (const name of listInstanceNames()) {
    const env = parseEnvFile(`${INSTANCES_DIR}/${name}.env`);
    if (env.GEMINI_API_KEY) return res.json({ key: env.GEMINI_API_KEY });
  }
  res.json({ key: '' });
});

// --- Conexão única do Jarvis (número dedicado) ---

app.get('/api/jarvis/status', (req, res) => {
  res.json({
    status: readStatus('jarvis'),
    qrUrl: existsSync(`${ROOT}/qr-jarvis.png`) ? `/api/jarvis/qr?t=${Date.now()}` : null,
  });
});

// Só linhas do próprio Jarvis/painel: o log bruto também recebe dumps de sessão
// do Signal (com chaves), que não devem sair pela rede.
app.get('/api/jarvis/logs', (req, res) => {
  const file = `${LOGS_DIR}/panel.log`;
  if (!existsSync(file)) return res.json({ lines: [] });
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => /^\[(jarvis|painel)\]|iniciando painel|painel encerrou/.test(l))
    .map((l) => l.replace(/(Recebido|Transcrito): .*/, '$1: (conteúdo oculto)'))
    .slice(-150);
  res.json({ lines });
});

app.get('/api/jarvis/qr', (req, res) => {
  const file = `${ROOT}/qr-jarvis.png`;
  if (!existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.post('/api/jarvis/repair', async (req, res) => {
  stopJarvisConnection();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(`${ROOT}/auth/jarvis`, { recursive: true, force: true });
  rmSync(`${ROOT}/qr-jarvis.png`, { force: true });
  rmSync(`${STATUS_DIR}/jarvis.json`, { force: true });
  try {
    await startJarvisConnection();
    res.json({ ok: true });
  } catch (err) {
    console.error('[painel] Erro ao reparear o Jarvis:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Pessoas aprovadas (conversam com o número do Jarvis) ---

app.get('/api/people', (req, res) => {
  res.json(listPeople());
});

app.put('/api/people/:id', (req, res) => {
  const { displayName, geminiApiKey, geminiModel, digestTime } = req.body || {};
  if (!geminiApiKey) return res.status(400).json({ error: 'Chave Gemini é obrigatória.' });
  const updated = updatePerson(req.params.id, { displayName, geminiApiKey, geminiModel, digestTime });
  if (!updated) return res.status(404).json({ error: 'Pessoa não encontrada.' });
  forgetBrain(req.params.id);
  res.json({ ok: true, person: updated });
});

app.delete('/api/people/:id', (req, res) => {
  forgetBrain(req.params.id);
  const removed = removePerson(req.params.id);
  res.json({ ok: removed });
});

// --- Contatos pendentes (mensagens de quem ainda não foi aprovado) ---

app.get('/api/pending', (req, res) => {
  res.json(listPending());
});

app.post('/api/pending/approve', (req, res) => {
  const { jid, displayName, geminiApiKey, geminiModel, digestTime } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'jid é obrigatório.' });
  if (!geminiApiKey) return res.status(400).json({ error: 'Chave Gemini é obrigatória.' });
  const person = addPerson({ jid, displayName, geminiApiKey, geminiModel, digestTime });
  res.json({ ok: true, person });
});

app.post('/api/pending/ignore', (req, res) => {
  const { jid } = req.body || {};
  res.json({ ok: removePending(jid) });
});

app.get('/api/instances/:name/qr', (req, res) => {
  const file = `${ROOT}/qr-${req.params.name}.png`;
  if (!existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

app.get('/api/instances/:name/logs', (req, res) => {
  const file = `${LOGS_DIR}/${req.params.name}.log`;
  if (!existsSync(file)) return res.json({ lines: [] });
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-150);
  res.json({ lines });
});

function envFileContent({ groupName, displayName, digestTime, geminiApiKey, geminiModel, phoneNumber }) {
  const lines = [`GEMINI_API_KEY=${geminiApiKey}`, `GEMINI_MODEL=${geminiModel || 'gemini-3.5-flash-lite'}`];
  if (displayName) lines.push(`DISPLAY_NAME=${displayName}`);
  if (groupName) lines.push(`GROUP_NAME=${groupName}`);
  lines.push(`DIGEST_TIME=${digestTime || '07:30'}`);
  if (phoneNumber) lines.push(`PHONE_NUMBER=${String(phoneNumber).replace(/\D/g, '')}`);
  return lines.join('\n') + '\n';
}

app.post('/api/instances', (req, res) => {
  const { name, groupName, displayName, digestTime, geminiApiKey, geminiModel, phoneNumber } = req.body || {};
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
    return res.status(400).json({ error: 'Nome inválido. Use só letras, números, - e _.' });
  }
  if (!geminiApiKey) return res.status(400).json({ error: 'Chave Gemini é obrigatória.' });
  // Normaliza pra minúsculo: Windows não distingue maiúscula/minúscula em nomes de
  // pasta, então "Maria" e "maria" acabariam colidindo na mesma sessão do WhatsApp.
  const id = name.toLowerCase();
  const collision = listInstanceNames().some((existing) => existing.toLowerCase() === id);
  if (collision) return res.status(409).json({ error: 'Já existe uma pessoa com esse identificador.' });

  const envPath = `${INSTANCES_DIR}/${id}.env`;
  writeFileSync(envPath, envFileContent({ groupName, displayName, digestTime, geminiApiKey, geminiModel, phoneNumber }), 'utf8');
  res.json({ ok: true, name: id });
});

app.get('/api/instances/:name', (req, res) => {
  const { name } = req.params;
  const envPath = `${INSTANCES_DIR}/${name}.env`;
  if (!existsSync(envPath)) return res.status(404).json({ error: 'Essa pessoa não foi encontrada.' });
  const env = parseEnvFile(envPath);
  res.json({
    name,
    displayName: env.DISPLAY_NAME || '',
    groupName: env.GROUP_NAME || '',
    phoneNumber: env.PHONE_NUMBER || '',
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || '',
    digestTime: env.DIGEST_TIME || '',
  });
});

app.put('/api/instances/:name', async (req, res) => {
  const { name } = req.params;
  const envPath = `${INSTANCES_DIR}/${name}.env`;
  if (!existsSync(envPath)) return res.status(404).json({ error: 'Essa pessoa não foi encontrada.' });
  const { groupName, displayName, digestTime, geminiApiKey, geminiModel, phoneNumber } = req.body || {};
  if (!geminiApiKey) return res.status(400).json({ error: 'Chave Gemini é obrigatória.' });

  writeFileSync(envPath, envFileContent({ groupName, displayName, digestTime, geminiApiKey, geminiModel, phoneNumber }), 'utf8');

  const wasRunning = !!pids[name] && isAlive(pids[name]);
  if (wasRunning) {
    stopInstance(name);
    // Dá um tempo pro processo antigo soltar os arquivos de sessão antes de reabrir.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    startInstance(name);
  }
  res.json({ ok: true, restarted: wasRunning });
});

app.post('/api/instances/:name/start', (req, res) => {
  const { name } = req.params;
  if (!existsSync(`${INSTANCES_DIR}/${name}.env`)) return res.status(404).json({ error: 'Essa pessoa não foi encontrada.' });
  res.json(startInstance(name));
});

app.post('/api/instances/:name/stop', (req, res) => {
  res.json(stopInstance(req.params.name));
});

app.post('/api/start-all', (req, res) => {
  res.json(listInstanceNames().map((name) => ({ name, ...startInstance(name) })));
});

app.post('/api/instances/:name/repair', async (req, res) => {
  const { name } = req.params;
  const envPath = `${INSTANCES_DIR}/${name}.env`;
  if (!existsSync(envPath)) return res.status(404).json({ error: 'Essa pessoa não foi encontrada.' });

  const wasRunning = !!pids[name] && isAlive(pids[name]);
  stopInstance(name);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  rmSync(`${ROOT}/auth/${name}`, { recursive: true, force: true });
  rmSync(`${ROOT}/qr-${name}.png`, { force: true });
  rmSync(`${STATUS_DIR}/${name}.json`, { force: true });

  startInstance(name);
  res.json({ ok: true, wasRunning });
});

app.delete('/api/instances/:name', (req, res) => {
  const { name } = req.params;
  stopInstance(name);
  const envPath = `${INSTANCES_DIR}/${name}.env`;
  if (existsSync(envPath)) unlinkSync(envPath);
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(
    isLoopback(HOST)
      ? `[painel] Rodando em http://localhost:${PORT} (só acessível desta máquina)`
      : `[painel] Rodando em http://${HOST}:${PORT} (acessível pela rede, protegido por senha)`,
  );
});

// JARVIS_DISABLED=1 sobe só o painel, sem WhatsApp nem lembretes (útil pra testar
// a interface sem derrubar a sessão que está rodando em outro lugar).
if (process.env.JARVIS_DISABLED !== '1') {
  try {
    const migrated = migrateDigestDefaults();
    if (migrated) console.log(`[painel] Resumo matinal (07:30) ligado por padrão pra ${migrated} pessoa(s).`);
    await startJarvisConnection();
    startPeopleScheduler();
  } catch (err) {
    console.error('[painel] Erro ao iniciar a conexão do Jarvis:', err.message);
  }
}
