import { defineConfig, loadEnv, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRealm } from './server/realm.mjs';
import { createAdminApi } from './server/admin-api.mjs';
import { createFeedback } from './server/feedback.mjs';
import { createClientIp } from './server/client-ip.mjs';

/**
 * Runs the multiplayer relay (server/realm.mjs) inside `vite dev` and
 * `vite preview`: WebSocket at /mp, online counts at /health and the admin API
 * at /admin/api/*, product feedback at /api/feedback, on the same port as the page, so no second process is needed during development.
 */
function multiplayerRelay(firebaseProjectId: string): Plugin {
  let realm: ReturnType<typeof createRealm> | null = null;
  let adminApi: ReturnType<typeof createAdminApi> | null = null;
  let feedback: ReturnType<typeof createFeedback> | null = null;
  const admin = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!adminApi?.(req, res) && !feedback?.handle(req, res)) next();
  };
  const health = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url !== '/health' || !realm) return next();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(JSON.stringify({ ok: true, ...realm.stats() }));
  };
  const attach = (httpServer: import('node:http').Server | null) => {
    realm?.close();
    feedback?.flush();
    // No proxy in development: the socket address is the client (same as TRUST_PROXY=0).
    const clientIp = createClientIp({ trustProxy: 0 });
    realm = createRealm({ firebaseProjectId, clientIp });
    feedback = createFeedback({ clientIp, dataDir: fileURLToPath(new URL('./server/data', import.meta.url)), projectId: firebaseProjectId });
    adminApi = createAdminApi({ realm, feedback, projectId: firebaseProjectId });
    httpServer?.on('upgrade', (req, socket, head) => realm?.handleUpgrade(req, socket, head));
    httpServer?.on('close', () => {
      realm?.close();
      feedback?.flush();
    });
  };
  return {
    name: 'dongque-multiplayer',
    configureServer(server) {
      attach(server.httpServer as import('node:http').Server | null);
      server.middlewares.use(health);
      server.middlewares.use(admin);
    },
    configurePreviewServer(server) {
      attach(server.httpServer as import('node:http').Server);
      server.middlewares.use(health);
      server.middlewares.use(admin);
    },
  };
}

export default defineConfig(({ mode }) => ({
  // Same project as the client: the relay verifies Google sign-in tokens for name changes.
  plugins: [multiplayerRelay(loadEnv(mode, process.cwd(), 'VITE_').VITE_FIREBASE_PROJECT_ID ?? '')],
  publicDir: 'public',
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      // Two pages: the game and the config admin panel.
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        admin: fileURLToPath(new URL('./admin.html', import.meta.url)),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  preview: {
    host: true,
    port: 4173,
  },
}));
