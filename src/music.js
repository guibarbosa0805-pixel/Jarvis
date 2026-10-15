// Busca de músicas no YouTube sem chave de API: lê o resultado da página de busca
// (o mesmo que o navegador mostra) e pega o primeiro vídeo. Se o YouTube mudar o
// formato, a busca devolve null e o Jarvis cai pro link de pesquisa.

const SEARCH_TIMEOUT_MS = 8000;
const cache = new Map();

export function searchLinks(query) {
  const q = encodeURIComponent(query);
  return {
    youtube: `https://www.youtube.com/results?search_query=${q}`,
    spotify: `https://open.spotify.com/search/${q}`,
  };
}

function textOf(node) {
  return node?.runs?.map((r) => r.text).join('') ?? node?.simpleText ?? '';
}

function seconds(label) {
  const parts = String(label || '').split(':').map(Number);
  if (!parts.length || parts.some(Number.isNaN)) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

/** ID do vídeo se o texto for um link do YouTube / YouTube Music / youtu.be. */
export function videoIdFromUrl(text) {
  const match = /https?:\/\/\S+/.exec(text || '');
  if (!match) return null;
  try {
    const url = new URL(match[0].replace(/[)\].,;]+$/, ''));
    if (url.hostname === 'youtu.be') return url.pathname.slice(1) || null;
    if (/(^|\.)youtube\.com$/.test(url.hostname)) return url.searchParams.get('v');
  } catch {
    // link inválido
  }
  return null;
}

async function trackFromVideoId(videoId) {
  let title = '';
  let channel = '';
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`, {
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = await res.json();
      title = data.title || '';
      channel = data.author_name || '';
    }
  } catch {
    // sem título: toca do mesmo jeito
  }
  return { videoId, title: title || 'Música escolhida', channel, url: `https://www.youtube.com/watch?v=${videoId}`, alternatives: [] };
}

/**
 * Resolve o que a pessoa pediu: um link do YouTube toca exatamente aquele vídeo; texto é
 * buscado, preferindo a versão "Topic" (áudio oficial da música, a que o YouTube Music usa)
 * e depois o primeiro vídeo "de verdade" (não live, não curtíssimo, não longo demais).
 */
export async function searchMusic(query) {
  const linked = videoIdFromUrl(query);
  if (linked) return trackFromVideoId(linked);

  const key = query.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=pt-BR`;
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'accept-language': 'pt-BR,pt;q=0.9',
    },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const html = await res.text();
  const marker = 'var ytInitialData = ';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const end = html.indexOf(';</script>', start);
  if (end === -1) return null;

  let data;
  try {
    data = JSON.parse(html.slice(start + marker.length, end));
  } catch {
    return null;
  }

  const sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? [];
  const videos = sections.flatMap((s) => s.itemSectionRenderer?.contents ?? []).map((c) => c.videoRenderer).filter(Boolean);

  // Candidatos em ordem de relevância, descartando lives e vídeos curtos/longos demais.
  const candidates = videos
    .filter((v) => {
      const s = seconds(textOf(v.lengthText));
      return s !== null && s >= 60 && s <= 20 * 60;
    })
    .slice(0, 8);
  if (!candidates.length && videos[0]) candidates.push(videos[0]);
  if (!candidates.length) return null;
  // "Artista - Topic" são as faixas de áudio oficiais: sobem pro começo (mantendo a ordem entre elas).
  const isTopic = (v) => /- Topic$/i.test(textOf(v.ownerText));
  candidates.sort((a, b) => Number(isTopic(b)) - Number(isTopic(a)));

  const toTrack = (v) => ({
    videoId: v.videoId,
    title: textOf(v.title),
    channel: textOf(v.ownerText),
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
  });

  // O primeiro é o escolhido; os seguintes servem de reserva se o dono do vídeo bloqueou a
  // reprodução fora do YouTube (comum em clipes oficiais) — o app tenta o próximo.
  const [first, ...rest] = candidates.map(toTrack);
  const track = { ...first, alternatives: rest.slice(0, 4) };
  cache.set(key, track);
  return track;
}
