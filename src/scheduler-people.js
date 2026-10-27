import cron from 'node-cron';
import { listPeople, updatePerson } from './people.js';
import { createStore } from './store.js';
import { formatDateShort, formatTime, formatDateTimeFull } from './format.js';
import { sendProactive } from './jarvis.js';
import { groupAgenda } from './agenda.js';
import { pushToDesktop } from './desktop.js';

const TAG = '[jarvis]';
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
  const { today, overdue, upcoming } = groupAgenda(store, now);

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

// ---------- Resumo do fim do dia ----------
// Padrão 18:00 pra todo mundo (eveningTime vazio = desligado). Mostra o que foi feito hoje,
// o que passou sem ser concluído e a agenda de amanhã.

const DEFAULT_EVENING_TIME = '18:00';
const EVENING_WINDOW_MIN = 120;

export function buildEveningDigest(person, store, now = new Date()) {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(startToday.getTime() + 86400000);
  const startAfter = new Date(startToday.getTime() + 2 * 86400000);
  const inRange = (iso, a, b) => iso && new Date(iso) >= a && new Date(iso) < b;
  const all = store.listAll();

  const done = all.filter((t) => t.status === 'done' && inRange(t.completedAt, startToday, startTomorrow));
  const missed = all.filter((t) => t.status === 'pending' && inRange(t.dueAt, startToday, now));
  const tomorrow = all.filter((t) => t.status === 'pending' && inRange(t.dueAt, startTomorrow, startAfter)).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const olderOverdue = all.filter((t) => t.status === 'pending' && t.dueAt && new Date(t.dueAt) < startToday).length;

  const lines = [`Fim de dia, ${person.displayName}! 🌙`, ''];
  if (done.length) {
    lines.push('Concluído hoje:');
    for (const t of done.slice(0, LIST_CAP)) lines.push(`✅ ${t.title}`);
    lines.push('');
  }
  if (missed.length) {
    lines.push('Passou hoje e ainda está em aberto:');
    for (const t of missed.slice(0, LIST_CAP)) lines.push(`⏳ ${formatTime(t.dueAt)} - ${t.title}`);
    lines.push('');
  }
  if (tomorrow.length) {
    lines.push('Amanhã:');
    for (const t of tomorrow.slice(0, LIST_CAP)) lines.push(`📅 ${formatTime(t.dueAt)} - ${t.title}${t.link ? `\n🔗 ${t.link}` : ''}`);
    if (tomorrow.length > LIST_CAP) lines.push(`(e mais ${tomorrow.length - LIST_CAP})`);
    lines.push('');
  } else {
    lines.push('Amanhã está livre por enquanto.', '');
  }
  if (olderOverdue) lines.push(`Ainda há ${olderOverdue} atrasado(s) de dias anteriores.`, '');
  lines.push(missed.length ? 'Se algo em aberto já foi feito, me avisa que eu marco como concluído. Bom descanso!' : 'Bom descanso!');
  return lines.join('\n');
}

async function maybeSendEvening(person, store, now) {
  const target = toMinutes(person.eveningTime === undefined ? DEFAULT_EVENING_TIME : person.eveningTime);
  if (target === null) return;
  if (person.lastEveningDate === dateKey(now)) return;
  const sinceTarget = now.getHours() * 60 + now.getMinutes() - target;
  if (sinceTarget < 0 || sinceTarget > EVENING_WINDOW_MIN) return;
  try {
    await sendProactive(person, buildEveningDigest(person, store, now), { remember: true });
    updatePerson(person.id, { lastEveningDate: dateKey(now) });
  } catch (err) {
    console.error(`${TAG} [${person.id}] Falha ao enviar resumo do fim do dia:`, err.message);
  }
}

async function maybeSendDigest(person, store, now) {
  const target = toMinutes(person.digestTime);
  if (target === null) return;
  if (person.lastDigestDate === dateKey(now)) return;
  const sinceTarget = now.getHours() * 60 + now.getMinutes() - target;
  if (sinceTarget < 0 || sinceTarget > DIGEST_WINDOW_MIN) return;

  try {
    await sendProactive(person, buildDigest(person, store, now), { remember: true });
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

      for (const { task, offsets, minutes } of store.findDueLeads(now)) {
        try {
          const lines = [`⏰ Lembrete: faltam ${minutes} min!`, '', `📅 ${task.title}`, `📆 ${formatDateShort(task.dueAt)} às ${formatTime(task.dueAt)}`];
          if (task.link) lines.push(`🔗 Link: ${task.link}`);
          await sendProactive(person, lines.join('\n'));
          store.markLeadsSent(task.id, offsets);
          pushToDesktop(person.id, { type: 'notify', kind: 'lead', minutes, taskTitle: task.title, title: `Faltam ${minutes} min`, body: `${task.title} às ${formatTime(task.dueAt)}`, link: task.link || '' });
        } catch (err) {
          console.error(`${TAG} [${person.id}] Falha ao enviar lembrete antecipado:`, err.message);
        }
      }

      for (const task of store.findDueNow(now)) {
        try {
          const lines = ['Lembrete, AGORA!:', task.title, '', 'Data e hora:', `📅 ${formatDateTimeFull(task.dueAt)}`];
          if (task.link) lines.push('', `🔗 ${task.link}`);
          await sendProactive(person, lines.join('\n'));
          store.markDueSent(task.id);
          pushToDesktop(person.id, { type: 'notify', kind: 'due', taskTitle: task.title, title: 'É agora', body: task.title, link: task.link || '' });
        } catch (err) {
          console.error(`${TAG} [${person.id}] Falha ao enviar lembrete:`, err.message);
        }
      }

      await maybeSendDigest(person, store, now);
      await maybeSendEvening(person, store, now);
    }
  });
  console.log(`${TAG} Agendador (todas as pessoas) ativo — checagem a cada minuto.`);
}
