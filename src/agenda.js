const DAY_MS = 86400000;

/** Separa as tarefas pendentes em hoje / atrasadas / próximos 7 dias. */
export function groupAgenda(store, now = new Date()) {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(startToday.getTime() + DAY_MS);
  const startAfterWeek = new Date(startToday.getTime() + 8 * DAY_MS);

  const pending = store.listPending().filter((t) => t.dueAt);
  const at = (t) => new Date(t.dueAt);
  return {
    today: pending.filter((t) => at(t) >= startToday && at(t) < startTomorrow),
    overdue: pending.filter((t) => at(t) < startToday),
    upcoming: pending.filter((t) => at(t) >= startTomorrow && at(t) < startAfterWeek),
  };
}
