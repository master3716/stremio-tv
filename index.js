const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT      = process.env.PORT || 7000;
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const CINEMETA  = 'https://v3-cinemeta.strem.io';
const TORRENTIO = 'https://torrentio.strem.fun';
const RD_API    = 'https://api.real-debrid.com/rest/1.0';

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
  try { return JSON.parse(Buffer.from(str, 'base64url').toString('utf8')); }
  catch { return null; }
}

function extractRdKey(config) {
  if (!config.torrentioUrl) return null;
  const m = config.torrentioUrl.match(/realdebrid=([^/|&]+)/i);
  return m ? decodeURIComponent(m[1]) : null;
}

// ─── CINEMETA ─────────────────────────────────────────────────────────────────
const metaCache = new Map();

async function fetchShowMeta(showId) {
  if (metaCache.has(showId)) return metaCache.get(showId);
  const res = await axios.get(`${CINEMETA}/meta/series/${showId}.json`, { timeout: 10000 });
  const meta = res.data.meta;
  metaCache.set(showId, meta);
  setTimeout(() => metaCache.delete(showId), 7200000);
  return meta;
}

function parseRuntime(str) {
  const m = String(str || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Schedule ─────────────────────────────────────────────────────────────────
async function buildSchedule(shows) {
  const allEps = [];
  for (const show of shows) {
    let meta;
    try { meta = await fetchShowMeta(show.id); } catch { continue; }
    const runtime = parseRuntime(meta?.runtime) || 22;
    for (const ep of (meta?.videos || [])) {
      const epNum = ep.episode ?? ep.number;
      if (!ep.season || ep.season <= 0 || !epNum) continue;
      allEps.push({
        showId:    show.id,
        showName:  show.name,
        season:    ep.season,
        episode:   epNum,
        title:     ep.name || ep.title || `Episode ${epNum}`,
        thumbnail: ep.thumbnail || null,
        runtime,
      });
    }
  }
  return allEps;
}

function seededShuffle(arr, seed) {
  const a = [...arr];
  const rand = seededRandom(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function resolveSchedule(episodes, nowMs, count = 20) {
  if (episodes.length === 0) return [];

  const nowMin   = nowMs / 60000;
  const cycleLen = episodes.reduce((s, e) => s + e.runtime, 0);
  if (cycleLen === 0) return [];

  const cycle      = Math.floor(nowMin / cycleLen);
  const posInCycle = nowMin % cycleLen;
  let shuffled     = seededShuffle(episodes, cycle);

  // Find which episode is playing right now
  let cumul = 0, startIdx = 0, timeAccum = cycle * cycleLen;
  for (let i = 0; i < shuffled.length; i++) {
    if (posInCycle < cumul + shuffled[i].runtime) {
      startIdx  = i;
      timeAccum = cycle * cycleLen + cumul;
      break;
    }
    cumul += shuffled[i].runtime;
  }

  const result = [];
  let c = cycle, sh = shuffled, idx = startIdx;

  while (result.length < count) {
    const ep = sh[idx];
    result.push({
      ...ep,
      startsAtMs:   timeAccum * 60000,
      endsAtMs:     (timeAccum + ep.runtime) * 60000,
      episodeIndex: c * episodes.length + idx,
    });
    timeAccum += ep.runtime;
    if (++idx >= sh.length) { c++; sh = seededShuffle(episodes, c); idx = 0; }
  }
  return result;
}

function pad(n) { return String(n).padStart(2, '0'); }

// ─── Stream resolution via RD API ─────────────────────────────────────────────
async function resolveStreams(ep, config) {
  const epId = `${ep.showId}:${ep.season}:${ep.episode}`;
  const label = `${ep.showName} S${pad(ep.season)}E${pad(ep.episode)}`;

  // 1. Fetch infoHash streams from base Torrentio (no auth → no 403)
  let baseStreams = [];
  try {
    const r = await axios.get(`${TORRENTIO}/stream/series/${epId}.json`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    baseStreams = (r.data.streams || []).filter(s => s.infoHash);
    console.log(`[stream] ${label}: ${baseStreams.length} base streams`);
  } catch (e) {
    console.error(`[stream] Torrentio error for ${epId}:`, e.message);
  }

  if (baseStreams.length === 0) return [];

  const rdKey = extractRdKey(config);

  // No RD key → return infoHash streams (Stremio plays via BitTorrent)
  if (!rdKey) return baseStreams.slice(0, 4);

  // 2. Check which torrents are instantly cached on RD
  const hashes = baseStreams.slice(0, 6).map(s => s.infoHash.toLowerCase());
  let best = null;
  try {
    const r = await axios.get(
      `${RD_API}/torrents/instantAvailability/${hashes.join('/')}?auth_token=${rdKey}`,
      { timeout: 6000 }
    );
    for (const stream of baseStreams.slice(0, 6)) {
      const info = r.data[stream.infoHash.toLowerCase()];
      if (info?.rd?.length > 0) { best = stream; break; }
    }
    console.log(`[stream] ${label}: RD cached = ${best ? best.infoHash.slice(0, 8) + '...' : 'none'}`);
  } catch (e) {
    console.error(`[stream] RD availability error:`, e.message);
    return baseStreams.slice(0, 4);
  }

  if (!best) {
    console.log(`[stream] ${label}: no cached torrents, using infoHash fallback`);
    return baseStreams.slice(0, 4);
  }

  // 3. Add magnet to RD (idempotent — same hash returns existing torrent)
  let rdId;
  try {
    const r = await axios.post(`${RD_API}/torrents/addMagnet`,
      new URLSearchParams({ magnet: `magnet:?xt=urn:btih:${best.infoHash}`, auth_token: rdKey }),
      { timeout: 8000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    rdId = r.data.id;
  } catch (e) {
    console.error(`[stream] RD addMagnet:`, e.message);
    return baseStreams.slice(0, 4);
  }

  // 4. Select files
  try {
    const fileNum = (best.fileIdx ?? 0) + 1;
    await axios.post(`${RD_API}/torrents/selectFiles/${rdId}`,
      new URLSearchParams({ files: String(fileNum), auth_token: rdKey }),
      { timeout: 5000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
  } catch {
    // Try selecting all files as fallback
    try {
      await axios.post(`${RD_API}/torrents/selectFiles/${rdId}`,
        new URLSearchParams({ files: 'all', auth_token: rdKey }),
        { timeout: 5000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch (e) {
      console.error(`[stream] RD selectFiles:`, e.message);
      return baseStreams.slice(0, 4);
    }
  }

  // 5. Get links from torrent info
  let links = [];
  try {
    const r = await axios.get(`${RD_API}/torrents/info/${rdId}?auth_token=${rdKey}`, { timeout: 6000 });
    links = r.data.links || [];
  } catch (e) {
    console.error(`[stream] RD info:`, e.message);
    return baseStreams.slice(0, 4);
  }

  if (links.length === 0) return baseStreams.slice(0, 4);

  // 6. Unrestrict → direct video URL
  try {
    const r = await axios.post(`${RD_API}/unrestrict/link`,
      new URLSearchParams({ link: links[0], auth_token: rdKey }),
      { timeout: 6000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const url      = r.data.download;
    const filename = r.data.filename || '';
    console.log(`[stream] ${label}: RD URL obtained ✓`);
    return [{ url, name: `📺 ${ep.showName}\n[RD] ${best.name || ''}`.trim(), title: `${label} – ${ep.title}\n${filename}` }];
  } catch (e) {
    console.error(`[stream] RD unrestrict:`, e.message);
    return baseStreams.slice(0, 4);
  }
}

// ─── Static assets ───────────────────────────────────────────────────────────
app.get('/channel-poster.png', (_req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300" viewBox="0 0 200 300">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1a1a2e"/><stop offset="100%" stop-color="#2d1b4e"/>
    </linearGradient></defs>
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

// ─── Configure ────────────────────────────────────────────────────────────────
app.get('/configure', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'configure.html')));
app.get('/', (_req, res) => res.redirect('/configure'));

// ─── API proxy ────────────────────────────────────────────────────────────────
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
  res.json({
    id:          `tv.randomchannel.${req.params.config.substring(0, 16)}`,
    version:     '1.0.0',
    name:        config.name || 'Random TV Channel',
    description: `Playing: ${(config.shows || []).map(s => s.name).join(', ')}`,
    logo:        `${ADDON_URL}/logo.png`,
    resources:   ['catalog', 'meta', 'stream'],
    types:       ['series'],
    catalogs: [{
      type: 'series', id: 'tv-channel', name: config.name || 'Random TV Channel',
      extra: [{ name: 'skip', isRequired: false }],
    }],
    behaviorHints: { adult: false, p2p: false },
  });
});

// ─── Catalog ──────────────────────────────────────────────────────────────────
app.get('/:config/catalog/series/tv-channel.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });

  let desc = (config.shows || []).map(s => s.name).join(', ');
  try {
    const eps      = await buildSchedule(config.shows || []);
    const schedule = resolveSchedule(eps, Date.now(), 1);
    if (schedule[0]) {
      const n = schedule[0];
      desc = `Now: ${n.showName} · S${pad(n.season)}E${pad(n.episode)} – ${n.title}`;
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

  const now     = Date.now();
  let videos    = [];
  let defaultVideoId;

  try {
    const eps      = await buildSchedule(config.shows || []);
    const schedule = resolveSchedule(eps, now, 20);

    videos = schedule.map((slot, i) => {
      const minsLeft = Math.round((slot.endsAtMs - now) / 60000);
      const label =
        i === 0 ? `🔴 NOW  (${minsLeft}m left)` :
        i === 1 ? '⏭ NEXT' :
        (() => { const m = Math.round((slot.startsAtMs - now) / 60000); return m < 60 ? `+${m}m` : `+${Math.round(m/60)}h`; })();

      return {
        id:        `tvchannel:${req.params.config}:${slot.episodeIndex}`,
        title:     `${label}  ${slot.showName} – ${slot.title}`,
        season:    1,
        number:    i + 1,
        released:  new Date(slot.startsAtMs).toISOString(),
        thumbnail: slot.thumbnail || undefined,
        overview:  `${slot.showName} · S${pad(slot.season)}E${pad(slot.episode)} · ${slot.runtime} min`,
      };
    });

    if (videos.length > 0) defaultVideoId = videos[0].id;
  } catch (e) {
    console.error('[meta] error:', e.message);
  }

  res.json({
    meta: {
      id:          req.params.id,
      type:        'series',
      name:        config.name || 'Random TV Channel',
      poster:      `${ADDON_URL}/channel-poster.png`,
      description: `Your random TV channel — episodes advance when each one ends.`,
      genres:      ['Random TV', 'Channel'],
      videos,
      behaviorHints: { defaultVideoId, hasScheduledVideos: true },
    },
  });
});

// ─── Stream ───────────────────────────────────────────────────────────────────
app.get('/:config/stream/series/:id.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.json({ streams: [] });

  const parts        = req.params.id.split(':');
  const episodeIndex = parseInt(parts[parts.length - 1], 10);
  if (isNaN(episodeIndex)) return res.json({ streams: [] });

  let ep;
  try {
    const eps = await buildSchedule(config.shows || []);
    if (!eps.length) return res.json({ streams: [] });
    const shuffled = seededShuffle(eps, Math.floor(episodeIndex / eps.length));
    ep = shuffled[episodeIndex % eps.length];
  } catch (e) {
    console.error('[stream] schedule error:', e.message);
    return res.json({ streams: [] });
  }
  if (!ep) return res.json({ streams: [] });

  console.log(`[stream] ${ep.showName} S${pad(ep.season)}E${pad(ep.episode)} – ${ep.title}`);

  const streams    = await resolveStreams(ep, config);
  const bingeGroup = `tvchannel-${req.params.config.substring(0, 8)}`;

  res.json({
    streams: streams.map(s => ({ ...s, behaviorHints: { bingeGroup } })),
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎬  Random TV Channel`);
  console.log(`    Configure → ${ADDON_URL}/configure`);
  console.log(`    Port ${PORT}\n`);
});
