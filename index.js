const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 7000;
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const CINEMETA = 'https://v3-cinemeta.strem.io';
const TORRENTIO = 'https://torrentio.strem.fun';

// ─── Seeded PRNG (Mulberry32) ────────────────────────────────────────────────
function seededRandom(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Config helpers ──────────────────────────────────────────────────────────
function decodeConfig(str) {
  try {
    return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function encodeConfig(config) {
  return Buffer.from(JSON.stringify(config)).toString('base64url');
}

// ─── CINEMETA episode cache ──────────────────────────────────────────────────
const episodeCache = new Map();

async function getEpisodes(showId) {
  if (episodeCache.has(showId)) return episodeCache.get(showId);
  const res = await axios.get(`${CINEMETA}/meta/series/${showId}.json`, {
    timeout: 8000,
  });
  const episodes = (res.data.meta.videos || []).filter(
    (v) => v.season > 0 && (v.episode || v.number)
  );
  episodeCache.set(showId, episodes);
  // Expire after 2 hours
  setTimeout(() => episodeCache.delete(showId), 7200000);
  return episodes;
}

// ─── Channel logic ───────────────────────────────────────────────────────────
function getCurrentSlot(intervalMinutes) {
  return Math.floor(Date.now() / (intervalMinutes * 60 * 1000));
}

async function getEpisodeForSlot(shows, slotIndex) {
  if (!shows || shows.length === 0) return null;
  const rand = seededRandom(slotIndex);

  // Shuffle shows array for this slot so every show gets fair rotation
  const shuffled = [...shows];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  // Try each show until we find one with episodes
  for (const show of shuffled) {
    try {
      const episodes = await getEpisodes(show.id);
      if (episodes.length === 0) continue;
      const epIndex = Math.floor(rand() * episodes.length);
      const ep = episodes[epIndex];
      return {
        showId: show.id,
        showName: show.name,
        showPoster: show.poster || null,
        season: ep.season,
        episode: ep.episode || ep.number,
        title: ep.name || ep.title || `Episode ${ep.episode || ep.number}`,
        thumbnail: ep.thumbnail || null,
      };
    } catch {
      // skip unavailable show
    }
  }
  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ─── API proxy (used by configure page) ─────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ metas: [] });
  try {
    const r = await axios.get(
      `${CINEMETA}/catalog/series/top/search=${encodeURIComponent(q)}.json`,
      { timeout: 6000 }
    );
    res.json(r.data);
  } catch {
    res.json({ metas: [] });
  }
});

// ─── Static assets ───────────────────────────────────────────────────────────
app.get('/channel-poster.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#1a1a2e"/>
        <stop offset="100%" stop-color="#2d1b4e"/>
      </linearGradient>
    </defs>
    <rect width="200" height="300" fill="url(#g)" rx="8"/>
    <text x="100" y="130" font-size="70" text-anchor="middle" dominant-baseline="middle">📺</text>
    <text x="100" y="200" font-size="15" fill="#a47fd4" text-anchor="middle" font-family="sans-serif" font-weight="bold">RANDOM TV</text>
    <text x="100" y="222" font-size="11" fill="#888" text-anchor="middle" font-family="sans-serif">CHANNEL</text>
    <circle cx="100" cy="258" r="5" fill="#e05260"/>
    <text x="112" y="262" font-size="10" fill="#e05260" font-family="sans-serif" font-weight="bold">LIVE</text>
  </svg>`);
});

app.get('/logo.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect width="64" height="64" fill="#1a1a2e" rx="12"/>
    <text x="32" y="38" font-size="34" text-anchor="middle" dominant-baseline="middle">📺</text>
  </svg>`);
});

// ─── Configure page ──────────────────────────────────────────────────────────
app.get('/configure', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/', (_req, res) => {
  res.redirect('/configure');
});

// ─── Stremio addon endpoints ──────────────────────────────────────────────────

// Manifest
app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  const showNames = (config.shows || []).map((s) => s.name).join(', ');
  const channelName = config.name || 'Random TV Channel';

  res.json({
    id: `tv.randomchannel.${req.params.config.substring(0, 16)}`,
    version: '1.0.0',
    name: channelName,
    description: `Your personal TV channel playing: ${showNames}`,
    logo: `${ADDON_URL}/logo.png`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['series'],
    catalogs: [
      {
        type: 'series',
        id: 'tv-channel',
        name: channelName,
        extra: [{ name: 'skip', isRequired: false }],
      },
    ],
    behaviorHints: { adult: false, p2p: false },
  });
});

// Catalog – returns the single virtual channel item
app.get('/:config/catalog/series/tv-channel.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  const interval = config.interval || 30;
  const slot = getCurrentSlot(interval);

  let nowEp = null;
  try {
    nowEp = await getEpisodeForSlot(config.shows, slot);
  } catch {}

  const desc = nowEp
    ? `Now Playing: ${nowEp.showName} · S${pad(nowEp.season)}E${pad(nowEp.episode)} – ${nowEp.title}`
    : `Your random channel with ${(config.shows || []).map((s) => s.name).join(', ')}`;

  res.json({
    metas: [
      {
        id: `tvchannel:${req.params.config}`,
        type: 'series',
        name: config.name || 'Random TV Channel',
        poster: `${ADDON_URL}/channel-poster.png`,
        background: nowEp && nowEp.thumbnail ? nowEp.thumbnail : undefined,
        description: desc,
        genres: ['Random TV', 'Channel'],
        imdbRating: undefined,
      },
    ],
  });
});

// Meta – full series object with upcoming episode schedule as "videos"
app.get('/:config/meta/series/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  const interval = config.interval || 30;
  const slot = getCurrentSlot(interval);
  const showNames = (config.shows || []).map((s) => s.name).join(', ');

  const videos = [];
  const SLOTS = 20; // show next 20 slots
  for (let i = 0; i < SLOTS; i++) {
    try {
      const ep = await getEpisodeForSlot(config.shows, slot + i);
      if (!ep) continue;

      let label;
      if (i === 0) label = '🔴 NOW';
      else if (i === 1) label = '⏭ NEXT';
      else {
        const mins = i * interval;
        label = mins < 60 ? `+${mins}m` : `+${Math.round(mins / 60)}h`;
      }

      videos.push({
        // Encode slot index inside the video id so stream handler can resolve it
        id: `tvchannel:${req.params.config}:${slot + i}`,
        title: `${label}  ${ep.showName} · S${pad(ep.season)}E${pad(ep.episode)} – ${ep.title}`,
        season: 1,
        number: i + 1,
        released: new Date(Date.now() + i * interval * 60 * 1000).toISOString(),
        thumbnail: ep.thumbnail || undefined,
        overview: `${ep.showName} · Season ${ep.season}, Episode ${ep.episode}`,
      });
    } catch {}
  }

  res.json({
    meta: {
      id: req.params.id,
      type: 'series',
      name: config.name || 'Random TV Channel',
      poster: `${ADDON_URL}/channel-poster.png`,
      description: `Your personal random TV channel.\nShowing: ${showNames}\nEpisodes rotate every ${interval} minute${interval !== 1 ? 's' : ''}.`,
      genres: ['Random TV', 'Channel'],
      videos,
    },
  });
});

// Stream – resolve the slot to a real episode and fetch streams from Torrentio
app.get('/:config/stream/series/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.json({ streams: [] });

  // ID format: tvchannel:{configHash}:{slotIndex}
  const parts = req.params.id.split(':');
  const slotIndex = parseInt(parts[parts.length - 1], 10);
  if (isNaN(slotIndex)) return res.json({ streams: [] });

  let ep;
  try {
    ep = await getEpisodeForSlot(config.shows, slotIndex);
  } catch {
    return res.json({ streams: [] });
  }
  if (!ep) return res.json({ streams: [] });

  const episodeLabel = `S${pad(ep.season)}E${pad(ep.episode)}`;
  const fullTitle = `${ep.showName} – ${episodeLabel} – ${ep.title}`;

  // Fetch streams from Torrentio for the real episode
  let torrentStreams = [];
  try {
    const torRes = await axios.get(
      `${TORRENTIO}/stream/series/${ep.showId}:${ep.season}:${ep.episode}.json`,
      { timeout: 12000 }
    );
    torrentStreams = (torRes.data.streams || []).slice(0, 6);
  } catch {}

  if (torrentStreams.length === 0) {
    return res.json({
      streams: [
        {
          name: `📺 ${ep.showName}`,
          title: `${episodeLabel} · ${ep.title}\n⚠️ No streams found – install Torrentio`,
          externalUrl: `https://www.imdb.com/title/${ep.showId}/`,
        },
      ],
    });
  }

  const streams = torrentStreams.map((s) => ({
    ...s,
    name: `📺 ${ep.showName}\n${s.name || ''}`.trim(),
    title: `${fullTitle}\n${s.title || ''}`.trim(),
  }));

  res.json({ streams });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬  Random TV Channel addon`);
  console.log(`    Configure → ${ADDON_URL}/configure`);
  console.log(`    Running on port ${PORT}\n`);
});
