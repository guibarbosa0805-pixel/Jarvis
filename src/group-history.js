import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Histórico de texto dos grupos onde a pessoa ligou o recurso (opt-in por grupo). Serve só pra
// busca e resumos pedidos ao Jarvis no próprio grupo. Regras de privacidade:
// - só texto (nada de foto, áudio ou documento);
// - apaga sozinho depois de N dias (padrão 30);
// - fica em data/group-history/ na máquina do servidor, fora do git.

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = `${__dirname}/../data/group-history`;
export const DEFAULT_RETENTION_DAYS = 30;
const MAX_MESSAGES = 8000;
const MAX_TEXT = 1500;

const fileFor = (groupJid) => `${DIR}/${String(groupJid).split('@')[0]}.jsonl`;

function readAll(groupJid) {
  const file = fileFor(groupJid);
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // linha corrompida: ignora
    }
  }
  return out;
}

const lastPrune = new Map();

/** Guarda uma mensagem. entry: { id, ts (ms), sender, senderJid, text, mine } */
export function recordGroupMessage(groupJid, entry, retentionDays = DEFAULT_RETENTION_DAYS) {
  const text = String(entry.text || '').trim().slice(0, MAX_TEXT);
  if (!text || !entry.id) return;
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  appendFileSync(fileFor(groupJid), `${JSON.stringify({ ...entry, text })}\n`, 'utf8');

  // Limpeza: no máximo uma vez por hora por grupo.
  const now = Date.now();
  if (now - (lastPrune.get(groupJid) || 0) > 3600000) {
    lastPrune.set(groupJid, now);
    pruneGroupHistory(groupJid, retentionDays);
  }
}

export function pruneGroupHistory(groupJid, retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = Date.now() - retentionDays * 86400000;
  const all = readAll(groupJid);
  const kept = all.filter((m) => m.ts >= cutoff).slice(-MAX_MESSAGES);
  if (kept.length !== all.length) {
    writeFileSync(fileFor(groupJid), kept.map((m) => JSON.stringify(m)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
  }
  return all.length - kept.length;
}

export function clearGroupHistory(groupJid) {
  const file = fileFor(groupJid);
  if (existsSync(file)) unlinkSync(file);
}

export function countGroupMessages(groupJid) {
  return readAll(groupJid).length;
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Visão da mensagem pro modelo: horário local pronto (nunca UTC). */
export function messageView(m) {
  const d = new Date(m.ts);
  return {
    id: m.id,
    when: `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
    from: m.mine ? 'Jarvis' : m.sender || 'Participante',
    text: m.text,
  };
}

/** Mensagens de um período (padrão: hoje), em ordem, limitadas pra caber no modelo. */
export function getGroupMessages(groupJid, { date, hours, limit = 250 } = {}) {
  const all = readAll(groupJid);
  let since;
  let until = Date.now();
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [y, mo, d] = date.split('-').map(Number);
    since = new Date(y, mo - 1, d).getTime();
    until = since + 86400000;
  } else if (hours) {
    since = Date.now() - Number(hours) * 3600000;
  } else {
    const now = new Date();
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  }
  const inRange = all.filter((m) => m.ts >= since && m.ts < until);
  let chars = 0;
  const picked = [];
  // Se passar do limite, fica com as mais recentes.
  for (let i = inRange.length - 1; i >= 0 && picked.length < limit; i--) {
    chars += inRange[i].text.length + 40;
    if (chars > 14000) break;
    picked.unshift(inRange[i]);
  }
  return { total_in_period: inRange.length, returned: picked.length, messages: picked.map(messageView) };
}

/** Busca por palavras (todas precisam aparecer), mais recentes primeiro. */
export function searchGroupMessages(groupJid, query, { days = 30, person, limit = 12 } = {}) {
  const words = norm(query).split(' ').filter((w) => w.length >= 3);
  if (!words.length) return { total: 0, messages: [] };
  const since = Date.now() - Number(days || 30) * 86400000;
  const who = person ? norm(person) : '';
  const hits = readAll(groupJid).filter((m) => {
    if (m.ts < since) return false;
    if (who && !norm(m.mine ? 'jarvis' : m.sender).includes(who)) return false;
    const text = norm(m.text);
    return words.every((w) => text.includes(w));
  });
  hits.sort((a, b) => b.ts - a.ts);
  return { total: hits.length, messages: hits.slice(0, limit).map(messageView) };
}

/** Mensagem original (pra responder citando). */
export function getGroupMessageById(groupJid, id) {
  return readAll(groupJid).find((m) => m.id === id) || null;
}
