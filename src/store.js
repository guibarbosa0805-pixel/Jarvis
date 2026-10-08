import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LEAD_MINUTES = 30;

function makeStore(dataFile) {
  function ensureDataFile() {
    const dir = dirname(dataFile);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(dataFile)) writeFileSync(dataFile, '[]', 'utf8');
  }

  function readAll() {
    ensureDataFile();
    return JSON.parse(readFileSync(dataFile, 'utf8'));
  }

  function writeAll(tasks) {
    writeFileSync(dataFile, JSON.stringify(tasks, null, 2), 'utf8');
  }

  function addTask({ title, notes, dueAt, link, leadMinutes }) {
    const tasks = readAll();
    const task = {
      id: nanoid(8),
      title,
      notes: notes || '',
      dueAt: dueAt || null,
      link: link || null,
      leadMinutes: Number.isFinite(leadMinutes) ? leadMinutes : DEFAULT_LEAD_MINUTES,
      status: 'pending',
      leadSent: false,
      dueSent: false,
      createdAt: new Date().toISOString(),
    };
    tasks.push(task);
    writeAll(tasks);
    return task;
  }

  function listPending() {
    return readAll()
      .filter((t) => t.status === 'pending')
      .sort((a, b) => (a.dueAt || '').localeCompare(b.dueAt || ''));
  }

  function completeTask(id) {
    const tasks = readAll();
    const task = tasks.find((t) => t.id === id);
    if (!task) return null;
    task.status = 'done';
    task.completedAt = new Date().toISOString();
    writeAll(tasks);
    return task;
  }

  function deleteTask(id) {
    const tasks = readAll();
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    tasks.splice(idx, 1);
    writeAll(tasks);
    return true;
  }

  function findDueLead(now = new Date()) {
    return readAll().filter((t) => {
      if (t.status !== 'pending' || t.leadSent || !t.dueAt) return false;
      const leadAt = new Date(t.dueAt).getTime() - (t.leadMinutes ?? DEFAULT_LEAD_MINUTES) * 60000;
      return leadAt <= now.getTime();
    });
  }

  function findDueNow(now = new Date()) {
    return readAll().filter((t) => t.status === 'pending' && !t.dueSent && t.dueAt && new Date(t.dueAt) <= now);
  }

  function markLeadSent(id) {
    const tasks = readAll();
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    task.leadSent = true;
    writeAll(tasks);
  }

  function markDueSent(id) {
    const tasks = readAll();
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    task.dueSent = true;
    writeAll(tasks);
  }

  return { addTask, listPending, completeTask, deleteTask, findDueLead, findDueNow, markLeadSent, markDueSent };
}

/** Store para um nome de instância qualquer (usado pelo chat web do painel). */
export function createStore(instanceName) {
  return makeStore(`${__dirname}/../data/${instanceName}.json`);
}

// Store do processo atual, baseado em INSTANCE_NAME (usado pelo bot do WhatsApp).
const defaultStore = makeStore(`${__dirname}/../data/${process.env.INSTANCE_NAME || 'default'}.json`);

export const {
  addTask,
  listPending,
  completeTask,
  deleteTask,
  findDueLead,
  findDueNow,
  markLeadSent,
  markDueSent,
} = defaultStore;
