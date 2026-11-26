// Standalone server: multiplayer WebSocket at /mp, online counts at /health,
// the admin API at /admin/api/* (server/admin-api.mjs), and (when the Vite build exists) the static site itself, so one process can
// serve the whole app.
//
//   npm run build && npm run server        → http://localhost:8787
//
// Environment:
//   PORT                  (8787)
//   HOST                  (unset = all interfaces, IPv4 + IPv6)
//   STATIC_DIR            (../dist relative to this file; "" disables static serving)
//   MAX_PLAYERS_PER_ROOM  (127)
//   TICK_MS               (50)
//   VIEW_DISTANCE         (0 = relay everyone)
//   ALLOWED_ORIGINS       (comma-separated; default RENDER_EXTERNAL_URL on Render, else any)
//   MAX_CONNECTIONS       (1000) all WebSocket connections together
//   MAX_PER_IP            (12) WebSocket connections from one IP (X-Forwarded-For behind a proxy)
//   MAX_ROOMS             (20) rooms open at once
//   DATA_DIR              (server/data) where wallets.json (flowers, daily rewards) and feedback.json are kept
//   REWARDS_TZ            (Asia/Ho_Chi_Minh) calendar of the daily rewards
//   FIREBASE_PROJECT_ID   (falls back to VITE_FIREBASE_PROJECT_ID; unset = name changes disabled)

import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealm } from './realm.mjs';
import { createAdminApi } from './admin-api.mjs';
import { createFeedback } from './feedback.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST || undefined;
const STATIC_DIR = env.STATIC_DIR === '' ? null : path.resolve(here, env.STATIC_DIR ?? '../dist');

const FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID || env.VITE_FIREBASE_PROJECT_ID || '';
const DATA_DIR = env.DATA_DIR ? path.resolve(env.DATA_DIR) : path.join(here, 'data');
const realm = createRealm({
  dataDir: DATA_DIR,
  timeZone: env.REWARDS_TZ || undefined,
  maxPlayersPerRoom: Number(env.MAX_PLAYERS_PER_ROOM ?? 127),
  tickMs: Number(env.TICK_MS ?? 50),
  viewDistance: Number(env.VIEW_DISTANCE ?? 0),
  // On Render, default to the service's own URL (RENDER_EXTERNAL_URL) so other
  // sites cannot embed the relay; add custom domains in ALLOWED_ORIGINS.
  allowedOrigins: (env.ALLOWED_ORIGINS || env.RENDER_EXTERNAL_URL || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  maxConnections: Number(env.MAX_CONNECTIONS ?? 1000),
  maxPerIp: Number(env.MAX_PER_IP ?? 12),
  maxRooms: Number(env.MAX_ROOMS ?? 20),
  firebaseProjectId: FIREBASE_PROJECT_ID,
});
const feedback = createFeedback({ dataDir: DATA_DIR, projectId: FIREBASE_PROJECT_ID, timeZone: env.REWARDS_TZ || undefined });
const adminApi = createAdminApi({ realm, feedback, projectId: FIREBASE_PROJECT_ID });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.ktx2': 'image/ktx2',
  '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Security headers on every response. The CSP allows what the game loads:
 * Google Fonts, Firebase (Auth, Firestore, config), the WebSocket relay (any
 * wss:/ws: host, see VITE_MULTIPLAYER_URL), WebAssembly decoders (Draco, Basis)
 * and their blob: workers, data:/blob: images and audio, inline style
 * attributes (progress bars, swatches).
 */
const CSP = [
  "default-src 'self'",
  // 'unsafe-eval': the Basis texture transcoder (Emscripten embind) builds functions
  // with new Function() inside its blob: worker, which inherits this policy.
  "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' ws: wss: https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.firebaseapp.com https://*.cloudfunctions.net",
  "frame-src https://*.firebaseapp.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000', // ignored over plain http (localhost)
};

/** Text-like files worth compressing (geometries, images, audio are compressed already). */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.wasm']);
/** Compressed copies, by file + encoding + mtime (dist/ is small and only changes on deploy). */
const compressedCache = new Map();
/** Vite's hashed build files (dist/assets/name-HASH.js): safe to cache for a year. */
const HASHED = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8}\.(js|css)$/;

function encodingFor(req, ext) {
  if (!COMPRESSIBLE.has(ext)) return '';
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return '';
}

function compressed(file, stat, encoding) {
  const key = `${file}|${encoding}|${stat.mtimeMs}`;
  let buf = compressedCache.get(key);
  if (!buf) {
    const raw = fs.readFileSync(file);
    buf = encoding === 'br'
      ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
      : zlib.gzipSync(raw, { level: 9 });
    compressedCache.set(key, buf);
  }
  return buf;
}

function serveStatic(req, res) {
  if (!STATIC_DIR || !fs.existsSync(STATIC_DIR)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Static site not built (npm run build).');
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // A NUL byte makes fs throw synchronously (which used to crash the process).
  if (pathname.includes('\0')) {
    res.writeHead(400).end();
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(STATIC_DIR, '.' + pathname);
  if (!file.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    try {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const cache = ext === '.html' ? 'no-cache' : HASHED.test(pathname) ? 'public, max-age=31536000, immutable' : 'public, max-age=86400';
      const encoding = encodingFor(req, ext);
      const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': cache };
      if (COMPRESSIBLE.has(ext)) headers.Vary = 'Accept-Encoding';
      if (encoding) {
        const body = compressed(file, stat, encoding);
        res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      console.error('[server] static file failed', error);
      if (!res.headersSent) res.writeHead(500).end();
      else res.destroy();
    }
  });
}

const server = http.createServer((req, res) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  try {
    handleRequest(req, res);
  } catch (error) {
    // Never let one bad request take the whole relay down.
    console.error('[server] request failed', req.method, req.url, error);
    if (!res.headersSent) res.writeHead(500).end();
    else res.destroy();
  }
});

function handleRequest(req, res) {
  if (adminApi(req, res)) return;
  if (feedback.handle(req, res)) return;
  if (req.url === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ ok: true, ...realm.stats() }));
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  serveStatic(req, res);
}

server.on('upgrade', (req, socket, head) => {
  if (!realm.handleUpgrade(req, socket, head)) socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST ?? 'localhost'}:${PORT}  (static: ${STATIC_DIR ?? 'off'})`);
});

// Last line of defence: log and keep serving instead of exiting on a stray error.
process.on('uncaughtException', (error) => console.error('[server] uncaught exception', error));
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection', reason));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    realm.close();
    feedback.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
