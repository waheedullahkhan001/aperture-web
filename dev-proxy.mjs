// Zero-dependency dev server: serves site/ AND reverse-proxies the API and stream
// paths to the local nginx stack (http://localhost:80) so the browser sees ONE origin.
// This mirrors production (nginx serves the static site same-origin as /api and
// /aperture), which is what the MediaMTX HLS `hlsSession` cookie requires — a
// cross-origin static server can never receive that HttpOnly cookie.
//
//   node dev-proxy.mjs            → http://localhost:5500
//   PORT=3000 UPSTREAM=http://localhost node dev-proxy.mjs
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';

const PORT = Number(process.env.PORT) || 5500;
const UPSTREAM = process.env.UPSTREAM || 'http://localhost'; // the nginx stack
const ROOT = new URL('./site/', import.meta.url).pathname;
const PROXY_PREFIXES = ['/api/', '/aperture/', '/actuator/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.map': 'application/json',
};

function proxy(req, res) {
  const target = new URL(req.url, UPSTREAM);
  const headers = { ...req.headers, host: target.host };
  const up = http.request(target, { method: req.method, headers }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers); // forwards Set-Cookie verbatim
    upRes.pipe(res);
  });
  up.on('error', (e) => { res.writeHead(502); res.end(`proxy error: ${e.message}`); });
  req.pipe(up); // forwards request body (WHEP SDP offer, JSON, etc.)
}

async function serveStatic(req, res) {
  // /watch/<uuid> → watch.html (mirrors the nginx watch route); / → index.html.
  let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (/^\/watch\/[0-9a-fA-F-]{36}$/.test(path)) path = '/watch.html';
  else if (path === '/') path = '/index.html';
  const file = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('404');
  }
}

http.createServer((req, res) => {
  if (PROXY_PREFIXES.some((p) => req.url.startsWith(p))) proxy(req, res);
  else serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`aperture-web dev proxy → http://localhost:${PORT}  (API/stream → ${UPSTREAM})`);
});
