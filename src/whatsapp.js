import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { existsSync, unlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = `${__dirname}/../auth`;
const QR_PNG_PATH = `${__dirname}/../qr.png`;
const GROUP_NAME = process.env.GROUP_NAME || 'Jarvis';
const logger = pino({ level: 'silent' });

function extractText(msg) {
  const m = msg.message;
  if (!m) return null;
  return m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || null;
}

export async function startWhatsApp() {
  const events = new EventEmitter();
  const sentIds = new Set();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let sock;
  let jarvisJid = null;

  async function resolveJarvisJid() {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups);
      const match = list.find((g) => g.subject === GROUP_NAME);
      if (match) {
        if (jarvisJid !== match.id) {
          jarvisJid = match.id;
          console.log(`[jarvis] Grupo "${GROUP_NAME}" encontrado, escutando mensagens.`);
        }
      } else if (list.length > 0) {
        console.warn(
          `[jarvis] Nenhum grupo chamado "${GROUP_NAME}" entre os ${list.length} grupos encontrados: ${list
            .map((g) => JSON.stringify(g.subject))
            .join(', ')}`,
        );
      } else {
        console.warn('[jarvis] Ainda não vejo nenhum grupo (sincronizando com o WhatsApp)...');
      }
    } catch (err) {
      console.error('[jarvis] Erro ao buscar grupos:', err.message);
    }
  }

  async function sendToJarvis(text) {
    if (!jarvisJid) await resolveJarvisJid();
    if (!jarvisJid) throw new Error(`Grupo "${GROUP_NAME}" não encontrado. Crie um grupo com esse nome no WhatsApp.`);
    const sent = await sock.sendMessage(jarvisJid, { text: `🤖 *Jarvis:* ${text}` });
    if (sent?.key?.id) sentIds.add(sent.key.id);
    return sent;
  }

  async function connect() {
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        console.log('\n[jarvis] Escaneie o QR code no WhatsApp (Aparelhos conectados > Conectar um aparelho):\n');
        qrcodeTerminal.generate(qr, { small: true });
        QRCode.toFile(QR_PNG_PATH, qr, { width: 640, margin: 3 }).catch((err) =>
          console.error('[jarvis] Erro ao gerar qr.png:', err.message),
        );
      }
      if (connection === 'open') {
        console.log('[jarvis] Conectado ao WhatsApp.');
        if (existsSync(QR_PNG_PATH)) unlinkSync(QR_PNG_PATH);
        resolveJarvisJid();
        setTimeout(resolveJarvisJid, 5000);
        setTimeout(resolveJarvisJid, 15000);
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          console.error('[jarvis] Sessão desconectada pelo celular. Apague a pasta "auth" e rode novamente para reconectar com um novo QR code.');
        } else {
          console.log(`[jarvis] Conexão perdida (code ${statusCode}), reconectando...`);
          connect();
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      if (!jarvisJid) await resolveJarvisJid();
      if (!jarvisJid) return;

      for (const msg of messages) {
        if (!msg.message || msg.key.remoteJid !== jarvisJid) continue;
        if (msg.key.id && sentIds.has(msg.key.id)) {
          sentIds.delete(msg.key.id);
          continue;
        }
        if (!msg.key.fromMe) continue;
        const text = extractText(msg);
        if (!text) continue;
        events.emit('message', text);
      }
    });
  }

  await connect();

  return { events, sendToJarvis };
}
