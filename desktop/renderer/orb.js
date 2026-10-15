// Orb animado do Jarvis: uma esfera de luz desenhada em canvas que respira enquanto
// escuta, cresce com a sua voz, gira enquanto pensa e pulsa com a voz dele.
// Uso: const orb = createOrb(canvas); orb.setState('listening'); orb.setLevel(0.4);

// eslint-disable-next-line no-unused-vars
function createOrb(canvas) {
  const ctx = canvas.getContext('2d');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const PALETTES = {
    off: { core: [120, 128, 145], glow: [70, 76, 90], blobs: [[90, 98, 115], [110, 116, 130], [80, 86, 100]] },
    listening: { core: [120, 150, 255], glow: [91, 124, 250], blobs: [[91, 124, 250], [56, 189, 248], [139, 92, 246]] },
    recording: { core: [140, 230, 255], glow: [56, 189, 248], blobs: [[56, 189, 248], [34, 211, 238], [91, 124, 250]] },
    thinking: { core: [170, 150, 255], glow: [139, 92, 246], blobs: [[139, 92, 246], [91, 124, 250], [236, 72, 153]] },
    speaking: { core: [150, 220, 255], glow: [56, 189, 248], blobs: [[56, 189, 248], [91, 124, 250], [45, 212, 191]] },
  };

  let state = 'off';
  let target = 0;
  let level = 0;
  let palette = structuredClone(PALETTES.off);
  let t = 0;
  let last = performance.now();

  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const rgba = (c, a) => `rgba(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0}, ${a})`;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(width * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
  }

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    resize();

    const speed = { off: 0.15, listening: 0.5, recording: 0.9, thinking: 2.2, speaking: 1.2 }[state] ?? 0.5;
    t += dt * (reduceMotion ? 0 : speed);
    level += (target - level) * Math.min(1, dt * 14);
    const p = PALETTES[state] || PALETTES.listening;
    palette = {
      core: mix(palette.core, p.core, Math.min(1, dt * 4)),
      glow: mix(palette.glow, p.glow, Math.min(1, dt * 4)),
      blobs: palette.blobs.map((b, i) => mix(b, p.blobs[i], Math.min(1, dt * 4))),
    };

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const edge = Math.min(w, h) / 2; // o brilho tem que sumir antes da borda do canvas
    const base = edge * 0.48;
    const breathe = state === 'listening' || state === 'off' ? Math.sin(t * 2.2) * 0.03 : 0;
    const r = base * (1 + breathe + level * 0.35);

    ctx.clearRect(0, 0, w, h);

    // Halo externo.
    const halo = ctx.createRadialGradient(cx, cy, r * 0.6, cx, cy, edge);
    halo.addColorStop(0, rgba(palette.glow, state === 'off' ? 0.12 : 0.35 + level * 0.3));
    halo.addColorStop(1, rgba(palette.glow, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, w, h);

    // Anel girando enquanto pensa.
    if (state === 'thinking') {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(t * 2.5);
      ctx.lineWidth = Math.max(2, base * 0.05);
      const arc = ctx.createLinearGradient(-r, 0, r, 0);
      arc.addColorStop(0, rgba(palette.blobs[0], 0));
      arc.addColorStop(1, rgba(palette.blobs[2], 0.9));
      ctx.strokeStyle = arc;
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.28, 0, Math.PI * 1.3);
      ctx.stroke();
      ctx.restore();
    }

    // Ondas saindo enquanto fala.
    if (state === 'speaking') {
      for (let i = 0; i < 2; i++) {
        const k = (t * 0.8 + i * 0.5) % 1;
        ctx.strokeStyle = rgba(palette.glow, (1 - k) * (0.35 + level * 0.5));
        ctx.lineWidth = Math.max(1.5, base * 0.03);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(edge * 0.98, r * (1.05 + k * 0.7)), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Esfera: base escura + manchas de cor que se movem dentro dela.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    body.addColorStop(0, rgba(palette.core, 1));
    body.addColorStop(1, rgba(mix(palette.glow, [10, 14, 30], 0.6), 1));
    ctx.fillStyle = body;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    ctx.globalCompositeOperation = 'lighter';
    palette.blobs.forEach((c, i) => {
      const a = t * (0.7 + i * 0.35) + i * 2.1;
      const wobble = 0.35 + level * 0.25;
      const bx = cx + Math.cos(a) * r * wobble;
      const by = cy + Math.sin(a * 1.3) * r * wobble;
      const br = r * (0.75 + 0.15 * Math.sin(t * 1.7 + i));
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, rgba(c, state === 'off' ? 0.25 : 0.55));
      g.addColorStop(1, rgba(c, 0));
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    });
    ctx.globalCompositeOperation = 'source-over';

    // Brilho de vidro no topo.
    const shine = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.45, 0, cx - r * 0.35, cy - r * 0.45, r * 0.7);
    shine.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
    shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = shine;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();

    // Contorno fino.
    ctx.strokeStyle = rgba(palette.glow, state === 'off' ? 0.25 : 0.5);
    ctx.lineWidth = Math.max(1, base * 0.015);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  return {
    setState(next) {
      state = next;
      if (next !== 'listening' && next !== 'recording' && next !== 'speaking') target = 0;
    },
    setLevel(v) {
      target = Math.max(0, Math.min(1, Number(v) || 0));
    },
  };
}
