import cron from 'node-cron';
import { listPeople, updatePerson } from './people.js';
import { createStore } from './store.js';
import { formatDateShort, formatTime, formatDateTimeFull } from './format.js';
import { sendToPerson } from './jarvis.js';

const TAG = '[jarvis]';
const DAY_MS = 86400000;
const DIGEST_WINDOW_MIN = 180;
const LIST_CAP = 5;

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function buildDigest(person, store, now = new Date()) {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(startToday.getTime() + DAY_MS);
  const startAfterWeek = new Date(startToday.getTime() + 8 * DAY_MS);

  const pending = store.listPending().filter((t) => t.dueAt);
  const at = (t) => new Date(t.dueAt);
  const today = pending.filter((t) => at(t) >= startToday && at(t) < startTomorrow);
  const overdue = pending.filter((t) => at(t) < startToday);
  const upcoming = pending.filter((t) => at(t) >= startTomorrow && at(t) < startAfterWeek);

  const withDate = (t) => `📅 ${formatDateShort(t.dueAt)} ${formatTime(t.dueAt)} - ${t.title}`;
  const lines = [`Oii ${person.displayName} 😊, tudo bem?`, ''];

  if (today.length) {
    lines.push('Agendamento(s) de hoje:', '');
    for (const t of today) lines.push(`📅 ${formatTime(t.dueAt)} - ${t.title}${t.link ? `\n🔗 ${t.link}` : ''}`);
  } else {
    lines.push('Hoje você não tem nenhum agendamento.');
  }

  if (overdue.length) {
    const shown = overdue.slice(-LIST_CAP);
    lines.push('', 'Atrasados (ainda pendentes):', '');
    for (const t of shown) lines.push(withDate(t));
    if (overdue.length > shown.length) lines.push(`(e mais ${overdue.length - shown.length} mais antigos)`);
  }

  if (upcoming.length) {
    const shown = upcoming.slice(0, LIST_CAP);
    lines.push('', 'Próximos dias:', '');
    for (const t of shown) lines.push(withDate(t));
    if (upcoming.length > shown.length) lines.push(`(e mais ${upcoming.length - shown.length})`);
  }

  if (!today.length && !overdue.length && !upcoming.length) {
    lines.push('', 'Quando quiser marcar algo, é só me falar.');
  } else {
    lines.push('', 'Bom dia e bom trabalho!');
  }
  return lines.join('\n');
}

async function maybeSendDigest(person, store, now) {
  const target = toMinutes(person.digestTime);
  if (target === null) return;
  if (person.lastDigestDate === dateKey(now)) return;
  const sinceTarget = now.getHours() * 60 + now.getMinutes() - target;
  if (sinceTarget < 0 || sinceTarget > DIGEST_WINDOW_MIN) return;

  try {
    await sendToPerson(person.jid, buildDigest(person, store, now));
    updatePerson(person.id, { lastDigestDate: dateKey(now) });
  } catch (err) {
    console.error(`${TAG} [${person.id}] Falha ao enviar resumo matinal:`, err.message);
  }
}

export function startPeopleScheduler() {
  cron.schedule('* * * * *', async () => {
    const now = new Date();

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

      await maybeSendDigest(person, store, now);
    }
  });
  console.log(`${TAG} Agendador (todas as pessoas) ativo — checagem a cada minuto.`);
}
