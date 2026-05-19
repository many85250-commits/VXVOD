const http = require('http');
const https = require('https');
const url = require('url');

const PORT = process.env.PORT || 3000;
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL = 'https://gql.twitch.tv/gql';

function fetchJson(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const reqOptions = new url.URL(reqUrl);
    const req = lib.request({
      hostname: reqOptions.hostname,
      path: reqOptions.pathname + reqOptions.search,
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

function fetchRaw(reqUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = reqUrl.startsWith('https') ? https : http;
    const parsed = new url.URL(reqUrl);
    const req = lib.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
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

// Récupère les métadonnées VOD + seekPreviewsURL via GQL
async function fetchVodMeta(vodId) {
  const query = `query($id:ID!){video(id:$id){id title broadcastType seekPreviewsURL owner{login}}}`;
  const res = await fetchJson(GQL, {
    method: 'POST',
    headers: { 'Client-Id': CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { id: vodId } })
  });
  return res.body?.data?.video || null;
}

// Extrait domain + hash depuis seekPreviewsURL
function parseCdn(seekUrl) {
  if (!seekUrl) return null;
  try {
    const u = new url.URL(seekUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    return { domain: u.origin, hash: parts[0] };
  } catch(e) { return null; }
}

// Teste les qualités CDN directement
async function findQualities(domain, hash) {
  const qualities = [
    { name: 'Source', path: 'chunked' },
    { name: '720p60', path: '720p60' },
    { name: '720p', path: '720p30' },
    { name: '480p', path: '480p30' },
    { name: '360p', path: '360p30' },
    { name: '160p', path: '160p30' },
  ];
  const files = ['index-dvr.m3u8', 'index-muted-dvr.m3u8', 'index.m3u8'];
  const found = [];

  await Promise.all(qualities.map(async (q) => {
    for (const f of files) {
      const testUrl = `${domain}/${hash}/${q.path}/${f}`;
      try {
        const res = await fetchRaw(testUrl, {
          method: 'HEAD',
          headers: { 'Origin': 'https://www.twitch.tv', 'Referer': 'https://www.twitch.tv/' }
        });
        if (res.status === 200 || res.status === 206) {
          found.push({ name: q.name, url: testUrl });
          break;
        }
      } catch(e) {}
    }
  }));

  // Trie dans l'ordre souhaité
  const order = ['Source','720p60','720p','480p','360p','160p'];
  found.sort((a,b) => order.indexOf(a.name) - order.indexOf(b.name));
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
    const meta = await fetchVodMeta(vodId);
    if (!meta) { res.writeHead(404); res.end(JSON.stringify({ error: 'VOD introuvable' })); return; }

    const cdn = parseCdn(meta.seekPreviewsURL);
    if (!cdn) { res.writeHead(404); res.end(JSON.stringify({ error: 'CDN introuvable' })); return; }

    const qualities = await findQualities(cdn.domain, cdn.hash);
    if (!qualities.length) { res.writeHead(404); res.end(JSON.stringify({ error: 'Aucun flux trouvé' })); return; }

    res.writeHead(200);
    res.end(JSON.stringify({ vodId, qualities, method: 'cdn_direct', meta: { title: meta.title } }));
  } catch(e) {
    console.error(e);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleProxy(targetUrl, res) {
  setCors(res);
  if (!targetUrl) { res.writeHead(400); res.end('Missing url'); return; }
  const allowed = ['cloudfront.net','akamaized.net','ttvnw.net','twitch.tv','amazon.com','jtvnw.net'];
  try {
    const parsed = new url.URL(targetUrl);
    if (!allowed.some(d => parsed.hostname.endsWith(d))) { res.writeHead(403); res.end('Domain not allowed'); return; }
  } catch(e) { res.writeHead(400); res.end('Invalid URL'); return; }
  try {
    const upstream = await fetchRaw(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Origin': 'https://www.twitch.tv', 'Referer': 'https://www.twitch.tv/' }
    });
    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
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
