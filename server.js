const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL = 'https://gql.twitch.tv/gql';

const CDN_SERVERS = [
  "d3stzm2eumvgb4","d2nvs31859zcd8","d2e2de1etea730","d3aqoihi2n8ty8",
  "d1m7jfoe9zdc1j","d2vjef5jvl6bfs","d1g1f25tn8m2e6","d2dylwb3shzel1",
  "d2um2qdswy1tb0","d36nr0u3xmc4mm","d1mhjrowxxagfy","d1oca24q5dwo6d",
  "d1w2poirtb3as9","d1xhnb4ptk05mw","d1ymi26ma8va5x","d2aba1wr3818hz",
  "d2xmjdvx03ij56","d3c27h4odz752x","d3vd9lfkzbru3h","d3fi1amfgojobc",
  "d2v02itv0y9u9t","d1mjs7qzzz669v","dgeft87wbj63p","ddacn6pr5v0tl"
];

function sha1(msg) {
  return crypto.createHash('sha1').update(msg).digest('hex');
}

function fetchRaw(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    try {
      const parsed = new URL(reqUrl);
      const req = lib.request({
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 6000,
      }, res => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          return fetchRaw(res.headers.location, options).then(resolve).catch(reject);
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch(e) { reject(e); }
  });
}

function fetchJson(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const parsed = new URL(reqUrl);
    const req = lib.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: null, raw: data }); }
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fetchVodInfo(vodId) {
  const query = `query($id:ID!){video(id:$id){id title broadcastType owner{login} previewThumbnailURL(width:640,height:360) animatedPreviewURL seekPreviewsURL}}`;
  const res = await fetchJson(GQL, {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: vodId } })
  });
  return res.body?.data?.video || null;
}

function extractMidpath(u) {
  if (!u) return null;
  const match = /([a-f0-9]{20}_[a-zA-Z0-9_]+_\d+_\d+)/.exec(u);
  return match ? match[1] : null;
}

async function testUrl(testUrl) {
  try {
    const res = await fetchRaw(testUrl, { method: 'HEAD', timeout: 4000 });
    return res.status === 200 || res.status === 206;
  } catch(e) { return false; }
}

async function findQualitiesFromMidpath(midpath) {
  // Trouve d'abord un serveur qui marche
  let baseUrl = null;
  for (const server of CDN_SERVERS) {
    const u = `https://${server}.cloudfront.net/${midpath}/chunked/index-dvr.m3u8`;
    if (await testUrl(u)) { baseUrl = `https://${server}.cloudfront.net/${midpath}`; break; }
    const u2 = `https://${server}.cloudfront.net/${midpath}/chunked/index-muted-dvr.m3u8`;
    if (await testUrl(u2)) { baseUrl = `https://${server}.cloudfront.net/${midpath}`; break; }
  }
  if (!baseUrl) return [];

  const qualityPaths = [
    { name: 'Source', path: 'chunked' },
    { name: '1080p60', path: '1080p60' },
    { name: '1080p', path: '1080p30' },
    { name: '720p60', path: '720p60' },
    { name: '720p', path: '720p30' },
    { name: '480p', path: '480p30' },
    { name: '360p', path: '360p30' },
    { name: '160p', path: '160p30' },
  ];
  const files = ['index-dvr.m3u8', 'index-muted-dvr.m3u8'];
  const found = [];

  await Promise.all(qualityPaths.map(async (q) => {
    for (const f of files) {
      const u = `${baseUrl}/${q.path}/${f}`;
      if (await testUrl(u)) { found.push({ name: q.name, url: u }); break; }
    }
  }));

  const order = ['Source','1080p60','1080p','720p60','720p','480p','360p','160p'];
  found.sort((a,b) => order.indexOf(a.name) - order.indexOf(b.name));
  return found;
}

async function findQualitiesFromDomain(domain, hash) {
  const qualityPaths = [
    { name: 'Source', path: 'chunked' },
    { name: '1080p60', path: '1080p60' },
    { name: '1080p', path: '1080p30' },
    { name: '720p60', path: '720p60' },
    { name: '720p', path: '720p30' },
    { name: '480p', path: '480p30' },
    { name: '360p', path: '360p30' },
    { name: '160p', path: '160p30' },
  ];
  const files = ['index-dvr.m3u8', 'index-muted-dvr.m3u8'];
  const found = [];

  await Promise.all(qualityPaths.map(async (q) => {
    for (const f of files) {
      const u = `${domain}/${hash}/${q.path}/${f}`;
      if (await testUrl(u)) { found.push({ name: q.name, url: u }); break; }
    }
  }));

  const order = ['Source','1080p60','1080p','720p60','720p','480p','360p','160p'];
  found.sort((a,b) => order.indexOf(a.name) - order.indexOf(b.name));
  return found;
}

// Bruteforce SHA1 avec les données SullyGnome
async function bruteforceWithSully(streams, vodTimestamp) {
  // Trie les streams par proximité avec le timestamp de la VOD
  const sorted = [...streams].sort((a,b) =>
    Math.abs(a.timestamp_seconds - vodTimestamp) - Math.abs(b.timestamp_seconds - vodTimestamp)
  );

  for (const stream of sorted.slice(0, 5)) {
    const { channel_login, stream_id, timestamp_seconds } = stream;
    if (!channel_login || !stream_id || !timestamp_seconds) continue;

    // Essaie avec offsets ±5 secondes
    for (let offset = 0; offset <= 5; offset++) {
      for (const sign of [1, -1]) {
        const ts = timestamp_seconds + (offset * sign);
        const hash = sha1(`${channel_login}_${stream_id}_${ts}`).slice(0, 20);
        const midpath = `${hash}_${channel_login}_${stream_id}_${ts}`;

        for (const server of CDN_SERVERS.slice(0, 6)) {
          const u = `https://${server}.cloudfront.net/${midpath}/chunked/index-dvr.m3u8`;
          if (await testUrl(u)) {
            console.log(`SHA1 trouvé: ${midpath}`);
            return midpath;
          }
        }
      }
    }
  }
  return null;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
}

async function handleVod(vodId, res, body) {
  setCors(res);
  res.setHeader('Content-Type', 'application/json');
  try {
    const vod = await fetchVodInfo(vodId);
    if (!vod) { res.writeHead(404); res.end(JSON.stringify({ error: 'VOD introuvable' })); return; }

    let qualities = [];

    // Méthode 1 : extrait depuis previewThumbnailURL/animatedPreviewURL
    const midpath = extractMidpath(vod.previewThumbnailURL) || extractMidpath(vod.animatedPreviewURL);
    if (midpath) {
      console.log(`[${vodId}] Méthode 1 - midpath: ${midpath}`);
      qualities = await findQualitiesFromMidpath(midpath);
    }

    // Méthode 2 : seekPreviewsURL
    if (!qualities.length && vod.seekPreviewsURL) {
      try {
        const u = new URL(vod.seekPreviewsURL);
        const hash = u.pathname.split('/').filter(Boolean)[0];
        if (hash) {
          console.log(`[${vodId}] Méthode 2 - seekPreviewsURL`);
          qualities = await findQualitiesFromDomain(u.origin, hash);
        }
      } catch(e) {}
    }

    // Méthode 3 : SHA1 bruteforce avec données SullyGnome envoyées par le navigateur
    if (!qualities.length && body?.streams?.length) {
      console.log(`[${vodId}] Méthode 3 - SHA1 SullyGnome (${body.streams.length} streams)`);
      // Utilise le timestamp de la VOD pour trouver le bon stream
      const vodTs = vod.createdAt ? Math.floor(new Date(vod.createdAt).getTime()/1000) : 0;
      const foundMidpath = await bruteforceWithSully(body.streams, vodTs);
      if (foundMidpath) {
        qualities = await findQualitiesFromMidpath(foundMidpath);
      }
    }

    if (!qualities.length) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Aucun flux trouvé', vodId }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ vodId, qualities, meta: { title: vod.title } }));
  } catch(e) {
    console.error(e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleProxy(targetUrl, res, selfBase) {
  setCors(res);
  if (!targetUrl) { res.writeHead(400); res.end('Missing url'); return; }
  const allowed = ['cloudfront.net','akamaized.net','ttvnw.net','twitch.tv','amazon.com','jtvnw.net'];
  try {
    const parsed = new URL(targetUrl);
    if (!allowed.some(d => parsed.hostname.endsWith(d))) { res.writeHead(403); res.end('Domain not allowed'); return; }
  } catch(e) { res.writeHead(400); res.end('Invalid URL'); return; }
  try {
    const upstream = await fetchRaw(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.twitch.tv', 'Referer': 'https://www.twitch.tv/' }
    });
    let ct = upstream.headers['content-type'] || 'application/octet-stream';
    if (targetUrl.includes('.m3u8') || ct.includes('mpegurl')) {
      ct = 'application/vnd.apple.mpegurl';
      let m3u8 = upstream.body.toString('utf8');
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      m3u8 = m3u8.split('\n').map(line => {
        const l = line.trim();
        if (!l || l.startsWith('#')) return line;
        const absUrl = l.startsWith('http') ? l : baseUrl + l;
        return selfBase + '/proxy?url=' + encodeURIComponent(absUrl);
      }).join('\n');
      res.setHeader('Content-Type', ct);
      res.writeHead(200);
      res.end(m3u8);
    } else {
      res.setHeader('Content-Type', ct);
      res.writeHead(upstream.status);
      res.end(upstream.body);
    }
  } catch(e) { res.writeHead(502); res.end('Upstream error: ' + e.message); }
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch(e) { resolve(null); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { setCors(res); res.writeHead(204); res.end(); return; }
  if (pathname === '/health') { setCors(res); res.setHeader('Content-Type','application/json'); res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }

  const vodMatch = pathname.match(/^\/vod\/(\d+)$/);
  if (vodMatch) {
    const body = req.method === 'POST' ? await readBody(req) : null;
    await handleVod(vodMatch[1], res, body);
    return;
  }

  if (pathname === '/proxy') {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const selfBase = proto + '://' + host;
    await handleProxy(parsed.query.url, res, selfBase);
    return;
  }

  setCors(res); res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => console.log(`✅ VXVOD Proxy Server on port ${PORT}`));
