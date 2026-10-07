import 'dotenv/config';
import { startWhatsApp } from './whatsapp.js';
import { startScheduler } from './scheduler.js';
import { handleIncomingMessage } from './gemini.js';

if (!process.env.GEMINI_API_KEY) {
  console.error('[jarvis] Defina GEMINI_API_KEY no arquivo .env antes de iniciar.');
  process.exit(1);
}

async function main() {
  const { events, sendToJarvis } = await startWhatsApp();

  events.on('message', async (text) => {
    console.log(`[jarvis] Recebido: ${text}`);
    try {
      const reply = await handleIncomingMessage(text);
      await sendToJarvis(reply);
    } catch (err) {
      console.error('[jarvis] Erro ao responder:', err);
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
