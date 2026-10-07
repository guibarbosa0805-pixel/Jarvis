import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const instancesDir = `${__dirname}/../instances`;
const projectRoot = `${__dirname}/..`;

const names = readdirSync(instancesDir)
  .filter((f) => f.endsWith('.env') && f !== 'example.env')
  .map((f) => f.replace(/\.env$/, ''));

if (names.length === 0) {
  console.error('Nenhuma instância configurada em instances/*.env (veja instances/example.env).');
  process.exit(1);
}

console.log(`Iniciando ${names.length} instância(s): ${names.join(', ')}`);

for (const name of names) {
  const child = spawn(process.execPath, [`${__dirname}/index.js`, name], {
    stdio: 'inherit',
    cwd: projectRoot,
  });
  child.on('exit', (code) => {
    console.error(`[jarvis:${name}] processo encerrou (code ${code}).`);
  });
}
