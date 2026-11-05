import { findPersonById, updatePerson } from './people.js';
import { formatDateShort, formatTime } from './format.js';

// Grupos do WhatsApp onde o Jarvis posta em nome da pessoa (convites e resumo da agenda
// compartilhada). Regras:
// - só posta em grupos que a própria pessoa vinculou (lista por pessoa em people.json);
// - o número do Jarvis precisa participar do grupo;
// - no grupo ele só fala quando a pessoa manda: mensagens de grupo continuam ignoradas.

// Como listar/enviar fica no módulo do WhatsApp (jarvis.js); ele se registra aqui ao subir.
let transport = null; // { list(): Promise<[{ jid, name }]>, send(jid, text): Promise }

export function setGroupTransport(t) {
  transport = t;
}

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Apelido curto pra pessoa falar ("telecom" pra "Telecom - Infos, Dor de Cabeça e Etc"). */
function defaultAlias(name) {
  return norm(name).split(' ')[0] || 'grupo';
}

export async function listJarvisGroups() {
  if (!transport) throw new Error('O WhatsApp do Jarvis não está conectado agora.');
  return transport.list();
}

export function linkedGroups(person) {
  return Array.isArray(person?.groups) ? person.groups : [];
}

/** Acha um grupo vinculado pelo apelido ou por parte do nome. */
export function findLinkedGroup(person, ref) {
  const wanted = norm(ref);
  const groups = linkedGroups(person);
  return (
    groups.find((g) => norm(g.alias) === wanted) ||
    groups.find((g) => norm(g.name) === wanted) ||
    groups.find((g) => wanted && (norm(g.name).includes(wanted) || wanted.includes(norm(g.alias))))
  );
}

export async function linkGroup(personId, name, alias, summaryTime = '') {
  const groups = await listJarvisGroups();
  const wanted = norm(name);
  // Palavras que importam ("grupo telecom" -> ["telecom"]): todas precisam estar no nome do grupo.
  const words = wanted.split(' ').filter((w) => w.length >= 3 && !['grupo', 'pessoal', 'galera', 'turma', 'com', 'dos', 'das'].includes(w));
  const match =
    groups.find((g) => norm(g.name) === wanted) ||
    groups.find((g) => wanted && (norm(g.name).includes(wanted) || wanted.includes(norm(g.name)))) ||
    (words.length ? groups.find((g) => words.every((w) => norm(g.name).includes(w))) : undefined);
  if (!match) {
    return {
      ok: false,
      error: 'Não encontrei esse grupo entre os grupos do Jarvis. O número do Jarvis precisa ser adicionado ao grupo antes.',
      jarvis_groups: groups.map((g) => g.name),
    };
  }
  const person = findPersonById(personId);
  const entry = { alias: norm(alias) || defaultAlias(match.name), jid: match.jid, name: match.name, summaryTime: summaryTime || '' };
  const others = linkedGroups(person).filter((g) => g.jid !== match.jid && g.alias !== entry.alias);
  updatePerson(personId, { groups: [...others, entry] });
  return { ok: true, group: { alias: entry.alias, name: entry.name, summaryTime: entry.summaryTime || null } };
}

export function unlinkGroup(personId, ref) {
  const person = findPersonById(personId);
  const group = findLinkedGroup(person, ref);
  if (!group) return { ok: false, error: 'Esse grupo não está vinculado.' };
  updatePerson(personId, { groups: linkedGroups(person).filter((g) => g.jid !== group.jid) });
  return { ok: true, removed: group.name };
}

export function setGroupSummary(personId, ref, time) {
  const person = findPersonById(personId);
  const group = findLinkedGroup(person, ref);
  if (!group) return { ok: false, error: 'Esse grupo não está vinculado.' };
  updatePerson(personId, { groups: linkedGroups(person).map((g) => (g.jid === group.jid ? { ...g, summaryTime: time } : g)) });
  return { ok: true, group: group.name, time: time || null, disabled: !time };
}

/** Assinatura das mensagens no grupo: deixa claro que é o assistente de quem. */
function groupLabel(person) {
  const first = String(person?.displayName || '').split(' ')[0];
  return first ? `𝗝𝗮𝗿𝘃𝗶𝘀 (assistente do ${first}):` : '𝗝𝗮𝗿𝘃𝗶𝘀:';
}

export async function sendToGroup(person, ref, text) {
  let group = findLinkedGroup(person, ref);
  if (!group) {
    // A pessoa pediu pra mandar num grupo onde o Jarvis está mas que ainda não foi vinculado:
    // o próprio pedido já é a autorização, então vincula e segue.
    const linked = await linkGroup(person.id, ref).catch(() => null);
    if (!linked?.ok) {
      return {
        ok: false,
        error: `Não achei o grupo "${ref}" entre os grupos do Jarvis. O número do Jarvis precisa estar no grupo.`,
        jarvis_groups: linked?.jarvis_groups || [],
      };
    }
    group = findLinkedGroup(findPersonById(person.id), linked.group.alias);
  }
  if (!transport) return { ok: false, error: 'O WhatsApp do Jarvis não está conectado agora.' };
  await transport.send(group.jid, `${groupLabel(person)}\n${text}`);
  return { ok: true, group: group.name, alias: group.alias };
}

/** Convite de um compromisso no formato do grupo. */
export function formatInvite(task) {
  const lines = [`📅 *${task.title}*`, `📆 ${formatDateShort(task.dueAt)} às ${formatTime(task.dueAt)}`];
  if (task.link) lines.push(`🔗 ${task.link}`);
  if (task.notes) lines.push(`📝 ${task.notes}`);
  return lines.join('\n');
}

/** Resumo só com o que foi compartilhado com este grupo (hoje + próximos 7 dias). */
export function buildGroupSummary(group, store, now = new Date()) {
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(startToday.getTime() + 86400000);
  const endWeek = new Date(startToday.getTime() + 8 * 86400000);
  const shared = store
    .listPending()
    .filter((t) => t.dueAt && Array.isArray(t.groups) && t.groups.includes(group.alias))
    .filter((t) => new Date(t.dueAt) >= now && new Date(t.dueAt) < endWeek);
  if (!shared.length) return null;

  const today = shared.filter((t) => new Date(t.dueAt) < startTomorrow);
  const later = shared.filter((t) => new Date(t.dueAt) >= startTomorrow);
  const line = (t, withDate) => `📅 ${withDate ? `${formatDateShort(t.dueAt)} ` : ''}${formatTime(t.dueAt)} - ${t.title}${t.link ? `\n🔗 ${t.link}` : ''}`;
  const lines = ['Bom dia, pessoal! Agenda compartilhada:', ''];
  if (today.length) lines.push('Hoje:', ...today.map((t) => line(t, false)), '');
  if (later.length) lines.push('Próximos dias:', ...later.slice(0, 8).map((t) => line(t, true)), '');
  return lines.join('\n').trim();
}
