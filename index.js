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

const CINEMETA  = 'https://v3-cinemeta.strem.io';
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
  } catch { return null; }
}

// ─── CINEMETA helpers ─────────────────────────────────────────────────────────
const metaCache = new Map();

async function fetchShowMeta(showId) {
  if (metaCache.has(showId)) return metaCache.get(showId);
  const res = await axios.get(`${CINEMETA}/meta/series/${showId}.json`, { timeout: 10000 });
  const meta = res.data.meta;
  metaCache.set(showId, meta);
  setTimeout(() => metaCache.delete(showId), 7200000); // 2hr TTL
  return meta;
}

function parseRuntime(runtimeStr) {
  if (!runtimeStr) return null;
  const m = String(runtimeStr).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Schedule logic ───────────────────────────────────────────────────────────
//
// Episodes play back-to-back in a deterministic shuffled order.
// Each episode's slot duration = the show's typical runtime (from CINEMETA).
// After all episodes have played, the list cycles again with a new shuffle.
// The current episode is determined by where the current wall-clock time falls
// in the cumulative runtime timeline.
//
// This means the channel naturally advances to the next episode when the
// current one ends, just like a real TV channel.

async function buildSchedule(shows) {
  const allEps = [];
  for (const show of shows) {
    let meta;
    try { meta = await fetchShowMeta(show.id); } catch { continue; }

    const runtime = parseRuntime(meta?.runtime) || 22; // minutes, fallback 22
    const episodes = (meta?.videos || []).filter(v => v.season > 0 && (v.episode || v.number));

    for (const ep of episodes) {
      allEps.push({
        showId:    show.id,
        showName:  show.name,
        showPoster: show.poster || null,
        season:    ep.season,
        episode:   ep.episode || ep.number,
        title:     ep.name || ep.title || `Episode ${ep.episode || ep.number}`,
        thumbnail: ep.thumbnail || null,
        runtime,   // minutes
      });
    }
  }
  return allEps;
}

// Deterministically shuffle an array using a seeded PRNG
function seededShuffle(arr, seed) {
  const a = [...arr];
  const rand = seededRandom(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Given the full episode list, return which episode is playing at `nowMs`
// and all upcoming episodes (for the schedule view).
// The list cycles: after the last episode, it reshuffles with a new seed.
function resolveSchedule(episodes, nowMs, upcomingCount = 20) {
  if (episodes.length === 0) return [];

  const nowMinutes = nowMs / 60000;
  const result = [];

  // We walk forward in time from the beginning of the first cycle
  // Cycle 0 uses seed 0, cycle 1 uses seed 1, etc.
  // Each cycle is a fresh shuffle of the full episode list.

  let timeAccum = 0;
  let cycle = 0;

  // Find where we are right now first (fast-forward to current position)
  // Total runtime per cycle
  const totalRuntimePerCycle = episodes.reduce((s, e) => s + e.runtime, 0);
  if (totalRuntimePerCycle === 0) return [];

  // Which cycle are we in?
  cycle = Math.floor(nowMinutes / totalRuntimePerCycle);
  const posInCycle = nowMinutes % totalRuntimePerCycle;

  // Walk the current cycle to find the current episode
  let shuffled = seededShuffle(episodes, cycle);
  let cumul = 0;
  let startIdx = 0;
  for (let i = 0; i < shuffled.length; i++) {
    if (posInCycle < cumul + shuffled[i].runtime) {
      startIdx = i;
      timeAccum = cycle * totalRuntimePerCycle + cumul;
      break;
    }
    cumul += shuffled[i].runtime;
  }

  // Now collect `upcomingCount` episodes starting from current
  let c = cycle;
  let sh = shuffled;
  let idx = startIdx;

  while (result.length < upcomingCount) {
    const ep = sh[idx];
    result.push({
      ...ep,
      startsAtMs: timeAccum * 60000,
      endsAtMs:   (timeAccum + ep.runtime) * 60000,
      episodeIndex: c * episodes.length + idx,
    });
    timeAccum += ep.runtime;
    idx++;
    if (idx >= sh.length) {
      c++;
      sh = seededShuffle(episodes, c);
      idx = 0;
    }
  }

  return result;
}

function pad(n) { return String(n).padStart(2, '0'); }

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
app.get('/', (_req, res) => res.redirect('/configure'));

// ─── API proxy ───────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ metas: [] });
  try {
    const r = await axios.get(
      `${CINEMETA}/catalog/series/top/search=${encodeURIComponent(q)}.json`,
      { timeout: 6000 }
    );
    res.json(r.data);
  } catch { res.json({ metas: [] }); }
});

// ─── Manifest ─────────────────────────────────────────────────────────────────
app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  const showNames   = (config.shows || []).map(s => s.name).join(', ');
  const channelName = config.name || 'Random TV Channel';

  res.json({
    id:          `tv.randomchannel.${req.params.config.substring(0, 16)}`,
    version:     '1.0.0',
    name:        channelName,
    description: `Your personal TV channel — playing: ${showNames}`,
    logo:        `${ADDON_URL}/logo.png`,
    resources:   ['catalog', 'meta', 'stream'],
    types:       ['series'],
    catalogs: [{
      type:  'series',
      id:    'tv-channel',
      name:  channelName,
      extra: [{ name: 'skip', isRequired: false }],
    }],
    behaviorHints: { adult: false, p2p: false },
  });
});

// ─── Catalog ──────────────────────────────────────────────────────────────────
app.get('/:config/catalog/series/tv-channel.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  let desc = `Your random channel with ${(config.shows || []).map(s => s.name).join(', ')}`;
  try {
    const eps = await buildSchedule(config.shows || []);
    const schedule = resolveSchedule(eps, Date.now(), 1);
    if (schedule.length > 0) {
      const now = schedule[0];
      desc = `Now: ${now.showName} · S${pad(now.season)}E${pad(now.episode)} – ${now.title}`;
    }
  } catch {}

  res.json({
    metas: [{
      id:          `tvchannel:${req.params.config}`,
      type:        'series',
      name:        config.name || 'Random TV Channel',
      poster:      `${ADDON_URL}/channel-poster.png`,
      description: desc,
      genres:      ['Random TV', 'Channel'],
    }],
  });
});

// ─── Meta ─────────────────────────────────────────────────────────────────────
app.get('/:config/meta/series/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  const showNames = (config.shows || []).map(s => s.name).join(', ');
  const now       = Date.now();

  let videos = [];
  let defaultVideoId;
  try {
    const eps      = await buildSchedule(config.shows || []);
    const schedule = resolveSchedule(eps, now, 20);

    videos = schedule.map((slot, i) => {
      const minsLeft = Math.round((slot.endsAtMs - now) / 60000);
      let label;
      if (i === 0)       label = `🔴 NOW  (${minsLeft}m left)`;
      else if (i === 1)  label = '⏭ NEXT';
      else {
        const startsIn = Math.round((slot.startsAtMs - now) / 60000);
        label = startsIn < 60 ? `+${startsIn}m` : `+${Math.round(startsIn / 60)}h`;
      }

      return {
        id:        `tvchannel:${req.params.config}:${slot.episodeIndex}`,
        title:     `${label}  ${slot.showName} · S${pad(slot.season)}E${pad(slot.episode)} – ${slot.title}`,
        season:    1,
        number:    i + 1,
        released:  new Date(slot.startsAtMs).toISOString(),
        thumbnail: slot.thumbnail || undefined,
        overview:  `${slot.showName} · Season ${slot.season}, Episode ${slot.episode} · ${slot.runtime} min`,
      };
    });

    // Tell Stremio which episode is playing NOW so it jumps straight to streams
    if (videos.length > 0) defaultVideoId = videos[0].id;
  } catch {}

  res.json({
    meta: {
      id:          req.params.id,
      type:        'series',
      name:        config.name || 'Random TV Channel',
      poster:      `${ADDON_URL}/channel-poster.png`,
      description: `Your personal random TV channel.\nShowing: ${showNames}\nEpisodes advance automatically when each one ends.`,
      genres:      ['Random TV', 'Channel'],
      videos,
      behaviorHints: {
        defaultVideoId,     // auto-selects the NOW episode on open
        hasScheduledVideos: true,
      },
    },
  });
});

// ─── Stream ───────────────────────────────────────────────────────────────────
app.get('/:config/stream/series/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.json({ streams: [] });

  // ID format: tvchannel:{configHash}:{episodeIndex}
  const parts        = req.params.id.split(':');
  const episodeIndex = parseInt(parts[parts.length - 1], 10);
  if (isNaN(episodeIndex)) return res.json({ streams: [] });

  let ep;
  try {
    const eps = await buildSchedule(config.shows || []);
    if (eps.length === 0) {
      console.error('[stream] buildSchedule returned 0 episodes — check show IDs in config');
      return res.json({ streams: [] });
    }
    const shuffled = seededShuffle(eps, Math.floor(episodeIndex / eps.length));
    ep = shuffled[episodeIndex % eps.length];
  } catch (e) {
    console.error('[stream] buildSchedule error:', e.message);
    return res.json({ streams: [] });
  }

  if (!ep) return res.json({ streams: [] });

  const episodeLabel = `S${pad(ep.season)}E${pad(ep.episode)}`;
  const fullTitle    = `${ep.showName} – ${episodeLabel} – ${ep.title}`;
  const torrentId    = `${ep.showId}:${ep.season}:${ep.episode}`;

  console.log(`[stream] Resolving: ${fullTitle} → ${torrentId}`);

  // Build Torrentio base URL — use RD key if provided
  const torrentioBase = config.rdKey
    ? `${TORRENTIO}/realdebrid=${config.rdKey}`
    : TORRENTIO;

  // Fetch streams — try with RD, fall back to base Torrentio if RD returns nothing
  let torrentStreams = [];
  const fetchStreams = async (base) => {
    const url = `${base}/stream/series/${torrentId}.json`;
    console.log(`[stream] Fetching: ${url.replace(/realdebrid=[^/]+/, 'realdebrid=***')}`);
    const r = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Stremio)' },
    });
    return r.data.streams || [];
  };

  try {
    torrentStreams = await fetchStreams(torrentioBase);
    // If RD was configured but returned nothing, try base Torrentio as fallback
    if (torrentStreams.length === 0 && config.rdKey) {
      console.log('[stream] RD returned 0 streams, trying base Torrentio');
      torrentStreams = await fetchStreams(TORRENTIO);
    }
  } catch (e) {
    console.error('[stream] Torrentio fetch error:', e.message);
  }

  console.log(`[stream] Got ${torrentStreams.length} streams for ${torrentId}`);

  if (torrentStreams.length === 0) {
    return res.json({
      streams: [{
        name:        `📺 ${ep.showName}`,
        title:       `${episodeLabel} · ${ep.title}\n⚠️ No streams found for this episode`,
        externalUrl: `https://www.imdb.com/title/${ep.showId}/episodes/?season=${ep.season}`,
      }],
    });
  }

  const bingeGroup = `tvchannel-${req.params.config.substring(0, 8)}`;

  res.json({
    streams: torrentStreams.slice(0, 6).map(s => ({
      ...s,
      name:  `📺 ${ep.showName}\n${s.name || ''}`.trim(),
      title: `${fullTitle}\n${s.title || ''}`.trim(),
      behaviorHints: { bingeGroup },
    })),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬  Random TV Channel addon`);
  console.log(`    Configure → ${ADDON_URL}/configure`);
  console.log(`    Running on port ${PORT}\n`);
});
