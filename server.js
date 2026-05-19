const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL = 'https://gql.twitch.tv/gql';

function fetchJson(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new url.URL(reqUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(reqUrl, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), raw: data }); }
        catch(e) { resolve({ status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function fetchRaw(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const req = lib.request(reqUrl, {
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
        return fetchRaw(res.headers.location, options).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function fetchVodMeta(vodId) {
  const query = `query($id:ID!){video(id:$id){id title broadcastType createdAt owner{login} seekPreviewsURL}}`;
  const res = await fetchJson(GQL, {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: vodId } })
  });
  return res.body?.data?.video || null;
}

async function fetchPlaybackToken(vodId) {
  const query = `{videoPlaybackAccessToken(id:"${vodId}",params:{platform:"web",playerBackend:"mediaplayer",playerType:"site"}){value signature}}`;
  const res = await fetchJson(GQL, {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  return res.body?.data?.videoPlaybackAccessToken || null;
}

async function fetchUsherM3u8(vodId, token) {
  const params = new URLSearchParams({
    sig: token.signature, token: token.value,
    allow_source: 'true', allow_spectre: 'true', allow_audio_only: 'true',
    fast_bread: 'true', p: Math.floor(Math.random() * 999999),
    platform: 'web', player_backend: 'mediaplayer',
    playlist_include_framerate: 'true', reassignments_supported: 'true',
    supported_codecs: 'avc1', transcode_mode: 'cbr_v1'
  });
  const usherUrl = `https://usher.twitchapps.com/vod/${vodId}.m3u8?${params}`;
  const res = await fetchRaw(usherUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*', 'Origin': 'https://www.twitch.tv', 'Referer': 'https://www.twitch.tv/',
    }
  });
  return res.status === 200 ? res.body.toString() : null;
}

function parseM3u8Qualities(m3u8Text) {
  const lines = m3u8Text.split('\n');
  const qualities = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const nameMatch = line.match(/NAME="([^"]+)"/);
      const name = nameMatch ? nameMatch[1] : null;
      if (lines[i+1] && !lines[i+1].startsWith('#')) {
        const streamUrl = lines[i+1].trim();
        if (name && streamUrl) qualities.push({ name, url: streamUrl });
        i++;
      }
    }
  }
  return qualities;
}

function parseCdnFromSeekUrl(seekUrl) {
  if (!seekUrl) return null;
  try {
    const u = new url.URL(seekUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return { domain: u.origin, hash: parts[0] };
  } catch(e) { return null; }
}

async function tryDirectCdn(domain, hash) {
  const qualities = [
    { name: 'Source', path: 'chunked' }, { name: '720p60', path: '720p60' },
    { name: '720p', path: '720p30' }, { name: '480p', path: '480p30' },
    { name: '360p', path: '360p30' }, { name: '160p', path: '160p30' },
  ];
  const filenames = ['index-dvr.m3u8', 'index-muted-dvr.m3u8', 'index.m3u8'];
  const found = [];
  for (const q of qualities) {
    for (const f of filenames) {
      const testUrl = `${domain}/${hash}/${q.path}/${f}`;
      try {
        const res = await fetchRaw(testUrl, { method: 'HEAD' });
        if (res.status === 200 || res.status === 206) { found.push({ name: q.name, url: testUrl }); break; }
      } catch(e) {}
    }
  }
  return found;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

async function handleVod(vodId, res) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  try {
    let qualities = [], method = null, meta = null;

    // Méthode 1 : Token GQL + Usher
    try {
      const token = await fetchPlaybackToken(vodId);
      if (token) {
        const m3u8 = await fetchUsherM3u8(vodId, token);
        if (m3u8 && m3u8.includes('#EXTM3U')) {
          const q = parseM3u8Qualities(m3u8);
          if (q.length > 0) { qualities = q; method = 'usher_token'; }
        }
      }
    } catch(e) { console.log('Usher failed:', e.message); }

    // Méthode 2 : CDN direct
    if (qualities.length === 0) {
      try {
        const vodMeta = await fetchVodMeta(vodId);
        if (vodMeta) {
          meta = { title: vodMeta.title, broadcastType: vodMeta.broadcastType };
          const cdn = parseCdnFromSeekUrl(vodMeta.seekPreviewsURL);
          if (cdn) {
            const cdnQ = await tryDirectCdn(cdn.domain, cdn.hash);
            if (cdnQ.length > 0) { qualities = cdnQ; method = 'cdn_direct'; }
          }
        }
      } catch(e) { console.log('CDN failed:', e.message); }
    }

    if (qualities.length === 0) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Aucun flux trouvé', vodId }));
      return;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ vodId, qualities, method, meta }));
  } catch(e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleProxy(targetUrl, res) {
  setCors(res);
  if (!targetUrl) { res.writeHead(400); res.end('Missing url'); return; }
  const allowed = ['cloudfront.net','akamaized.net','twitchapps.com','ttvnw.net','twitch.tv','amazon.com'];
  try {
    const parsed = new url.URL(targetUrl);
    if (!allowed.some(d => parsed.hostname.endsWith(d))) { res.writeHead(403); res.end('Domain not allowed'); return; }
  } catch(e) { res.writeHead(400); res.end('Invalid URL'); return; }
  try {
    const upstream = await fetchRaw(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.twitch.tv', 'Referer': 'https://www.twitch.tv/' }
    });
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');
    res.writeHead(upstream.status);
    res.end(upstream.body);
  } catch(e) { res.writeHead(502); res.end('Upstream error: ' + e.message); }
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { setCors(res); res.writeHead(204); res.end(); return; }
  if (pathname === '/health') { setCors(res); res.setHeader('Content-Type','application/json'); res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }

  const vodMatch = pathname.match(/^\/vod\/(\d+)$/);
  if (vodMatch) { await handleVod(vodMatch[1], res); return; }
  if (pathname === '/proxy') { await handleProxy(parsed.query.url, res); return; }

  setCors(res); res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`✅ VXVOD Proxy Server on port ${PORT}`));
