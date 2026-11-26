// Product feedback ("Góp ý"), sent from the game's feedback panel
// (src/components/feedback.ts) and managed in the admin panel (Góp ý page).
//
//   POST /api/feedback  { text }     (optional `Authorization: Bearer <Firebase ID token>`)
//     201 { ok: true, id }
//     400 { error: 'too_short' | 'too_long' | 'bad_request' }
//     429 { error: 'already' }       this account / this IP already sent one today
//     503 { error: 'busy' }          the daily cap for everyone is reached
//
// Anti-spam: one feedback per calendar day (`timeZone`, Vietnam by default)
// per account when signed in, per IP for guests; at most MAX_PER_IP_PER_DAY
// from one IP whatever the account, and MAX_PER_DAY for everyone. The day's
// counters are saved with the feedback, so a restart does not reset them.
// IPs are only kept hashed (salted per day) for the counters.
//
// Everything lives in one JSON file in DATA_DIR (feedback.json), saved shortly
// after every change (temp file + rename), like wallets.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTokenVerifier } from './firebase-auth.mjs';

export const FEEDBACK_MIN_CHARS = 5;
export const FEEDBACK_MAX_CHARS = 1000;
export const FEEDBACK_STATUSES = ['new', 'read', 'done'];
const MAX_PER_IP_PER_DAY = 5;
const MAX_PER_DAY = 1000;
/** Oldest feedback is dropped past this many. */
const MAX_KEPT = 5000;
const MAX_BODY = 16 * 1024;
const SAVE_DELAY_MS = 1_000;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '600',
};

/**
 * @typedef {object} Feedback
 * @property {string} id
 * @property {string} text
 * @property {number} at        ms since epoch
 * @property {string} day       YYYY-MM-DD (feedback calendar)
 * @property {string} uid       Firebase uid ('' = guest)
 * @property {string} ua        browser user agent (trimmed)
 * @property {'new' | 'read' | 'done'} status
 * @property {string} note      admin's private note
 * @property {number} [updatedAt]
 * @property {string} [updatedBy]
 */

/** Same cleaning as chat: no control / bidi characters, collapsed blank lines. */
export function cleanFeedback(raw) {
  return String(raw)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {object} options
 * @param {string} options.dataDir
 * @param {string} options.projectId   Firebase project id ('' = every sender counts as a guest)
 * @param {string} [options.timeZone]
 * @param {(msg: string) => void} [options.log]
 */
export function createFeedback({ dataDir, projectId, timeZone = 'Asia/Ho_Chi_Minh', log = (msg) => console.log(`[feedback] ${msg}`) }) {
  const file = path.join(dataDir, 'feedback.json');
  const verify = projectId ? createTokenVerifier(projectId) : null;
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = (now) => dayFormat.format(now); // YYYY-MM-DD

  /** @type {Feedback[]} newest last */
  let items = [];
  /** Today's counters: key ("u:<uid>" | "ip:<hash>") → count. */
  let limits = { day: '', salt: '', keys: /** @type {Record<string, number>} */ ({}), total: 0 };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    items = Array.isArray(data.items) ? data.items : [];
    if (data.limits && typeof data.limits === 'object') limits = { ...limits, ...data.limits };
    log(`loaded ${items.length} feedback from ${file}`);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') log(`could not read ${file}: ${err}`);
  }

  /** @type {NodeJS.Timeout | null} */
  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(flush, SAVE_DELAY_MS);
  }
  function flush() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, items, limits }));
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`could not save ${file}: ${err}`);
    }
  }

  /** Counters of the current day (reset, with a new IP salt, when the day changed). */
  function today(now) {
    const day = dayOf(now);
    if (limits.day !== day) limits = { day, salt: crypto.randomBytes(16).toString('hex'), keys: {}, total: 0 };
    return limits;
  }
  const ipKey = (ip, salt) => `ip:${crypto.createHash('sha256').update(`${salt}|${ip}`).digest('base64url').slice(0, 22)}`;

  /**
   * Record a feedback if the limits allow it.
   * @returns {{ ok: true, id: string } | { ok: false, error: string, status: number }}
   */
  function submit({ text, uid = '', ip = 'unknown', ua = '' }, now = Date.now()) {
    const clean = cleanFeedback(text ?? '');
    if ([...clean].length < FEEDBACK_MIN_CHARS) return { ok: false, error: 'too_short', status: 400 };
    if ([...clean].length > FEEDBACK_MAX_CHARS) return { ok: false, error: 'too_long', status: 400 };

    const day = today(now);
    const userKey = uid ? `u:${uid}` : '';
    const addrKey = ipKey(ip, day.salt);
    // Signed in: one per account (and a few per IP, shared networks). Guest: one per IP.
    if (userKey ? (day.keys[userKey] ?? 0) >= 1 : (day.keys[`g:${addrKey}`] ?? 0) >= 1) {
      return { ok: false, error: 'already', status: 429 };
    }
    if ((day.keys[addrKey] ?? 0) >= MAX_PER_IP_PER_DAY) return { ok: false, error: 'already', status: 429 };
    if (day.total >= MAX_PER_DAY) return { ok: false, error: 'busy', status: 503 };

    day.keys[addrKey] = (day.keys[addrKey] ?? 0) + 1;
    if (userKey) day.keys[userKey] = 1;
    else day.keys[`g:${addrKey}`] = 1;
    day.total++;

    const item = {
      id: `${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      text: clean,
      at: now,
      day: day.day,
      uid,
      ua: String(ua).slice(0, 200),
      status: /** @type {const} */ ('new'),
      note: '',
    };
    items.push(item);
    if (items.length > MAX_KEPT) items.splice(0, items.length - MAX_KEPT);
    save();
    return { ok: true, id: item.id };
  }

  /** Newest first. */
  const list = () => [...items].reverse();

  /** @param {{ status?: string, note?: string }} patch */
  function update(id, patch, by) {
    const item = items.find((f) => f.id === id);
    if (!item) return null;
    if (patch.status !== undefined) item.status = /** @type {Feedback['status']} */ (patch.status);
    if (patch.note !== undefined) item.note = patch.note;
    item.updatedAt = Date.now();
    item.updatedBy = by;
    save();
    return item;
  }

  function remove(id) {
    const i = items.findIndex((f) => f.id === id);
    if (i < 0) return false;
    items.splice(i, 1);
    save();
    return true;
  }

  // --- HTTP: POST /api/feedback -------------------------------------------------

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

  function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return forwarded || req.socket.remoteAddress || 'unknown';
  }

  async function route(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS).end();
      return;
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method' });
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string') return send(res, 400, { error: 'bad_request' });

    let uid = '';
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (match && verify) {
      try {
        ({ uid } = await verify(match[1]));
      } catch {
        return send(res, 401, { error: 'unauthenticated' });
      }
    }
    const result = submit({ text: body.text, uid, ip: clientIp(req), ua: req.headers['user-agent'] ?? '' });
    if (!result.ok) return send(res, result.status, { error: result.error });
    log(`new feedback ${result.id} from ${uid || 'guest'}`);
    send(res, 201, { ok: true, id: result.id });
  }

  /** true when the request was for /api/feedback (and has been answered). */
  function handle(req, res) {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== '/api/feedback') return false;
    route(req, res).catch((err) => {
      log(`${req.method} ${pathname} failed: ${err instanceof Error ? err.message : err}`);
      if (!res.headersSent) send(res, err instanceof Error && /body|JSON/.test(err.message) ? 400 : 500, { error: 'internal' });
    });
    return true;
  }

  return { handle, submit, list, update, remove, flush };
}
