// Admin HTTP API for the admin panel (src/admin/), served next to the relay:
//
//   GET  /admin/api/players            everyone connected (id, room, name, uid, …)
//   POST /admin/api/kick  {id?, uid?}  disconnect a player / every session of an account
//   POST /admin/api/ban   {uid, banned} remember a ban decision (and disconnect when banning)
//   GET  /admin/api/feedback                     product feedback, newest first (server/feedback.mjs)
//   POST /admin/api/feedback/update {id, status?, note?}  mark new / read / done, private note
//   POST /admin/api/feedback/delete {id}
//
// Callers send `Authorization: Bearer <Firebase ID token>`. The token is
// verified locally (firebase-auth.mjs); admin rights are then checked by
// reading `admins/{uid}` through the Firestore REST API *with that same
// token*: the rules let a signed-in user read their own entry, so a 200 means
// "is an admin" and no service account is needed.

import { createTokenVerifier } from './firebase-auth.mjs';
import { FEEDBACK_STATUSES } from './feedback.mjs';

const ADMIN_CACHE_MS = 60_000;
const MAX_BODY = 4096;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

/**
 * @param {object} options
 * @param {{ listPlayers: () => object[], kick: (t: { id?: number, uid?: string }) => number, setBanned: (uid: string, banned: boolean) => number }} options.realm
 * @param {{ list: () => object[], update: (id: string, patch: { status?: string, note?: string }, by: string) => object | null, remove: (id: string) => boolean }} [options.feedback]
 * @param {string} options.projectId  Firebase project id ('' = API answers 503).
 * @param {string} [options.prefix]
 * @param {(msg: string) => void} [options.log]
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean}
 *   true when the request was for the admin API (and has been answered).
 */
export function createAdminApi({ realm, feedback, projectId, prefix = '/admin/api', log = (msg) => console.log(`[admin] ${msg}`) }) {
  const verify = projectId ? createTokenVerifier(projectId) : null;
  /** uid → { ok, at } */
  const adminCache = new Map();

  async function isAdmin(uid, token) {
    const hit = adminCache.get(uid);
    if (hit && Date.now() - hit.at < ADMIN_CACHE_MS) return hit.ok;
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/admins/${encodeURIComponent(uid)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok && res.status !== 404 && res.status !== 403) throw new Error(`Firestore HTTP ${res.status}`);
    const ok = res.ok;
    adminCache.set(uid, { ok, at: Date.now() });
    return ok;
  }

  function send(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS });
    res.end(JSON.stringify(body));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new Error('invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  async function route(req, res, path) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (!verify) return send(res, 503, { error: 'login_unavailable' });

    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!match) return send(res, 401, { error: 'unauthenticated' });
    let uid;
    try {
      ({ uid } = await verify(match[1]));
    } catch {
      return send(res, 401, { error: 'unauthenticated' });
    }
    if (!(await isAdmin(uid, match[1]))) return send(res, 403, { error: 'forbidden' });

    if (req.method === 'GET' && path === '/players') {
      return send(res, 200, { players: realm.listPlayers() });
    }
    if (req.method === 'POST' && path === '/kick') {
      const body = await readJson(req);
      const id = Number.isInteger(body.id) && body.id > 0 ? body.id : undefined;
      const target = typeof body.uid === 'string' && body.uid ? body.uid : undefined;
      if (!id && !target) return send(res, 400, { error: 'bad_request' });
      const kicked = realm.kick({ id, uid: target });
      log(`${uid} kicked ${id ? `#${id}` : target} (${kicked})`);
      return send(res, 200, { kicked });
    }
    if (req.method === 'POST' && path === '/ban') {
      const body = await readJson(req);
      if (typeof body.uid !== 'string' || !body.uid || body.uid.length > 128 || typeof body.banned !== 'boolean') {
        return send(res, 400, { error: 'bad_request' });
      }
      const kicked = realm.setBanned(body.uid, body.banned);
      log(`${uid} ${body.banned ? 'banned' : 'unbanned'} ${body.uid} (${kicked} disconnected)`);
      return send(res, 200, { kicked });
    }
    if (feedback && req.method === 'GET' && path === '/feedback') {
      return send(res, 200, { items: feedback.list() });
    }
    if (feedback && req.method === 'POST' && path === '/feedback/update') {
      const body = await readJson(req);
      const patch = {};
      if (body.status !== undefined) {
        if (!FEEDBACK_STATUSES.includes(body.status)) return send(res, 400, { error: 'bad_request' });
        patch.status = body.status;
      }
      if (body.note !== undefined) {
        if (typeof body.note !== 'string' || body.note.length > 500) return send(res, 400, { error: 'bad_request' });
        patch.note = body.note.trim();
      }
      if (typeof body.id !== 'string' || !Object.keys(patch).length) return send(res, 400, { error: 'bad_request' });
      const item = feedback.update(body.id, patch, uid);
      return item ? send(res, 200, { item }) : send(res, 404, { error: 'not_found' });
    }
    if (feedback && req.method === 'POST' && path === '/feedback/delete') {
      const body = await readJson(req);
      if (typeof body.id !== 'string') return send(res, 400, { error: 'bad_request' });
      if (!feedback.remove(body.id)) return send(res, 404, { error: 'not_found' });
      log(`${uid} deleted feedback ${body.id}`);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: 'not_found' });
  }

  return function handle(req, res) {
    const pathname = (req.url ?? '/').split('?')[0];
    if (!pathname.startsWith(`${prefix}/`)) return false;
    route(req, res, pathname.slice(prefix.length)).catch((err) => {
      log(`${req.method} ${pathname} failed: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) send(res, err instanceof Error && /body|JSON/.test(err.message) ? 400 : 500, { error: 'internal' });
    });
    return true;
  };
}
