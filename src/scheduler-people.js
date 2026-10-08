import cron from 'node-cron';
import { listPeople } from './people.js';
import { createStore } from './store.js';
import { formatDateShort, formatTime, formatDateTimeFull } from './format.js';
import { sendToPerson } from './jarvis.js';

const TAG = '[jarvis]';

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function startPeopleScheduler() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const nowHHmm = now.toTimeString().slice(0, 5);

    for (const person of listPeople()) {
      const store = createStore(person.id);

      for (const task of store.findDueLead(now)) {
        try {
          const lines = [`⏰ Lembrete: faltam ${task.leadMinutes} min!`, '', `📅 ${task.title}`, `📆 ${formatDateShort(task.dueAt)} às ${formatTime(task.dueAt)}`];
          if (task.link) lines.push(`🔗 Link: ${task.link}`);
          await sendToPerson(person.jid, lines.join('\n'));
          store.markLeadSent(task.id);
        } catch (err) {
          console.error(`${TAG} [${person.id}] Falha ao enviar lembrete antecipado:`, err.message);
        }
      }

      for (const task of store.findDueNow(now)) {
        try {
          const lines = ['Lembrete, AGORA!:', task.title, '', 'Data e hora:', `📅 ${formatDateTimeFull(task.dueAt)}`];
          if (task.link) lines.push('', `🔗 ${task.link}`);
          await sendToPerson(person.jid, lines.join('\n'));
          store.markDueSent(task.id);
        } catch (err) {
          console.error(`${TAG} [${person.id}] Falha ao enviar lembrete:`, err.message);
        }
      }

      if (person.digestTime && person.digestTime === nowHHmm) {
        const todays = store.listPending().filter((t) => t.dueAt && isSameDay(new Date(t.dueAt), now));
        if (todays.length > 0) {
          const lines = [`Oii ${person.displayName} 😊, tudo bem?`, '', 'Agendamento(s) de hoje:', ''];
          for (const t of todays) lines.push(`📅 ${formatTime(t.dueAt)} - ${t.title}`);
          try {
            await sendToPerson(person.jid, lines.join('\n'));
          } catch (err) {
            console.error(`${TAG} [${person.id}] Falha ao enviar resumo matinal:`, err.message);
          }
        }
      }
    }
  });
  console.log(`${TAG} Agendador (todas as pessoas) ativo — checagem a cada minuto.`);
}
