import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Atualização automática do servidor (autorizada pelo dono): a cada poucos minutos confere o
// GitHub (origin/main). Havendo commit novo, puxa, reinstala dependências se mudaram e encerra
// o processo; o supervisor (scripts/run-forever.cmd) sobe de novo já com o código novo.
// Para desligar: AUTO_UPDATE=0 no panel.env.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAG = '[painel]';
const INTERVAL_MS = Number(process.env.AUTO_UPDATE_MINUTES || 3) * 60 * 1000;

function run(cmd, args, timeout = 120000) {
  return new Promise((resolvePromise, reject) => {
    // safe.directory: a tarefa roda como SYSTEM e o git recusa repositórios de outro dono.
    const fullArgs = cmd === 'git' ? ['-c', 'safe.directory=*', ...args] : args;
    execFile(cmd, fullArgs, { cwd: ROOT, timeout, windowsHide: true, shell: cmd !== 'git' }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolvePromise(stdout.trim());
    });
  });
}

let busy = false;

async function checkForUpdate() {
  if (busy) return;
  busy = true;
  try {
    await run('git', ['fetch', '--quiet', 'origin', 'main']);
    const [local, remote] = await Promise.all([run('git', ['rev-parse', 'HEAD']), run('git', ['rev-parse', 'origin/main'])]);
    if (local === remote) return;

    const changed = await run('git', ['diff', '--name-only', local, remote]);
    console.log(`${TAG} Atualização encontrada (${local.slice(0, 7)} -> ${remote.slice(0, 7)}), aplicando...`);
    // O npm install reescreve o package-lock local; ele não tem nada nosso, então descarta antes de puxar.
    await run('git', ['checkout', '--', 'package-lock.json']).catch(() => {});
    await run('git', ['merge', '--ff-only', 'origin/main']);
    if (/^(package\.json|package-lock\.json)$/m.test(changed)) {
      console.log(`${TAG} Dependências mudaram, rodando npm install...`);
      await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], 10 * 60 * 1000);
    }
    console.log(`${TAG} Atualizado para ${remote.slice(0, 7)}. Reiniciando...`);
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    console.error(`${TAG} Falha na atualização automática:`, err.message);
  } finally {
    busy = false;
  }
}

export function startAutoUpdate() {
  if (process.env.AUTO_UPDATE === '0') return;
  setTimeout(checkForUpdate, 30 * 1000);
  setInterval(checkForUpdate, INTERVAL_MS);
  console.log(`${TAG} Atualização automática ativa (a cada ${INTERVAL_MS / 60000} min).`);
}
