import cron from 'node-cron';
import { findDueLead, findDueNow, markLeadSent, markDueSent, listPending } from './store.js';
import { formatDateShort, formatTime, formatDateTimeFull } from './format.js';

const TAG = `[jarvis:${process.env.INSTANCE_NAME || 'default'}]`;
const DISPLAY_NAME =
  process.env.DISPLAY_NAME || (process.env.INSTANCE_NAME || 'você').replace(/^./, (c) => c.toUpperCase());
const DIGEST_TIME = process.env.DIGEST_TIME || '';

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startScheduler({ sendToJarvis }) {
  cron.schedule('* * * * *', async () => {
    const now = new Date();

    for (const task of findDueLead(now)) {
      try {
        const lines = [`⏰ Lembrete: faltam ${task.leadMinutes} min!`, '', `📅 ${task.title}`, `📆 ${formatDateShort(task.dueAt)} às ${formatTime(task.dueAt)}`];
        if (task.link) lines.push(`🔗 Link: ${task.link}`);
        await sendToJarvis(lines.join('\n'));
        markLeadSent(task.id);
      } catch (err) {
        console.error(`${TAG} Falha ao enviar lembrete antecipado:`, err.message);
      }
    }

    for (const task of findDueNow(now)) {
      try {
        const lines = ['Lembrete, AGORA!:', task.title, '', 'Data e hora:', `📅 ${formatDateTimeFull(task.dueAt)}`];
        if (task.link) lines.push('', `🔗 ${task.link}`);
        await sendToJarvis(lines.join('\n'));
        markDueSent(task.id);
      } catch (err) {
        console.error(`${TAG} Falha ao enviar lembrete:`, err.message);
      }
    }
  });

  if (DIGEST_TIME && /^\d{1,2}:\d{2}$/.test(DIGEST_TIME)) {
    const [hour, minute] = DIGEST_TIME.split(':').map(Number);
    cron.schedule(`${minute} ${hour} * * *`, async () => {
      const today = new Date();
      const todays = listPending().filter((t) => t.dueAt && isSameDay(new Date(t.dueAt), today));
      if (todays.length === 0) return;
      const lines = [`Oii ${DISPLAY_NAME} 😊, tudo bem?`, '', 'Agendamento(s) de hoje:', ''];
      for (const t of todays) lines.push(`📅 ${formatTime(t.dueAt)} - ${t.title}`);
      try {
        await sendToJarvis(lines.join('\n'));
      } catch (err) {
        console.error(`${TAG} Falha ao enviar resumo matinal:`, err.message);
      }
    });
    console.log(`${TAG} Resumo matinal ativo às ${DIGEST_TIME}.`);
  }

  console.log(`${TAG} Agendador de lembretes ativo (checagem a cada minuto).`);
}
