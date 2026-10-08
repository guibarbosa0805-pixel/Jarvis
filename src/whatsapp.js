import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  jidNormalizedUser,
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSTANCE = process.env.INSTANCE_NAME || 'default';
const AUTH_DIR = `${__dirname}/../auth/${INSTANCE}`;
const QR_PNG_PATH = `${__dirname}/../qr-${INSTANCE}.png`;
const GROUP_NAME = (process.env.GROUP_NAME || '').trim() || null;
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '').replace(/\D/g, '') || null;
const TAG = `[jarvis:${INSTANCE}]`;
const logger = pino({ level: 'silent' });
// "Jarvis:" em fonte Unicode sans-serif bold — só o nome, pra ficar visualmente
// diferente das suas mensagens sem depender de formatação do WhatsApp (que não
// tem fontes, só negrito/itálico/monoespaçado).
const JARVIS_LABEL = '𝗝𝗮𝗿𝘃𝗶𝘀:';

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
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 6;

  async function resolveJarvisJid() {
    if (!GROUP_NAME) {
      // Contas com o novo sistema de identificação do WhatsApp (LID) usam um JID
      // "@lid" pra conversa "Mensagens para você mesmo", diferente do JID "@s.whatsapp.net"
      // baseado no número de telefone. sock.user.lid (quando existe) é o correto;
      // sock.user.id é o fallback pra contas que ainda não migraram.
      const myJid = sock?.user?.lid || sock?.user?.id;
      if (!jarvisJid && myJid) {
        jarvisJid = jidNormalizedUser(myJid);
        console.log(`${TAG} Sem grupo configurado — usando a conversa "Mensagens para você mesmo" (${jarvisJid}).`);
        writeStatus(INSTANCE, { groupFound: true, groupName: '(conversa com você mesmo)' });
      }
      return;
    }
    try {
      const groups = await sock.groupFetchAllParticipating();
      const list = Object.values(groups);
      const match = list.find((g) => g.subject === GROUP_NAME);
      if (match) {
        if (jarvisJid !== match.id) {
          jarvisJid = match.id;
          console.log(`${TAG} Grupo "${GROUP_NAME}" encontrado, escutando mensagens.`);
        }
        writeStatus(INSTANCE, { groupFound: true, groupName: GROUP_NAME });
      } else if (list.length > 0) {
        console.warn(
          `${TAG} Nenhum grupo chamado "${GROUP_NAME}" entre os ${list.length} grupos encontrados: ${list
            .map((g) => JSON.stringify(g.subject))
            .join(', ')}`,
        );
        writeStatus(INSTANCE, { groupFound: false, groupName: GROUP_NAME, groupsSeen: list.length });
      } else {
        console.warn(`${TAG} Ainda não vejo nenhum grupo (sincronizando com o WhatsApp)...`);
      }
    } catch (err) {
      console.error(`${TAG} Erro ao buscar grupos:`, err.message);
    }
  }

  async function sendToJarvis(text) {
    if (!jarvisJid) await resolveJarvisJid();
    if (!jarvisJid) {
      throw new Error(
        GROUP_NAME
          ? `Grupo "${GROUP_NAME}" não encontrado. Crie um grupo com esse nome no WhatsApp.`
          : 'Ainda não consegui identificar a conversa "Mensagens para você mesmo".',
      );
    }
    const sent = await sock.sendMessage(jarvisJid, { text: `${JARVIS_LABEL} ${text}` });
    if (sent?.key?.id) sentIds.add(sent.key.id);
    return sent;
  }

  async function connect() {
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ version, auth: state, logger });

    sock.ev.on('creds.update', saveCreds);

    if (PHONE_NUMBER && !state.creds.registered) {
      try {
        if (!sock.ws.isOpen) {
          await Promise.race([
            new Promise((resolve) => sock.ws.once('open', resolve)),
            new Promise((resolve) => setTimeout(resolve, 10000)),
          ]);
        }
        // O WebSocket abrir não significa que o handshake criptografado (Noise)
        // já terminou — pedir o código cedo demais faz o servidor derrubar a
        // conexão na hora. Essa folga extra dá tempo do handshake terminar.
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const rawCode = await sock.requestPairingCode(PHONE_NUMBER);
        const pretty = rawCode.match(/.{1,4}/g)?.join('-') ?? rawCode;
        console.log(`\n${TAG} Código de pareamento (sem QR): ${pretty}`);
        console.log(
          `${TAG} No celular: WhatsApp > Configurações > Aparelhos conectados > Conectar um aparelho > "Conectar com número de telefone" e digite esse código.\n`,
        );
        writeStatus(INSTANCE, { state: 'pairing', pairingCode: pretty });
      } catch (err) {
        console.error(`${TAG} Erro ao gerar código de pareamento:`, err.message);
      }
    }

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !PHONE_NUMBER) {
        console.log(`\n${TAG} Escaneie o QR code no WhatsApp (Aparelhos conectados > Conectar um aparelho):\n`);
        qrcodeTerminal.generate(qr, { small: true });
        // Escreve num arquivo temporário e troca o nome no final: assim quem está
        // lendo qr-<nome>.png (o painel) nunca pega um PNG pela metade enquanto
        // o código está sendo trocado.
        const tmpPath = `${QR_PNG_PATH}.tmp`;
        QRCode.toFile(tmpPath, qr, { width: 640, margin: 3 })
          .then(() => renameSync(tmpPath, QR_PNG_PATH))
          .catch((err) => console.error(`${TAG} Erro ao gerar ${QR_PNG_PATH}:`, err.message));
        writeStatus(INSTANCE, { state: 'qr' });
      }
      if (connection === 'open') {
        console.log(`${TAG} Conectado ao WhatsApp.`);
        consecutiveFailures = 0;
        if (existsSync(QR_PNG_PATH)) unlinkSync(QR_PNG_PATH);
        writeStatus(INSTANCE, { state: 'connected', pairingCode: null });
        resolveJarvisJid();
        setTimeout(resolveJarvisJid, 5000);
        setTimeout(resolveJarvisJid, 15000);
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        if (loggedOut) {
          console.error(
            `${TAG} Sessão desconectada pelo celular. Apague a pasta "auth/${INSTANCE}" e rode novamente para parear de novo (QR ou código, conforme PHONE_NUMBER).`,
          );
          writeStatus(INSTANCE, { state: 'logged_out' });
          return;
        }
        consecutiveFailures++;
        if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
          console.error(
            `${TAG} ${consecutiveFailures} falhas de conexão seguidas (code ${statusCode}). Parando de tentar pra não martelar o WhatsApp — rode de novo manualmente mais tarde.`,
          );
          writeStatus(INSTANCE, { state: 'error', error: `${consecutiveFailures} falhas seguidas (code ${statusCode})` });
          return;
        }
        const backoffMs = Math.min(consecutiveFailures * 3000, 30000);
        console.log(`${TAG} Conexão perdida (code ${statusCode}), tentando de novo em ${backoffMs / 1000}s...`);
        writeStatus(INSTANCE, { state: 'reconnecting' });
        setTimeout(connect, backoffMs);
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

        const audioMsg = msg.message.audioMessage;
        if (audioMsg) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
            events.emit('audio', buffer, audioMsg.mimetype || 'audio/ogg');
          } catch (err) {
            console.error(`${TAG} Erro ao baixar áudio:`, err.message);
          }
          continue;
        }

        const text = extractText(msg);
        if (!text) continue;
        events.emit('message', text);
      }
    });
  }

  await connect();

  return { events, sendToJarvis };
}
