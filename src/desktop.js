import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Ligação entre o Jarvis (servidor) e o app do computador: pareamento por código,
// tokens por aparelho e um canal de eventos (SSE) pra mandar ações ao PC
// (tocar música, notificação de lembrete) mesmo quando o pedido veio do WhatsApp.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKENS_FILE = `${__dirname}/../data/desktop-tokens.json`;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PAIR_ATTEMPTS = 8;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// --- Pareamento ---

const codes = new Map(); // código -> { personId, expiresAt }

/** Gera um código de 6 dígitos (vale 10 min) para a pessoa conectar o app do computador. */
export function createPairingCode(personId) {
  for (const [code, entry] of codes) if (entry.personId === personId || entry.expiresAt < Date.now()) codes.delete(code);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  codes.set(code, { personId, expiresAt: Date.now() + CODE_TTL_MS });
  return { code, expiresInMinutes: CODE_TTL_MS / 60000 };
}

let failedAttempts = [];

/** Troca um código válido por um token do aparelho. Limita tentativas pra não dar pra adivinhar. */
export function redeemPairingCode(code) {
  const now = Date.now();
  failedAttempts = failedAttempts.filter((t) => now - t < 60_000);
  if (failedAttempts.length >= MAX_PAIR_ATTEMPTS) return { error: 'Muitas tentativas. Aguarde um minuto.' };

  const entry = codes.get(String(code || '').trim());
  if (!entry || entry.expiresAt < now) {
    failedAttempts.push(now);
    return { error: 'Código inválido ou expirado. Peça um novo ao Jarvis no WhatsApp.' };
  }
  codes.delete(code);
  return { token: issueToken(entry.personId), personId: entry.personId };
}

function issueToken(personId) {
  const token = randomBytes(32).toString('hex');
  const tokens = readTokens();
  tokens[sha256(token)] = { personId, createdAt: new Date().toISOString() };
  writeTokens(tokens);
  return token;
}

// --- Pareamento iniciado pelo app (a pessoa só aperta "enviar" no WhatsApp) ---
// O app pede um código, abre o WhatsApp com "conectar computador 123456" pronto e fica
// perguntando; quando a mensagem chega do número da pessoa, o Jarvis aprova e entrega o token.

const requests = new Map(); // código -> { secret, expiresAt, personId, token }

export function createDesktopRequest() {
  const now = Date.now();
  for (const [code, entry] of requests) if (entry.expiresAt < now) requests.delete(code);
  let code;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  while (requests.has(code) || codes.has(code));
  const secret = randomBytes(24).toString('hex');
  requests.set(code, { secret, expiresAt: now + CODE_TTL_MS, personId: null, token: null });
  return { code, secret, expiresInMinutes: CODE_TTL_MS / 60000 };
}

/** Chamado quando uma mensagem do WhatsApp traz o código: liga o computador àquela pessoa. */
export function approveDesktopRequest(code, personId) {
  const entry = requests.get(code);
  if (!entry || entry.expiresAt < Date.now() || entry.personId) return false;
  entry.personId = personId;
  entry.token = issueToken(personId);
  return true;
}

/** O app pergunta se já foi aprovado; o token é entregue uma única vez. */
export function pollDesktopRequest(code, secret) {
  const entry = requests.get(code);
  if (!entry || entry.secret !== secret) return { status: 'expired' };
  if (entry.expiresAt < Date.now() && !entry.token) {
    requests.delete(code);
    return { status: 'expired' };
  }
  if (!entry.token) return { status: 'pending' };
  requests.delete(code);
  return { status: 'approved', token: entry.token, personId: entry.personId };
}

function readTokens() {
  if (!existsSync(TOKENS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeTokens(tokens) {
  const dir = dirname(TOKENS_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), 'utf8');
}

export function personIdFromToken(token) {
  if (!token) return null;
  return readTokens()[sha256(token)]?.personId ?? null;
}

/** Revoga todos os aparelhos de uma pessoa (ao remover a pessoa). */
export function revokeTokensOf(personId) {
  const tokens = readTokens();
  let changed = false;
  for (const [hash, entry] of Object.entries(tokens)) {
    if (entry.personId === personId) {
      delete tokens[hash];
      changed = true;
    }
  }
  if (changed) writeTokens(tokens);
  disconnectAll(personId);
}

// --- Canal de eventos (SSE) ---

const connections = new Map(); // personId -> Set<res>

export function attachClient(personId, res) {
  if (!connections.has(personId)) connections.set(personId, new Set());
  connections.get(personId).add(res);
  res.on('close', () => {
    connections.get(personId)?.delete(res);
    if (!connections.get(personId)?.size) connections.delete(personId);
  });
}

function disconnectAll(personId) {
  for (const res of connections.get(personId) ?? []) res.end();
  connections.delete(personId);
}

export function isDesktopOnline(personId) {
  return (connections.get(personId)?.size ?? 0) > 0;
}

/** Manda um evento aos computadores conectados da pessoa. Devolve quantos receberam. */
export function pushToDesktop(personId, event) {
  const clients = connections.get(personId);
  if (!clients?.size) return 0;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(payload);
  return clients.size;
}
