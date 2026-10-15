import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = `${__dirname}/../data/memory`;
const MAX_NOTES = 30;
const MAX_INTERESTS = 10;
const MAX_HISTORY_CONTENTS = 40;

const EMPTY = () => ({ profile: { city: '', interests: [], notes: [] }, history: [] });

function isUserText(content) {
  return content?.role === 'user' && !content.parts?.some((p) => p.functionResponse);
}

/** Tira mídia pesada e corta no começo de um turno completo (sem separar chamada/resposta de função). */
export function sanitizeHistory(contents) {
  const slim = (contents || []).map((c) => ({
    ...c,
    parts: (c.parts || []).map((p) => (p.inlineData ? { text: '[mídia enviada anteriormente]' } : p)),
  }));
  if (slim.length <= MAX_HISTORY_CONTENTS) return slim;
  let start = slim.length - MAX_HISTORY_CONTENTS;
  while (start < slim.length && !isUserText(slim[start])) start++;
  return slim.slice(start);
}

const TURN_PREFIX = /^\[Data\/hora atual:[^\]]*\](?: \[Canal:[^\]]*\])?\n/;

/** Conversa em texto puro (quem falou o quê), pra mostrar no app do computador. */
export function readableMessages(contents, limit = 30) {
  const out = [];
  for (const c of contents || []) {
    if (c.role !== 'user' && c.role !== 'model') continue;
    const text = (c.parts || [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .replace(TURN_PREFIX, '')
      .trim();
    if (text) out.push({ role: c.role === 'model' ? 'jarvis' : 'user', text });
  }
  return out.slice(-limit);
}

export function createMemory(id) {
  const file = `${MEMORY_DIR}/${id}.json`;

  function read() {
    if (!existsSync(file)) return EMPTY();
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return { ...EMPTY(), ...data, profile: { ...EMPTY().profile, ...(data.profile || {}) } };
    } catch {
      return EMPTY();
    }
  }

  function write(data) {
    if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    getProfile: () => read().profile,

    updateProfile({ city, addInterests, addNotes }) {
      const data = read();
      const p = data.profile;
      if (typeof city === 'string' && city.trim()) p.city = city.trim();
      const merge = (list, items, max) => {
        for (const item of items || []) {
          const v = String(item).trim();
          if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) list.push(v);
        }
        return list.slice(-max);
      };
      p.interests = merge(p.interests, addInterests, MAX_INTERESTS);
      p.notes = merge(p.notes, addNotes, MAX_NOTES);
      write(data);
      return p;
    },

    loadHistory: () => read().history,

    saveHistory(contents) {
      const data = read();
      data.history = sanitizeHistory(contents);
      write(data);
    },

    clearAll() {
      write(EMPTY());
    },

    clearHistory() {
      const data = read();
      data.history = [];
      write(data);
    },
  };
}
