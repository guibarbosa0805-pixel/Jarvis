// Gera assets/icon.png e assets/icon.ico (círculo azul com um "J"), sem dependências.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256;
const out = `${dirname(fileURLToPath(import.meta.url))}/assets`;
mkdirSync(out, { recursive: true });

const px = Buffer.alloc(SIZE * SIZE * 4);
const c = SIZE / 2;

function setPixel(x, y, r, g, b, a) {
  const i = (y * SIZE + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

// "J": barra superior + haste vertical + gancho (meia coroa) embaixo, relativo ao centro.
function inJ(dx, dy) {
  const topbar = dx > -34 && dx < 52 && dy > -78 && dy < -52;
  const stem = dx > 18 && dx < 52 && dy >= -52 && dy <= 30;
  const r = Math.hypot(dx + 2, dy - 30);
  const hook = dy > 30 && r > 20 && r < 54;
  return topbar || stem || hook;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - c, dy = y - c;
    const d = Math.hypot(dx, dy);
    const edge = Math.min(1, Math.max(0, c - 4 - d));
    if (edge <= 0) { setPixel(x, y, 0, 0, 0, 0); continue; }
    const t = (y / SIZE);
    const r = Math.round(91 + (60 - 91) * t), g = Math.round(124 + (80 - 124) * t), b = Math.round(250 + (200 - 250) * t);
    if (inJ(dx, dy)) setPixel(x, y, 255, 255, 255, Math.round(255 * edge));
    else setPixel(x, y, r, g, b, Math.round(255 * edge));
  }
}

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(`${out}/icon.png`, png);

// ICO com o PNG embutido (suportado desde o Windows Vista). Tamanho 256 = byte 0.
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);
header[6] = 0; header[7] = 0; header[8] = 0; header[9] = 0;
header.writeUInt16LE(1, 10);
header.writeUInt16LE(32, 12);
header.writeUInt32LE(png.length, 14);
header.writeUInt32LE(22, 18);
writeFileSync(`${out}/icon.ico`, Buffer.concat([header, png]));
console.log('ícones gerados em', out);
