import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATUS_DIR = `${__dirname}/../status`;

function ensureDir() {
  if (!existsSync(STATUS_DIR)) mkdirSync(STATUS_DIR, { recursive: true });
}

export function writeStatus(name, patch) {
  ensureDir();
  const file = `${STATUS_DIR}/${name}.json`;
  let current = {};
  if (existsSync(file)) {
    try {
      current = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      current = {};
    }
  }
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
}

export function readStatus(name) {
  const file = `${STATUS_DIR}/${name}.json`;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
