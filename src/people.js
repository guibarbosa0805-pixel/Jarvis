import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = `${__dirname}/../data`;
const INSTANCES_DIR = `${__dirname}/../instances`;
const PEOPLE_FILE = `${DATA_DIR}/people.json`;
const PENDING_FILE = `${DATA_DIR}/pending-contacts.json`;
const DEFAULT_DIGEST_TIME = '07:30';

function ensureFile(file) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(file)) writeFileSync(file, '[]', 'utf8');
}

function readJson(file) {
  ensureFile(file);
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(file, data) {
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// --- Pessoas aprovadas (quem o Jarvis já atende) ---

export function listPeople() {
  return readJson(PEOPLE_FILE);
}

export function findPersonByJid(jid) {
  return listPeople().find((p) => p.jid === jid) || null;
}

export function findPersonById(id) {
  return listPeople().find((p) => p.id === id) || null;
}

/**
 * Chave/modelo Gemini pra usar no auto-registro de gente nova: reaproveita a
 * de alguém já cadastrado, ou (bootstrap) a de alguma instância do modo antigo.
 */
export function findDefaultGeminiKey() {
  const existing = listPeople().find((p) => p.geminiApiKey);
  if (existing) return { apiKey: existing.geminiApiKey, model: existing.geminiModel };

  if (existsSync(INSTANCES_DIR)) {
    for (const file of readdirSync(INSTANCES_DIR)) {
      if (!file.endsWith('.env') || file === 'example.env') continue;
      const content = readFileSync(`${INSTANCES_DIR}/${file}`, 'utf8');
      const apiKey = content.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim();
      if (apiKey) return { apiKey, model: content.match(/^GEMINI_MODEL=(.*)$/m)?.[1]?.trim() };
    }
  }
  return null;
}

export function addPerson({ jid, displayName, geminiApiKey, geminiModel, digestTime }) {
  const people = listPeople();
  const id = (displayName || jid.split('@')[0]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || nanoid(6);
  let uniqueId = id;
  let n = 2;
  while (people.some((p) => p.id === uniqueId)) uniqueId = `${id}-${n++}`;

  const person = {
    id: uniqueId,
    jid,
    displayName: displayName || jid.split('@')[0],
    geminiApiKey,
    geminiModel: geminiModel || 'gemini-3.5-flash-lite',
    // undefined = padrão (07:30); '' = a pessoa escolheu não receber resumo.
    digestTime: digestTime === undefined ? DEFAULT_DIGEST_TIME : digestTime,
    digestMigrated: true,
    createdAt: new Date().toISOString(),
  };
  people.push(person);
  writeJson(PEOPLE_FILE, people);
  removePending(jid);
  return person;
}

/** Liga o resumo matinal pra quem foi cadastrado antes dele ser padrão (uma vez só). */
export function migrateDigestDefaults() {
  const people = listPeople();
  let changed = 0;
  for (const person of people) {
    if (person.digestMigrated) continue;
    if (!person.digestTime) person.digestTime = DEFAULT_DIGEST_TIME;
    person.digestMigrated = true;
    changed++;
  }
  if (changed) writeJson(PEOPLE_FILE, people);
  return changed;
}

export function updatePerson(id, patch) {
  const people = listPeople();
  const person = people.find((p) => p.id === id);
  if (!person) return null;
  Object.assign(person, patch);
  writeJson(PEOPLE_FILE, people);
  return person;
}

export function removePerson(id) {
  const people = listPeople();
  const idx = people.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  people.splice(idx, 1);
  writeJson(PEOPLE_FILE, people);
  return true;
}

// --- Contatos pendentes (mensagens de quem ainda não foi aprovado) ---

export function listPending() {
  return readJson(PENDING_FILE);
}

export function addOrTouchPending(jid, pushName) {
  const pending = readJson(PENDING_FILE);
  let entry = pending.find((p) => p.jid === jid);
  if (!entry) {
    entry = { jid, pushName: pushName || '', firstMessageAt: new Date().toISOString(), notified: false };
    pending.push(entry);
    writeJson(PENDING_FILE, pending);
  } else if (pushName && entry.pushName !== pushName) {
    entry.pushName = pushName;
    writeJson(PENDING_FILE, pending);
  }
  return entry;
}

export function markPendingNotified(jid) {
  const pending = readJson(PENDING_FILE);
  const entry = pending.find((p) => p.jid === jid);
  if (!entry) return;
  entry.notified = true;
  writeJson(PENDING_FILE, pending);
}

export function removePending(jid) {
  const pending = readJson(PENDING_FILE);
  const idx = pending.findIndex((p) => p.jid === jid);
  if (idx === -1) return false;
  pending.splice(idx, 1);
  writeJson(PENDING_FILE, pending);
  return true;
}
