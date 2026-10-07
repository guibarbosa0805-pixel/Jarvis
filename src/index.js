import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const instance = process.argv[2] || process.env.INSTANCE_NAME || 'default';
const envPath = `${__dirname}/../instances/${instance}.env`;
const TAG = `[jarvis:${instance}]`;

if (!existsSync(envPath)) {
  console.error(`${TAG} Arquivo de config não encontrado: instances/${instance}.env`);
  console.error(`${TAG} Copie instances/example.env para instances/${instance}.env e preencha os dados.`);
  process.exit(1);
}

loadEnv({ path: envPath });
process.env.INSTANCE_NAME = instance;

if (!process.env.GEMINI_API_KEY) {
  console.error(`${TAG} Defina GEMINI_API_KEY em instances/${instance}.env antes de iniciar.`);
  process.exit(1);
}

// Imports dinâmicos: precisam vir depois de process.env estar populado,
// já que whatsapp.js/store.js leem INSTANCE_NAME/GROUP_NAME no topo do módulo.
const { startWhatsApp } = await import('./whatsapp.js');
const { startScheduler } = await import('./scheduler.js');
const { handleIncomingMessage } = await import('./gemini.js');

async function main() {
  const { events, sendToJarvis } = await startWhatsApp();

  events.on('message', async (text) => {
    console.log(`${TAG} Recebido: ${text}`);
    try {
      const reply = await handleIncomingMessage(text);
      await sendToJarvis(reply);
    } catch (err) {
      console.error(`${TAG} Erro ao responder:`, err);
      try {
        await sendToJarvis('Deu um erro aqui do meu lado 🙃 tenta de novo.');
      } catch {
        // ignore secondary failure
      }
    }
  });

  startScheduler({ sendToJarvis });
}

main();
