import express from 'express';
import { spawn } from 'node:child_process';
import { readdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readStatus } from './status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = `${__dirname}/..`;
const INSTANCES_DIR = `${ROOT}/instances`;
const LOGS_DIR = `${ROOT}/logs`;
const STATUS_DIR = `${ROOT}/status`;
const PIDS_FILE = `${STATUS_DIR}/pids.json`;
const PORT = Number(process.env.PANEL_PORT) || 4545;

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
app.use(express.json());
app.use(express.static(`${__dirname}/../public`));

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
  for (const name of listInstanceNames()) {
    const env = parseEnvFile(`${INSTANCES_DIR}/${name}.env`);
    if (env.GEMINI_API_KEY) return res.json({ key: env.GEMINI_API_KEY });
  }
  res.json({ key: '' });
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

app.post('/api/instances', (req, res) => {
  const { name, groupName, geminiApiKey, geminiModel, phoneNumber } = req.body || {};
  if (!name || !/^[a-z0-9_-]+$/i.test(name)) {
    return res.status(400).json({ error: 'Nome inválido. Use só letras, números, - e _.' });
  }
  if (!groupName) return res.status(400).json({ error: 'Nome do grupo é obrigatório.' });
  if (!geminiApiKey) return res.status(400).json({ error: 'Chave Gemini é obrigatória.' });
  const envPath = `${INSTANCES_DIR}/${name}.env`;
  if (existsSync(envPath)) return res.status(409).json({ error: 'Já existe uma instância com esse nome.' });

  const lines = [
    `GEMINI_API_KEY=${geminiApiKey}`,
    `GEMINI_MODEL=${geminiModel || 'gemini-2.5-flash'}`,
    `GROUP_NAME=${groupName}`,
  ];
  if (phoneNumber) lines.push(`PHONE_NUMBER=${String(phoneNumber).replace(/\D/g, '')}`);
  writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
  res.json({ ok: true });
});

app.post('/api/instances/:name/start', (req, res) => {
  const { name } = req.params;
  if (!existsSync(`${INSTANCES_DIR}/${name}.env`)) return res.status(404).json({ error: 'Instância não encontrada.' });
  res.json(startInstance(name));
});

app.post('/api/instances/:name/stop', (req, res) => {
  res.json(stopInstance(req.params.name));
});

app.post('/api/start-all', (req, res) => {
  res.json(listInstanceNames().map((name) => ({ name, ...startInstance(name) })));
});

app.delete('/api/instances/:name', (req, res) => {
  const { name } = req.params;
  stopInstance(name);
  const envPath = `${INSTANCES_DIR}/${name}.env`;
  if (existsSync(envPath)) unlinkSync(envPath);
  res.json({ ok: true });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[painel] Rodando em http://localhost:${PORT} (só acessível desta máquina)`);
});
