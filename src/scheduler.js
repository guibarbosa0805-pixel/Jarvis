import cron from 'node-cron';
import { findDueUnnotified, markNotified } from './store.js';

export function startScheduler({ sendToJarvis }) {
  cron.schedule('* * * * *', async () => {
    const due = findDueUnnotified();
    for (const task of due) {
      try {
        await sendToJarvis(`⏰ Lembrete: *${task.title}*${task.notes ? `\n${task.notes}` : ''}`);
        markNotified(task.id);
      } catch (err) {
        console.error('[jarvis] Falha ao enviar lembrete:', err.message);
      }
    }
  });
  console.log('[jarvis] Agendador de lembretes ativo (checagem a cada minuto).');
}
