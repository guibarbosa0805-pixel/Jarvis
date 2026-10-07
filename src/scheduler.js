import cron from 'node-cron';
import { findDueUnnotified, markNotified } from './store.js';

const TAG = `[jarvis:${process.env.INSTANCE_NAME || 'default'}]`;

export function startScheduler({ sendToJarvis }) {
  cron.schedule('* * * * *', async () => {
    const due = findDueUnnotified();
    for (const task of due) {
      try {
        await sendToJarvis(`⏰ Lembrete: *${task.title}*${task.notes ? `\n${task.notes}` : ''}`);
        markNotified(task.id);
      } catch (err) {
        console.error(`${TAG} Falha ao enviar lembrete:`, err.message);
      }
    }
  });
  console.log(`${TAG} Agendador de lembretes ativo (checagem a cada minuto).`);
}
