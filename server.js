const http = require('http');
const https = require('https');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL = 'https://gql.twitch.tv/gql';

const CDN_SERVERS = [
  "d1g1f25tn8m2e6","d1m7jfoe9zdc1j","d1mhjrowxxagfy","d1oca24q5dwo6d",
  "d1w2poirtb3as9","d1xhnb4ptk05mw","d1ymi26ma8va5x","d2aba1wr3818hz",
  "d2dylwb3shzel1","d2e2de1etea730","d2nvs31859zcd8","d2um2qdswy1tb0",
  "d2vjef5jvl6bfs","d2xmjdvx03ij56","d36nr0u3xmc4mm","d3aqoihi2n8ty8",
  "d3c27h4odz752x","d3vd9lfkzbru3h","d6d4ismr40iw","d6tizftlrpuof",
  "ddacn6pr5v0tl","dgeft87wbj63p","dqrpb9wgowsf5","ds0h3roq6wcgc",
  "dykkng5hnh52u","d3fi1amfgojobc","d2v02itv0y9u9t","d1mjs7qzzz669v"
];

function sha1(msg) {
  return crypto.createHash('sha1').update(msg).digest('hex');
}

function fetchRaw(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const parsed = new URL(reqUrl);
    const req = lib.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: options.timeout || 8000,
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

async function gql(query, variables) {
  return fetchJson(GQL, {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
}

// Récupère infos VOD + URLs thumbnails pour extraire le hash CDN
async function fetchVodInfo(vodId) {
  const q = `query($id:ID!){
    video(id:$id){
      id title broadcastType lengthSeconds
      owner { login displayName }
      previewThumbnailURL(width:640,height:360)
      animatedPreviewURL
      seekPreviewsURL
    }
  }`;
  const res = await gql(q, { id: vodId });
  return res.body?.data?.video || null;
}

// Extrait le hash depuis les URLs de thumbnail (méthode principale)
function extractHashFromUrls(vod) {
  const urls = [vod.previewThumbnailURL, vod.animatedPreviewURL, vod.seekPreviewsURL].filter(Boolean);
  for (const u of urls) {
    const match = /([a-f0-9]{20})_([a-zA-Z0-9_]+)_(\d+)_(\d+)/.exec(u);
    if (match) {
      return {
        hash: match[1],
        channel_login: match[2].replace(/_$/, ''),
        stream_id: match[3],
        timestamp_seconds: parseInt(match[4]),
        midpath: `${match[1]}_${match[2]}_${match[3]}_${match[4]}`
      };
    }
  }
  // Essaie aussi depuis seekPreviewsURL (format différent)
  if (vod.seekPreviewsURL) {
    try {
      const u = new URL(vod.seekPreviewsURL);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts[0]) {
        return { hash: parts[0], midpath: parts[0] };
      }
    } catch(e) {}
  }
  return null;
}

// Construit l'URL CDN avec le midpath
function buildCdnUrl(server, midpath, quality, filename) {
  return `https://${server}.cloudfront.net/${midpath}/${quality}/${filename}`;
}

// Teste si une URL CDN existe
async function testUrl(testUrl) {
  try {
    const res = await fetchRaw(testUrl, { method: 'HEAD', timeout: 4000 });
    return res.status === 200 || res.status === 206;
  } catch(e) { return false; }
}

// Bruteforce SHA1 pour trouver le hash (méthode fallback)
async function bruteforceHash(channel_login, stream_id, timestamp_seconds) {
  const offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 10, -10, 30, -30, 60, -60];
  for (const offset of offsets) {
    const ts = timestamp_seconds + offset;
    const hash = sha1(`${channel_login}_${stream_id}_${ts}`).slice(0, 20);
    const midpath = `${hash}_${channel_login}_${stream_id}_${ts}`;
    // Teste avec quelques serveurs prioritaires
    for (const server of CDN_SERVERS.slice(0, 8)) {
      const testurl = buildCdnUrl(server, midpath, 'chunked', 'index-dvr.m3u8');
      const ok = await testUrl(testurl);
      if (ok) return midpath;
    }
  }
  return null;
}

// Trouve toutes les qualités disponibles pour un midpath
async function findQualities(midpath) {
  // Trouve d'abord le bon serveur
  let goodServer = null;
  for (const server of CDN_SERVERS) {
    const ok = await testUrl(buildCdnUrl(server, midpath, 'chunked', 'index-dvr.m3u8'));
    if (ok) { goodServer = server; break; }
  }
  if (!goodServer) {
    // Essaie avec index-muted-dvr.m3u8
    for (const server of CDN_SERVERS) {
      const ok = await testUrl(buildCdnUrl(server, midpath, 'chunked', 'index-muted-dvr.m3u8'));
      if (ok) { goodServer = server; break; }
    }
  }
  if (!goodServer) return [];

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
      const u = buildCdnUrl(goodServer, midpath, q.path, f);
      const ok = await testUrl(u);
      if (ok) { found.push({ name: q.name, url: u }); break; }
    }
  }));

  const order = ['Source','1080p60','1080p','720p60','720p','480p','360p','160p'];
  found.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
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
    const vod = await fetchVodInfo(vodId);
    if (!vod) { res.writeHead(404); res.end(JSON.stringify({ error: 'VOD introuvable' })); return; }

    let midpath = null;

    // Méthode 1 : extrait le hash depuis les URLs de thumbnail
    const extracted = extractHashFromUrls(vod);
    if (extracted?.midpath) {
      midpath = extracted.midpath;
      console.log(`[${vodId}] Hash extrait: ${midpath}`);
    }

    // Méthode 2 : bruteforce SHA1 si on a channel_login + stream_id + timestamp
    if (!midpath && extracted?.channel_login && extracted?.stream_id && extracted?.timestamp_seconds) {
      console.log(`[${vodId}] Bruteforce SHA1...`);
      midpath = await bruteforceHash(extracted.channel_login, extracted.stream_id, extracted.timestamp_seconds);
    }

    // Méthode 3 : bruteforce depuis login du owner si on a rien
    if (!midpath && vod.owner?.login) {
      // Essaie de récupérer via les VODs récentes du streamer pour avoir stream_id/timestamp
      console.log(`[${vodId}] Tentative via VODs récentes...`);
      const q2 = `query($login:String!){user(login:$login){videos(first:20,sort:TIME){edges{node{id animatedPreviewURL previewThumbnailURL}}}}}`;
      const r2 = await gql(q2, { login: vod.owner.login });
      const edges = r2.body?.data?.user?.videos?.edges || [];
      for (const e of edges) {
        if (e.node.id === vodId) {
          const ex2 = extractHashFromUrls(e.node);
          if (ex2?.midpath) { midpath = ex2.midpath; break; }
        }
      }
    }

    if (!midpath) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Hash CDN introuvable pour cette VOD', vodId }));
      return;
    }

    const qualities = await findQualities(midpath);
    if (!qualities.length) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Aucun flux CDN trouvé', vodId, midpath }));
      return;
    }

    res.writeHead(200);
    res.end(JSON.stringify({ vodId, qualities, method: 'cdn_sha1', meta: { title: vod.title } }));
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

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'OPTIONS') { setCors(res); res.writeHead(204); res.end(); return; }
  if (pathname === '/health') { setCors(res); res.setHeader('Content-Type','application/json'); res.writeHead(200); res.end(JSON.stringify({ ok: true })); return; }

  const vodMatch = pathname.match(/^\/vod\/(\d+)$/);
  if (vodMatch) { await handleVod(vodMatch[1], res); return; }

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
