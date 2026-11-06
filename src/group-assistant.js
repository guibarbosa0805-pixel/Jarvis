import { listPeople } from './people.js';
import { createStore } from './store.js';
import { createMemory } from './memory.js';
import { createGroupBrain } from './gemini.js';

// Jarvis respondendo dentro dos grupos vinculados, só quando é chamado: marcando @Jarvis,
// respondendo a uma mensagem dele, ou começando a mensagem com "Jarvis". O resto da conversa
// do grupo é ignorado.

const TAG = '[jarvis]';
const MAX_REPLIES_PER_MINUTE = 6; // as respostas usam a cota do Gemini do dono do grupo
const brains = new Map(); // jid do grupo -> cérebro do grupo
const recentReplies = new Map(); // jid do grupo -> horários das últimas respostas

/** Parte numérica de um jid ("5518...:12@s.whatsapp.net" -> "5518..."). */
const userPart = (jid) => String(jid || '').split(/[:@]/)[0];

/** Quem vinculou este grupo (e se deixou o Jarvis responder nele). */
export function findGroupOwner(groupJid) {
  for (const person of listPeople()) {
    const group = (person.groups || []).find((g) => g.jid === groupJid);
    if (group && group.assistant !== false) return { person, group };
  }
  return null;
}

function contextInfoOf(message) {
  for (const value of Object.values(message || {})) {
    if (value && typeof value === 'object' && value.contextInfo) return value.contextInfo;
  }
  return null;
}

function textOf(message) {
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || '';
}

/** O Jarvis foi chamado nesta mensagem? jarvisIds: números do Jarvis (telefone e LID). */
export function isAddressedToJarvis(msg, jarvisIds) {
  const ctx = contextInfoOf(msg.message);
  const mentioned = (ctx?.mentionedJid || []).some((jid) => jarvisIds.has(userPart(jid)));
  const repliedToJarvis = ctx?.participant && jarvisIds.has(userPart(ctx.participant));
  const named = /^\W*(?:(?:ei|oi|ol[aá]|fala|ô|o)\s+)?jarvis\b/i.test(textOf(msg.message).trim());
  return Boolean(mentioned || repliedToJarvis || named);
}

/** Tira as marcações "@5518..." do texto (o Jarvis já sabe que foi chamado). */
export function cleanGroupText(text) {
  return String(text || '').replace(/@\d{6,}/g, '').replace(/\s+/g, ' ').trim();
}

function underRateLimit(groupJid) {
  const now = Date.now();
  const recent = (recentReplies.get(groupJid) || []).filter((t) => now - t < 60000);
  recentReplies.set(groupJid, recent);
  if (recent.length >= MAX_REPLIES_PER_MINUTE) return false;
  recent.push(now);
  return true;
}

function getGroupBrain(person, group) {
  const key = `${person.id}|${group.jid}`;
  if (!brains.has(key)) {
    brains.set(
      key,
      createGroupBrain({
        apiKey: person.geminiApiKey,
        model: person.geminiModel,
        ownerName: person.displayName,
        group,
        store: createStore(person.id),
        memory: createMemory(`grupo-${userPart(group.jid)}`),
      }),
    );
  }
  return brains.get(key);
}

/**
 * Trata uma mensagem recebida num grupo. reply(text) envia a resposta no grupo.
 * Devolve true se respondeu.
 */
export async function handleGroupMessage(msg, { jarvisIds, reply }) {
  const groupJid = msg.key?.remoteJid;
  const owner = findGroupOwner(groupJid);
  if (!owner) return false; // grupo não vinculado (ou assistente desligado)
  const text = cleanGroupText(textOf(msg.message));
  if (!text || !isAddressedToJarvis(msg, jarvisIds)) return false;
  if (!underRateLimit(groupJid)) {
    console.log(`${TAG} [grupo ${owner.group.alias}] Limite de respostas por minuto atingido; ignorando.`);
    return false;
  }

  const sender = msg.pushName || 'Alguém do grupo';
  console.log(`${TAG} [grupo ${owner.group.alias}] Chamado por ${sender}.`);
  try {
    const answer = await getGroupBrain(owner.person, owner.group).reply(`[${sender}]: ${text}`);
    if (answer) await reply(answer);
    return Boolean(answer);
  } catch (err) {
    console.error(`${TAG} [grupo ${owner.group.alias}] Erro ao responder:`, err?.message || err);
    const timeout = err?.timeout || err?.status === 503 || err?.status === 429;
    await reply(timeout ? 'Estou meio sobrecarregado agora 😅 me chama de novo em um minutinho?' : 'Deu um probleminha aqui do meu lado 😅 tenta de novo?').catch(() => {});
    return false;
  }
}
