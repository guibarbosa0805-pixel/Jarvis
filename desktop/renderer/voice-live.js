// Conversa por voz em tempo real com o servidor (que fala com o Gemini Live).
// O microfone vai em pedaços de PCM 16 kHz enquanto a pessoa fala; a resposta volta em
// pedaços de PCM 24 kHz e começa a tocar assim que o primeiro chega.

/** Toca áudio PCM 16 bits em sequência, sem buracos, e mede o volume (pro orb). */
// eslint-disable-next-line no-unused-vars
class PcmPlayer {
  constructor(sampleRate = 24000) {
    this.ctx = new AudioContext({ sampleRate });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(this.ctx.destination);
    this.nextTime = 0;
    this.sources = new Set();
    this.drainWaiters = [];
  }

  enqueue(arrayBuffer) {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const pcm = new Int16Array(arrayBuffer);
    if (!pcm.length) return;
    const buffer = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 0x8000;
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    // Pequena folga no primeiro pedaço evita estalos se o próximo atrasar um pouco.
    const start = Math.max(this.ctx.currentTime + (this.sources.size ? 0 : 0.05), this.nextTime);
    source.start(start);
    this.nextTime = start + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (!this.sources.size) this.drainWaiters.splice(0).forEach((resolve) => resolve());
    };
  }

  get playing() {
    return this.sources.size > 0;
  }

  /** Resolve quando terminar de tocar tudo que já chegou. */
  drained() {
    if (!this.sources.size) return Promise.resolve();
    return new Promise((resolve) => this.drainWaiters.push(resolve));
  }

  stop() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        // já parou
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.drainWaiters.splice(0).forEach((resolve) => resolve());
  }

  level() {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return Math.min(1, Math.sqrt(sum / data.length) * 4);
  }
}

/** Float 48 kHz (ou outra taxa) -> PCM 16 bits 16 kHz, pra mandar ao vivo. */
// eslint-disable-next-line no-unused-vars
function toPcm16k(chunk, sampleRate) {
  const step = sampleRate / 16000;
  const out = new Int16Array(Math.floor(chunk.length / step));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(chunk.length, Math.floor((i + 1) * step));
    let acc = 0;
    for (let k = start; k < end; k++) acc += chunk[k];
    out[i] = Math.max(-1, Math.min(1, acc / Math.max(1, end - start))) * 0x7fff;
  }
  return out.buffer;
}

// eslint-disable-next-line no-unused-vars
class LiveVoice {
  /** onEvent recebe as mensagens JSON do servidor; onAudio, os pedaços de áudio. */
  constructor({ onEvent, onAudio, onStatus }) {
    this.onEvent = onEvent;
    this.onAudio = onAudio;
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.failures = 0;
    this.retryTimer = null;
  }

  connect(server, token) {
    this.server = server;
    this.token = token;
    this.open();
  }

  open() {
    clearTimeout(this.retryTimer);
    if (!this.server || !this.token) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const url = `${this.server.replace(/^http/i, 'ws')}/api/desktop/live`;
    const ws = new WebSocket(url, ['jarvis', this.token]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.onStatus(true);
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        try {
          this.onEvent(JSON.parse(e.data));
        } catch {
          // mensagem malformada
        }
      } else {
        this.onAudio(e.data);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.onStatus(false);
      this.failures++;
      // Servidor antigo (sem voz em tempo real) ou fora do ar: tenta de novo com calma.
      this.retryTimer = setTimeout(() => this.open(), Math.min(60000, 3000 * this.failures));
    };
  }

  get ready() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (this.ready) this.ws.send(JSON.stringify(obj));
  }

  sendAudio(buffer) {
    if (this.ready) this.ws.send(buffer);
  }

  close() {
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
