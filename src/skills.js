import { GoogleGenAI } from '@google/genai';
import { requestFromDesktop } from './desktop.js';

// Habilidades novas do Jarvis: pesquisa na internet, ações no computador da pessoa
// (abrir programas e sites, digitar, ler a área de transferência) e conflitos na agenda.

// ---------- Pesquisa na internet ----------
// No plano gratuito do Gemini, a busca do Google só vem liberada em alguns modelos.
const SEARCH_MODELS = (process.env.GEMINI_SEARCH_MODEL || 'gemini-2.5-flash').split(',').map((m) => m.trim()).filter(Boolean);

export async function webSearch(apiKey, query) {
  const ai = new GoogleGenAI({ apiKey });
  let lastError = null;
  for (const model of SEARCH_MODELS) {
    try {
      const r = await ai.models.generateContent({
        model,
        contents: `Pesquise na internet e responda em português do Brasil, objetivo, em até 5 frases, com dados atualizados (diga a data quando fizer diferença): ${query}`,
        config: { tools: [{ googleSearch: {} }] },
      });
      const sources = (r.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
        .map((c) => c.web)
        .filter(Boolean)
        .slice(0, 3)
        .map((w) => ({ title: w.title, url: w.uri }));
      return { ok: true, answer: r.text?.trim() || '', sources };
    } catch (err) {
      lastError = err;
    }
  }
  const quota = lastError?.status === 429;
  return { ok: false, error: quota ? 'A cota diária de pesquisas acabou; volta amanhã.' : 'Não consegui pesquisar agora.' };
}

// ---------- Ações no computador ----------
// Só abre o que está nesta lista (ou um link http/https): o pedido vem do modelo, então
// nada de executar comandos livres no PC da pessoa.

const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export const COMPUTER_APPS = {
  chrome: 'chrome',
  'google chrome': 'chrome',
  brave: 'brave',
  edge: 'msedge',
  'microsoft edge': 'msedge',
  excel: 'excel',
  word: 'winword',
  powerpoint: 'powerpnt',
  outlook: 'outlook',
  teams: 'ms-teams:',
  'microsoft teams': 'ms-teams:',
  whatsapp: 'whatsapp:',
  spotify: 'spotify:',
  calculadora: 'calc',
  'bloco de notas': 'notepad',
  notepad: 'notepad',
  paint: 'mspaint',
  explorador: 'explorer',
  'explorador de arquivos': 'explorer',
  'meus arquivos': 'explorer',
  configuracoes: 'ms-settings:',
  'configuracoes do windows': 'ms-settings:',
};

/** Resolve "excel" -> alvo conhecido, ou um link http(s). null se não for permitido. */
export function resolveOpenTarget(target) {
  const raw = String(target || '').trim();
  if (/^https?:\/\/\S+$/i.test(raw)) return { kind: 'url', target: raw };
  const app = COMPUTER_APPS[normalize(raw)];
  return app ? { kind: 'app', target: app, name: raw } : null;
}

export async function readDesktopClipboard(personId) {
  try {
    const text = String((await requestFromDesktop(personId, 'clipboard')) || '');
    if (!text.trim()) return { ok: false, error: 'A área de transferência do computador está vazia (ou não é texto).' };
    const max = 8000;
    return { ok: true, text: text.slice(0, max), truncated: text.length > max };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- Agenda ----------

/** Compromissos pendentes a menos de `windowMin` minutos do horário dado (fora o próprio). */
export function findConflicts(store, dueAt, excludeId, windowMin = 30) {
  const at = new Date(dueAt).getTime();
  return store
    .listPending()
    .filter((t) => t.id !== excludeId && t.dueAt && Math.abs(new Date(t.dueAt).getTime() - at) < windowMin * 60000);
}
