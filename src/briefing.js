import { groupAgenda } from './agenda.js';
import { formatDateShort, formatTime } from './format.js';

const FETCH_TIMEOUT_MS = 8000;
const WEATHER_CACHE_MS = 30 * 60 * 1000;
const weatherCache = new Map();

async function withOneRetry(fn) {
  try {
    return await fn();
  } catch {
    return fn();
  }
}

const WEATHER_CODES = {
  0: 'céu limpo', 1: 'predomínio de sol', 2: 'parcialmente nublado', 3: 'nublado',
  45: 'neblina', 48: 'neblina', 51: 'garoa fraca', 53: 'garoa', 55: 'garoa forte',
  61: 'chuva fraca', 63: 'chuva', 65: 'chuva forte', 80: 'pancadas de chuva fraca',
  81: 'pancadas de chuva', 82: 'pancadas de chuva forte', 95: 'trovoadas', 96: 'trovoadas com granizo', 99: 'trovoadas com granizo',
};

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchWeatherUncached(city) {
  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=pt&country_code=BR`,
  );
  const place = geo.results?.[0];
  if (!place) return null;
  const f = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=America%2FSao_Paulo&forecast_days=1',
  );
  const d = f.daily;
  return {
    city: place.name,
    condition: WEATHER_CODES[d.weathercode?.[0]] || 'sem descrição',
    min_c: Math.round(d.temperature_2m_min[0]),
    max_c: Math.round(d.temperature_2m_max[0]),
    rain_probability_pct: d.precipitation_probability_max?.[0] ?? null,
  };
}

export async function fetchWeather(city) {
  const key = city.trim().toLowerCase();
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < WEATHER_CACHE_MS) return hit.data;
  const data = await withOneRetry(() => fetchWeatherUncached(city));
  if (data) weatherCache.set(key, { at: Date.now(), data });
  return data;
}

function unescapeXml(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim();
}

async function fetchHeadlines(query, limit) {
  const base = 'https://news.google.com/rss';
  const params = 'hl=pt-BR&gl=BR&ceid=BR:pt-419';
  const url = query
    ? `${base}/search?q=${encodeURIComponent(`${query} when:1d`)}&${params}`
    : `${base}?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)].map((m) => unescapeXml(m[1]));
  return titles.slice(0, limit);
}

export async function fetchNews(interests) {
  const topics = (interests || []).slice(0, 3);
  if (!topics.length) return [];
  const results = await Promise.allSettled(topics.map((t) => withOneRetry(() => fetchHeadlines(t, 2))));
  return results
    .map((r, i) => ({ topic: topics[i], headlines: r.status === 'fulfilled' ? r.value : [] }))
    .filter((r) => r.headlines.length);
}

const compact = (t) => ({
  id: t.id,
  title: t.title,
  date: formatDateShort(t.dueAt),
  time: formatTime(t.dueAt),
  link: t.link || null,
});

/** Junta tudo que entra no briefing; cada fonte externa falha sozinha, sem derrubar o resto. */
export async function buildBriefingData({ store, profile, now = new Date() }) {
  const { today, overdue, upcoming } = groupAgenda(store, now);

  const [weather, news] = await Promise.all([
    profile.city ? fetchWeather(profile.city).catch(() => null) : Promise.resolve(null),
    fetchNews(profile.interests).catch(() => []),
  ]);

  return {
    today_label: now.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }),
    agenda: {
      today: today.map(compact),
      overdue_most_recent: overdue.slice(-5).map(compact),
      overdue_total: overdue.length,
      next_7_days: upcoming.slice(0, 5).map(compact),
    },
    weather,
    weather_unavailable_reason: weather ? null : profile.city ? 'não consegui consultar agora' : 'cidade não informada no perfil',
    news,
    news_unavailable_reason: news.length ? null : (profile.interests?.length ? 'não consegui consultar agora' : 'a pessoa ainda não disse quais temas quer acompanhar'),
    profile: { city: profile.city || null, interests: profile.interests, notes: profile.notes },
  };
}
