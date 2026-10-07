import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = `${__dirname}/../data/tasks.json`;

function ensureDataFile() {
  const dir = dirname(DATA_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(DATA_FILE)) writeFileSync(DATA_FILE, '[]', 'utf8');
}

function readAll() {
  ensureDataFile();
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

function writeAll(tasks) {
  writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2), 'utf8');
}

export function addTask({ title, notes, dueAt }) {
  const tasks = readAll();
  const task = {
    id: nanoid(8),
    title,
    notes: notes || '',
    dueAt: dueAt || null,
    status: 'pending',
    notified: false,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  writeAll(tasks);
  return task;
}

export function listPending() {
  return readAll()
    .filter((t) => t.status === 'pending')
    .sort((a, b) => (a.dueAt || '').localeCompare(b.dueAt || ''));
}

export function completeTask(id) {
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  task.status = 'done';
  task.completedAt = new Date().toISOString();
  writeAll(tasks);
  return task;
}

export function deleteTask(id) {
  const tasks = readAll();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  writeAll(tasks);
  return true;
}

export function findDueUnnotified(now = new Date()) {
  return readAll().filter(
    (t) => t.status === 'pending' && !t.notified && t.dueAt && new Date(t.dueAt) <= now,
  );
}

export function markNotified(id) {
  const tasks = readAll();
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.notified = true;
  writeAll(tasks);
}
