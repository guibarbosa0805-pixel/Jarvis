import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { existsSync, unlinkSync, renameSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeStatus } from './status.js';
import { createStore } from './store.js';
import { createBrain } from './gemini.js';
import { findPersonByJid, addOrTouchPending, markPendingNotified } from './people.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = `${__dirname}/..`;
const AUTH_DIR = `${ROOT}/auth/jarvis`;
const QR_PNG_PATH = `${ROOT}/qr-jarvis.png`;
const STATUS_KEY = 'jarvis';
const TAG = '[jarvis]';
const logger = pino({ level: 'silent' });

const PENDING_NOTICE =
  'Oi! Ainda não fui liberado pra conversar com você. Avisei o administrador — assim que ele te aprovar, a gente continua por aqui. 🙂';

function isGroupOrBroadcast(jid) {
  return jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter');
}

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || null;
}

const brains = new Map();

function getBrain(person) {
  if (!brains.has(person.id)) {
    brains.set(
      person.id,
      createBrain({
        apiKey: person.geminiApiKey,
        model: person.geminiModel,
        displayName: person.displayName,
        store: createStore(person.id),
        channelLabel: 'no WhatsApp',
      }),
    );
  }
  return brains.get(person.id);
}

/** Descarta a sessão em memória de uma pessoa (chamado ao editar/remover). */
export function forgetBrain(personId) {
  brains.delete(personId);
}

let sock = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 6;

export async function sendToPerson(jid, text) {
  if (!sock) throw new Error('Jarvis não está conectado.');
  return sock.sendMessage(jid, { text });
}

/** Encerra a conexão atual (usado antes de reparear). Não falha se já estiver parada. */
export function stopJarvisConnection() {
  try {
    sock?.end?.(new Error('stopped for repair'));
  } catch {
    // ignore
  }
  sock = null;
  consecutiveFailures = 0;
}

export async function startJarvisConnection() {
  const events = new EventEmitter();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  async function connect() {
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log(`\n${TAG} Escaneie o QR code no WhatsApp do número do Jarvis:\n`);
        qrcodeTerminal.generate(qr, { small: true });
        const tmpPath = `${QR_PNG_PATH}.tmp`;
        QRCode.toFile(tmpPath, qr, { width: 640, margin: 3 })
          .then(() => renameSync(tmpPath, QR_PNG_PATH))
          .catch((err) => console.error(`${TAG} Erro ao gerar QR:`, err.message));
        writeStatus(STATUS_KEY, { state: 'qr' });
      }
      if (connection === 'open') {
        console.log(`${TAG} Conectado ao WhatsApp.`);
        consecutiveFailures = 0;
        if (existsSync(QR_PNG_PATH)) unlinkSync(QR_PNG_PATH);
        writeStatus(STATUS_KEY, { state: 'connected', pairingCode: null });
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          console.error(`${TAG} Sessão desconectada pelo celular. Use "Reparear" no painel pra gerar um novo QR.`);
          writeStatus(STATUS_KEY, { state: 'logged_out' });
          return;
        }
        consecutiveFailures++;
        if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
          console.error(`${TAG} ${consecutiveFailures} falhas seguidas (code ${statusCode}). Parando de tentar.`);
          writeStatus(STATUS_KEY, { state: 'error', error: `${consecutiveFailures} falhas seguidas (code ${statusCode})` });
          return;
        }
        const backoffMs = Math.min(consecutiveFailures * 3000, 30000);
        console.log(`${TAG} Conexão perdida (code ${statusCode}), tentando de novo em ${backoffMs / 1000}s...`);
        writeStatus(STATUS_KEY, { state: 'reconnecting' });
        setTimeout(connect, backoffMs);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || isGroupOrBroadcast(jid)) continue;

        const person = findPersonByJid(jid);
        if (!person) {
          const entry = addOrTouchPending(jid, msg.pushName || '');
          console.log(`${TAG} Contato pendente: ${entry.pushName || jid} (${jid})`);
          if (!entry.notified) {
            try {
              await sock.sendMessage(jid, { text: PENDING_NOTICE });
              markPendingNotified(jid);
            } catch (err) {
              console.error(`${TAG} Erro ao avisar contato pendente:`, err.message);
            }
          }
          continue;
        }

        const audioMsg = msg.message.audioMessage;
        if (audioMsg) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            events.emit('audio', person, buffer, audioMsg.mimetype || 'audio/ogg');
          } catch (err) {
            console.error(`${TAG} Erro ao baixar áudio de ${person.id}:`, err.message);
          }
          continue;
        }

        const text = extractText(msg);
        if (!text) continue;
        events.emit('message', person, text);
      }
    });
  }

  await connect();

  events.on('message', async (person, text) => {
    console.log(`${TAG} [${person.id}] Recebido: ${text}`);
    try {
      const reply = await getBrain(person).handleIncomingMessage(text);
      await sendToPerson(person.jid, reply);
    } catch (err) {
      console.error(`${TAG} [${person.id}] Erro ao responder:`, err);
      try {
        await sendToPerson(person.jid, 'Deu um erro aqui do meu lado 🙃 tenta de novo.');
      } catch {
        // ignore secondary failure
      }
    }
  });

  events.on('audio', async (person, buffer, mimeType) => {
    console.log(`${TAG} [${person.id}] Áudio recebido, transcrevendo...`);
    try {
      const brain = getBrain(person);
      const transcript = await brain.transcribeAudio(buffer, mimeType);
      if (!transcript) {
        await sendToPerson(person.jid, 'Não consegui entender o áudio — pode tentar de novo ou mandar em texto?');
        return;
      }
      console.log(`${TAG} [${person.id}] Transcrito: ${transcript}`);
      const reply = await brain.handleIncomingMessage(transcript);
      await sendToPerson(person.jid, reply);
    } catch (err) {
      console.error(`${TAG} [${person.id}] Erro ao processar áudio:`, err);
      try {
        await sendToPerson(person.jid, 'Deu um erro ao processar o áudio 🙃 tenta de novo.');
      } catch {
        // ignore secondary failure
      }
    }
  });

  return { events };
}
