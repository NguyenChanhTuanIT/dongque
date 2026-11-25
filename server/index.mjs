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
//   ALLOWED_ORIGINS       (comma-separated, empty = any)
//   DATA_DIR              (server/data) where wallets.json (flowers, daily rewards) is kept
//   REWARDS_TZ            (Asia/Ho_Chi_Minh) calendar of the daily rewards
//   FIREBASE_PROJECT_ID   (falls back to VITE_FIREBASE_PROJECT_ID; unset = name changes disabled)

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRealm } from './realm.mjs';
import { createAdminApi } from './admin-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const PORT = Number(env.PORT ?? 8787);
const HOST = env.HOST || undefined;
const STATIC_DIR = env.STATIC_DIR === '' ? null : path.resolve(here, env.STATIC_DIR ?? '../dist');

const FIREBASE_PROJECT_ID = env.FIREBASE_PROJECT_ID || env.VITE_FIREBASE_PROJECT_ID || '';
const realm = createRealm({
  dataDir: env.DATA_DIR ? path.resolve(env.DATA_DIR) : undefined,
  timeZone: env.REWARDS_TZ || undefined,
  maxPlayersPerRoom: Number(env.MAX_PLAYERS_PER_ROOM ?? 127),
  tickMs: Number(env.TICK_MS ?? 50),
  viewDistance: Number(env.VIEW_DISTANCE ?? 0),
  allowedOrigins: (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  firebaseProjectId: FIREBASE_PROJECT_ID,
});
const adminApi = createAdminApi({ realm, projectId: FIREBASE_PROJECT_ID });

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
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.resolve(STATIC_DIR, '.' + pathname);
  if (!file.startsWith(STATIC_DIR + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (adminApi(req, res)) return;
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
});

server.on('upgrade', (req, socket, head) => {
  if (!realm.handleUpgrade(req, socket, head)) socket.destroy();
});

server.listen(PORT, HOST, () => {
  console.log(`[server] http://${HOST ?? 'localhost'}:${PORT}  (static: ${STATIC_DIR ?? 'off'})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    realm.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
