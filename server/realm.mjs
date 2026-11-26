// SummerTime multiplayer relay: WebSocket rooms that fan out character state.
//
// Wire protocol (binary, little-endian):
//   client → server   26-byte state frame (see src/engine/multiplayer/codec.ts)
//   server → client   [u8 type] ...
//     1 WELCOME  [u32 yourId]
//     2 STATES   [u16 count] count × ([u32 id][26-byte state])
//     3 LEAVE    [u32 id]
//     4 OUTFIT   [u32 id][u8 n][n bytes]
//     5 NAME     [u32 id][u8 n][n bytes UTF-8]   display name (account-verified; n = 0: guest again)
//     6 CHAT     [u32 id][UTF-8 text]            room-wide chat, echoed to the sender
//     7 NOTICE   [u8 code]                       see NOTICE_* below
//     8 WALLET   [UTF-8 JSON]                    flowers + daily rewards (null = signed out), see wallets.mjs
//   close codes: 4001 kicked by an admin · 4003 account banned (clients do not reconnect)
//   client → server   [2] OUTFIT · [3] PROFILE [u16 n][Firebase ID token][u8 m][name] (n = m = 0: sign out)
//                     · [4] CHAT [UTF-8 text] · [5] REWARD [u8 action] (0 status, 1 check-in, 2-4 online tier 0-2)
//                     · [6] VISIBLE [u8 0|1] (game tab shown / hidden: online rewards only count while shown)
//                     · [7] SHOP [UTF-8 JSON {"buy": itemId, "price": n}] (price = what the buyer saw)
//   OUTFIT is checked against the shop (server/shop.mjs): items the account does
//   not own are shown as the slot default, and the sender gets the corrected
//   outfit back ([4] with its own id). Signed-in accounts keep their outfit in
//   the wallet; signing in loads it. Emote states of unowned picnic items
//   (fishing rod, guitar, kite, ice cream) are relayed as standing.
//   A PROFILE with a token and no name (m = 0) only signs in (rewards), keeping the guest name.
//
// Clients send whenever their state changes (plus a slow heartbeat); the
// server keeps the latest frame per player and broadcasts the changed ones
// once per tick, so fan-out is bounded by the tick rate, not by client rates.

import { WebSocketServer } from 'ws';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTokenVerifier } from './firebase-auth.mjs';
import { createWallets } from './wallets.mjs';
import { createPriceBook, loadCatalog } from './shop.mjs';

export const STATE_BYTES = 26;
export const STATE_VERSION = 1;
const MSG_WELCOME = 1;
const MSG_STATES = 2;
const MSG_LEAVE = 3;
const MSG_OUTFIT = 4; // server → client: [4][u32 id][u8 n][n bytes]
const MSG_NAME = 5;
const MSG_CHAT = 6;
const MSG_NOTICE = 7;
const MSG_WALLET = 8;
const CLIENT_OUTFIT = 2; // client → server: [2][u8 n][n bytes], item index per slot
const CLIENT_PROFILE = 3;
const CLIENT_CHAT = 4;
const CLIENT_REWARD = 5;
const CLIENT_VISIBLE = 6;
const CLIENT_SHOP = 7;
const REWARD_STATUS = 0;
const REWARD_CHECKIN = 1;
const REWARD_ONLINE = 2; // 2, 3, 4 = online tier 0, 1, 2
/** How often online time is credited (and players told a tier is ready). */
const ACCRUE_MS = 10_000;
export const NOTICE_AUTH_FAILED = 1;
export const NOTICE_BAD_NAME = 2;
export const NOTICE_LOGIN_UNAVAILABLE = 3;
export const NOTICE_CHAT_TOO_FAST = 4;
export const NOTICE_BANNED = 5;
export const CLOSE_KICKED = 4001;
export const CLOSE_BANNED = 4003;
/** How long a Firestore ban lookup is trusted before asking again. */
const BAN_CACHE_MS = 30_000;
const NAME_MIN_CHARS = 2;
const NAME_MAX_CHARS = 20;
const CHAT_MAX_CHARS = 160;
/** Chat budget: a burst of CHAT_BURST messages, refilled one per CHAT_REFILL_MS. */
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 2_000;
/** Minimum delay between two profile (name) changes. */
const PROFILE_COOLDOWN_MS = 3_000;
/** Large enough for a Firebase ID token (~1 KB) plus a name, or a chat line. */
const MAX_PAYLOAD = 4096;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_OUTFIT_SLOTS = 16;
const MAX_OUTFIT_ITEM = 63;
const ENTRY_BYTES = 4 + STATE_BYTES;
const ROOM_NAME = /^[a-z0-9_-]{1,32}$/i;
/** Positions/angles outside this range are rejected as garbage. */
const MAX_ABS_COORD = 10_000;
/** Highest animation state: 0 ground, 1 airborne, 2 bored, 3 wave, 4 clap, 5 dance,
 *  6 sit cross-legged, 7 fishing, 8 lying prone, 9 sunbathing, 10 guitar,
 *  11 kite, 12 ice cream, 13 high five, 14 walking a dog, 15 walking a cat
 *  (see src/scene/emotes.ts; 15 fills the 4-bit field). */
const MAX_ANIM_STATE = 15;

/**
 * @typedef {object} RealmOptions
 * @property {string} [path]              URL path that accepts WebSocket upgrades.
 * @property {number} [maxPlayersPerRoom] The game renders at most 128 characters (incl. local).
 * @property {number} [tickMs]            Broadcast interval.
 * @property {number} [maxMsgsPerSec]     Per-client frame budget; extra frames are dropped.
 * @property {number} [viewDistance]      Only relay players closer than this (0 = everyone).
 * @property {string[]} [allowedOrigins]  Browser origins allowed to connect (empty = any).
 * @property {string} [firebaseProjectId] Enables account names (email/password ID tokens of this project).
 * @property {string} [dataDir]           Where wallets.json lives (default server/data).
 * @property {string} [timeZone]          Calendar of the daily rewards (default Asia/Ho_Chi_Minh).
 * @property {(msg: string) => void} [log]
 */

/** @param {RealmOptions} [options] */
export function createRealm(options = {}) {
  const {
    path = '/mp',
    maxPlayersPerRoom = 127,
    tickMs = 50,
    maxMsgsPerSec = 40,
    viewDistance = 0,
    allowedOrigins = [],
    firebaseProjectId = '',
    dataDir = nodePath.join(nodePath.dirname(fileURLToPath(import.meta.url)), 'data'),
    timeZone = 'Asia/Ho_Chi_Minh',
    log = (msg) => console.log(`[realm] ${msg}`),
  } = options;
  const wallets = createWallets({ file: nodePath.join(dataDir, 'wallets.json'), timeZone });
  const catalog = loadCatalog();
  const prices = createPriceBook({ projectId: firebaseProjectId, ids: catalog.forSale.map((it) => it.id) });
  prices.warm();

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  const verifyToken = firebaseProjectId ? createTokenVerifier(firebaseProjectId) : null;
  /** @type {Map<string, { players: Set<Player>, dirty: Set<Player> }>} */
  const rooms = new Map();
  let nextId = 1;
  /** Bans set from the admin API (authoritative until restart). */
  const forcedBans = new Map();
  /** uid → { banned, at } from Firestore `users/{uid}.banned`. */
  const banCache = new Map();

  /**
   * Whether the account is banned. Reads `users/{uid}` through the Firestore
   * REST API with the player's own ID token (rules let a user read their own
   * profile), so the relay needs no service account. Fails open on errors:
   * the game client also refuses to sign in a banned account.
   */
  async function isBanned(uid, token) {
    if (forcedBans.has(uid)) return forcedBans.get(uid);
    const hit = banCache.get(uid);
    if (hit && Date.now() - hit.at < BAN_CACHE_MS) return hit.banned;
    let banned = false;
    try {
      const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/users/${encodeURIComponent(uid)}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const doc = await res.json();
        banned = doc?.fields?.banned?.booleanValue === true;
      } else if (res.status !== 404) {
        log(`ban check for ${uid}: HTTP ${res.status}`);
      }
    } catch (err) {
      log(`ban check for ${uid} failed: ${err instanceof Error ? err.message : err}`);
    }
    banCache.set(uid, { banned, at: Date.now() });
    return banned;
  }

  /**
   * @typedef {object} Player
   * @property {number} id
   * @property {import('ws').WebSocket} ws
   * @property {string} room
   * @property {Uint8Array | null} state  latest valid frame
   * @property {Buffer | null} outfit  latest OUTFIT broadcast for this player
   * @property {Uint8Array | null} wanted  outfit the client asked for (before the ownership check)
   * @property {boolean} shopPending  a purchase is being checked
 * @property {Buffer | null} name  latest NAME broadcast for this player (null = guest)
 * @property {string} uid  Firebase uid once signed in (email/password)
 * @property {boolean} visible  game tab shown (client-reported)
 * @property {string} nameText  accepted display name ('' = guest)
 * @property {number} connectedAt
 * @property {boolean} profilePending
 * @property {number} profileAt  time of the last accepted profile change
 * @property {number} chatTokens
 * @property {number} chatRefillAt
   * @property {number} x
   * @property {number} z
   * @property {number} windowStart
   * @property {number} windowCount
   * @property {boolean} alive
   */

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { players: new Set(), dirty: new Set() };
      rooms.set(name, room);
    }
    return room;
  }

  /** Validate a client frame; returns false for anything malformed. */
  function isValidState(buf) {
    if (buf.length !== STATE_BYTES || buf[0] !== STATE_VERSION) return false;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (const offset of [1, 5, 9, 13, 17, 22]) {
      const v = view.getFloat32(offset, true);
      if (!Number.isFinite(v) || Math.abs(v) > MAX_ABS_COORD) return false;
    }
    return (buf[21] & 0x0f) <= MAX_ANIM_STATE; // bits 0-3 a (0 ground, 1 air, 2 bored, 3+ emotes), 4-6 look, 7 sprint
  }

  function entriesBuffer(players) {
    const out = Buffer.allocUnsafe(3 + players.length * ENTRY_BYTES);
    out.writeUInt8(MSG_STATES, 0);
    out.writeUInt16LE(players.length, 1);
    players.forEach((p, i) => {
      const at = 3 + i * ENTRY_BYTES;
      out.writeUInt32LE(p.id, at);
      out.set(p.state, at + 4);
    });
    return out;
  }

  function send(ws, data) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }

  function notice(player, code) {
    send(player.ws, Buffer.from([MSG_NOTICE, code]));
  }

  /** [type][u32 id][prefix?][utf8 text] */
  function idMessage(type, id, text, withLength) {
    const bytes = Buffer.from(text, 'utf8');
    const head = withLength ? 6 : 5;
    const msg = Buffer.alloc(head + bytes.length);
    msg.writeUInt8(type, 0);
    msg.writeUInt32LE(id, 1);
    if (withLength) msg.writeUInt8(bytes.length, 5);
    bytes.copy(msg, head);
    return msg;
  }

  function broadcast(room, data) {
    for (const p of room.players) send(p.ws, data);
  }

  function sendWallet(player, result) {
    const body = player.uid ? { ...wallets.status(player.uid), result } : null;
    send(player.ws, Buffer.concat([Buffer.from([MSG_WALLET]), Buffer.from(JSON.stringify(body), 'utf8')]));
  }

  function sessionsOf(uid) {
    const out = [];
    for (const room of rooms.values()) for (const p of room.players) if (p.uid === uid) out.push(p);
    return out;
  }

  /** Online time counts while an account has at least one visible game tab. */
  function refreshOnline(uid) {
    if (!uid) return;
    if (sessionsOf(uid).some((p) => p.visible)) wallets.online(uid);
    else wallets.offline(uid);
  }

  /** Sign a session in / out. */
  function setUid(player, uid) {
    const old = player.uid;
    if (old === uid) return;
    player.uid = uid;
    refreshOnline(old);
    refreshOnline(uid);
    // Outfit: signing in puts on the account's saved outfit (or saves the
    // current one the first time); signing out takes off bought items.
    const saved = uid ? wallets.getOutfit(uid) : null;
    if (saved) {
      player.wanted = catalog.outfitBytes(saved);
      applyOutfit(player, { echo: true });
    } else {
      applyOutfit(player, { save: !!uid });
    }
  }

  /**
   * Show `player.wanted` to the room, minus the items the account cannot wear.
   * The player gets the result back when it differs from what it asked for
   * (or always with `echo`); `save` stores it as the account's outfit.
   */
  function applyOutfit(player, { save = false, echo = false } = {}) {
    const room = rooms.get(player.room);
    if (!player.wanted || !room?.players.has(player)) return;
    const wanted = player.wanted;
    const shown = catalog.filterOutfit(wanted, (id) => wallets.owns(player.uid, id));
    const msg = Buffer.alloc(6 + shown.length);
    msg.writeUInt8(MSG_OUTFIT, 0);
    msg.writeUInt32LE(player.id, 1);
    msg.writeUInt8(shown.length, 5);
    msg.set(shown, 6);
    const changed = !player.outfit || !player.outfit.equals(msg);
    player.outfit = msg;
    if (changed) for (const p of room.players) if (p !== player) send(p.ws, msg);
    if (echo || shown.some((v, s) => v !== (wanted[s] ?? 0))) send(player.ws, msg);
    if (save && player.uid) wallets.setOutfit(player.uid, catalog.outfitIds(shown));
  }

  /** Buy a shop item: [7][{"buy": id, "price": n}] → WALLET with a `shop` result. */
  async function onShop(player, buf) {
    let request;
    try {
      request = JSON.parse(buf.subarray(1).toString('utf8'));
    } catch {
      return;
    }
    const id = typeof request?.buy === 'string' ? request.buy.slice(0, 64) : '';
    const seen = Number.isInteger(request?.price) ? request.price : -1;
    const uid = player.uid;
    const reply = (result) => {
      for (const p of uid ? sessionsOf(uid) : [player]) sendWallet(p, p === player ? { shop: true, item: id, ...result } : undefined);
    };
    if (!uid) return reply({ ok: false, error: 'login' });
    const item = catalog.items.get(id);
    if (!item || item.free || !item.category) return reply({ ok: false, error: 'item' });
    if (wallets.owns(uid, id)) return reply({ ok: false, error: 'owned' });
    if (player.shopPending) return;
    player.shopPending = true;
    let offer;
    try {
      offer = await prices.get(id);
      // The buyer saw another price: maybe the admin just changed it, check again.
      if (offer && offer.price !== seen) offer = await prices.get(id, true);
    } finally {
      player.shopPending = false;
    }
    if (player.uid !== uid) return; // signed out meanwhile
    if (!offer || !offer.enabled) return reply({ ok: false, error: 'disabled' });
    if (offer.price !== seen) return reply({ ok: false, error: 'price', price: offer.price });
    const result = wallets.buy(uid, id, offer.price);
    if (result.ok) log(`${uid} bought ${id} for ${offer.price}`);
    reply(result);
  }

  function onReward(player, buf) {
    if (buf.length !== 2) return;
    const action = buf[1];
    if (!player.uid) return sendWallet(player, { action, ok: false, error: 'login' });
    if (action === REWARD_STATUS) return sendWallet(player);
    let result;
    if (action === REWARD_CHECKIN) result = wallets.checkIn(player.uid);
    else if (action >= REWARD_ONLINE && action < REWARD_ONLINE + 3) result = wallets.claimOnline(player.uid, action - REWARD_ONLINE);
    else return;
    // Every session of the account sees the new balance; the result goes to the asker.
    for (const p of sessionsOf(player.uid)) sendWallet(p, p === player ? { action, ...result } : undefined);
  }

  async function onProfile(player, room, buf) {
    if (buf.length < 4) return;
    const tokenLen = buf.readUInt16LE(1);
    if (buf.length < 4 + tokenLen) return;
    const token = buf.subarray(3, 3 + tokenLen).toString('ascii');
    const nameLen = buf[3 + tokenLen];
    if (buf.length !== 4 + tokenLen + nameLen) return;
    if (tokenLen === 0 && nameLen === 0) {
      // Signed out: back to a guest name (an empty NAME tells clients so).
      if (player.name) broadcast(room, idMessage(MSG_NAME, player.id, '', true));
      player.name = null;
      player.nameText = '';
      setUid(player, '');
      sendWallet(player);
      return;
    }
    if (!verifyToken) return notice(player, NOTICE_LOGIN_UNAVAILABLE);
    const wantsName = nameLen > 0;
    if (player.profilePending || (wantsName && Date.now() - player.profileAt < PROFILE_COOLDOWN_MS)) return;
    const name = cleanText(buf.subarray(4 + tokenLen), NAME_MAX_CHARS);
    if (wantsName && !isValidName(name)) return notice(player, NOTICE_BAD_NAME);
    player.profilePending = true;
    let banned = false;
    try {
      const { uid, provider } = await verifyToken(token);
      if (provider !== 'password') throw new Error(`provider ${provider}`);
      banned = await isBanned(uid, token);
      if (!banned && room.players.has(player)) setUid(player, uid);
    } catch (err) {
      log(`#${player.id} profile rejected: ${err instanceof Error ? err.message : err}`);
      notice(player, NOTICE_AUTH_FAILED);
      return;
    } finally {
      player.profilePending = false;
    }
    if (banned) return notice(player, NOTICE_BANNED);
    if (!room.players.has(player)) return; // left while we were verifying
    sendWallet(player);
    if (!wantsName) return;
    player.profileAt = Date.now();
    player.nameText = name;
    player.name = idMessage(MSG_NAME, player.id, name, true);
    broadcast(room, player.name);
  }

  function onChat(player, room, buf) {
    const now = Date.now();
    const refills = Math.floor((now - player.chatRefillAt) / CHAT_REFILL_MS);
    if (refills > 0) {
      player.chatTokens = Math.min(CHAT_BURST, player.chatTokens + refills);
      player.chatRefillAt += refills * CHAT_REFILL_MS;
    }
    if (player.chatTokens <= 0) return notice(player, NOTICE_CHAT_TOO_FAST);
    const text = cleanText(buf.subarray(1), CHAT_MAX_CHARS);
    if (!text) return;
    player.chatTokens--;
    broadcast(room, idMessage(MSG_CHAT, player.id, text, false));
  }

  function near(a, b) {
    if (!viewDistance) return true;
    const dx = a.x - b.x;
    const dz = a.z - b.z;
    return dx * dx + dz * dz <= viewDistance * viewDistance;
  }

  /** Broadcast changed states of every room. */
  function tick() {
    for (const [name, room] of rooms) {
      if (room.players.size === 0) {
        rooms.delete(name);
        continue;
      }
      if (room.dirty.size === 0) continue;
      const changed = [...room.dirty].filter((p) => p.state);
      room.dirty.clear();
      if (!viewDistance) {
        // Same buffer for everyone; receivers skip their own id.
        const buf = entriesBuffer(changed);
        for (const p of room.players) send(p.ws, buf);
      } else {
        for (const p of room.players) {
          const visible = changed.filter((c) => c !== p && near(c, p));
          if (visible.length) send(p.ws, entriesBuffer(visible));
        }
      }
    }
  }

  function onConnection(ws, req, roomName) {
    const room = getRoom(roomName);
    if (room.players.size >= maxPlayersPerRoom) {
      ws.close(1013, 'room full');
      return;
    }
    /** @type {Player} */
    const player = {
      id: nextId++,
      ws,
      room: roomName,
      state: null,
      outfit: null,
      /** Outfit the client asked for (item index per slot); `outfit` is what others see. */
      wanted: null,
      shopPending: false,
      name: null,
      nameText: '',
      uid: '',
      /** Game tab shown (reported by the client; hidden tabs earn no online time). */
      visible: false,
      connectedAt: Date.now(),
      profilePending: false,
      profileAt: 0,
      chatTokens: CHAT_BURST,
      chatRefillAt: Date.now(),
      x: 0,
      z: 0,
      windowStart: Date.now(),
      windowCount: 0,
      alive: true,
    };
    if (nextId > 0xffffffff) nextId = 1;
    room.players.add(player);

    const welcome = Buffer.alloc(5);
    welcome.writeUInt8(MSG_WELCOME, 0);
    welcome.writeUInt32LE(player.id, 1);
    send(ws, welcome);
    // Bootstrap the newcomer with everyone already here.
    const present = [...room.players].filter((p) => p !== player && p.state && near(p, player));
    if (present.length) send(ws, entriesBuffer(present));
    for (const p of room.players) if (p !== player && p.outfit) send(ws, p.outfit);
    for (const p of room.players) if (p !== player && p.name) send(ws, p.name);

    ws.on('pong', () => {
      player.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - player.windowStart >= 1000) {
        player.windowStart = now;
        player.windowCount = 0;
      }
      player.windowCount++;
      if (player.windowCount > maxMsgsPerSec * 4) {
        ws.close(1008, 'rate limit');
        return;
      }
      if (player.windowCount > maxMsgsPerSec) return;
      const buf = /** @type {Buffer} */ (data);
      if (!isBinary) return;
      if (buf[0] === CLIENT_OUTFIT) {
        // Outfit: validate, remember (for newcomers) and relay to the room.
        const n = buf[1];
        if (buf.length !== 2 + n || n > MAX_OUTFIT_SLOTS) return;
        for (let i = 0; i < n; i++) if (buf[2 + i] > MAX_OUTFIT_ITEM) return;
        player.wanted = Uint8Array.from(buf.subarray(2, 2 + n));
        applyOutfit(player, { save: true });
        return;
      }
      if (buf[0] === CLIENT_PROFILE) {
        void onProfile(player, room, buf);
        return;
      }
      if (buf[0] === CLIENT_CHAT) {
        onChat(player, room, buf);
        return;
      }
      if (buf[0] === CLIENT_REWARD) {
        onReward(player, buf);
        return;
      }
      if (buf[0] === CLIENT_SHOP) {
        void onShop(player, buf).catch((err) => log(`#${player.id} shop failed: ${err instanceof Error ? err.message : err}`));
        return;
      }
      if (buf[0] === CLIENT_VISIBLE) {
        if (buf.length !== 2) return;
        const visible = buf[1] === 1;
        if (visible === player.visible) return;
        player.visible = visible;
        refreshOnline(player.uid);
        if (player.uid) sendWallet(player); // "counting" changed
        return;
      }
      if (!isValidState(buf)) return;
      player.state = Uint8Array.from(buf);
      // Picnic emotes need their item: relay a standing pose otherwise.
      const needs = catalog.emoteItems.get(player.state[21] & 0x0f);
      if (needs && !wallets.owns(player.uid, needs)) player.state[21] &= 0xf0;
      player.x = buf.readFloatLE(1);
      player.z = buf.readFloatLE(9);
      room.dirty.add(player);
    });

    ws.on('close', () => {
      room.players.delete(player);
      room.dirty.delete(player);
      setUid(player, '');
      const leave = Buffer.alloc(5);
      leave.writeUInt8(MSG_LEAVE, 0);
      leave.writeUInt32LE(player.id, 1);
      for (const p of room.players) send(p.ws, leave);
    });

    ws.on('error', () => ws.terminate());
  }

  /**
   * Handle an HTTP upgrade. Returns true when the request was for this realm
   * (so other upgrade handlers, e.g. Vite HMR, can ignore it).
   */
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== path) return false;
    const origin = req.headers.origin;
    if (allowedOrigins.length && (!origin || !allowedOrigins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return true;
    }
    const requested = url.searchParams.get('room') ?? 'main';
    const roomName = ROOM_NAME.test(requested) ? requested : 'main';
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, roomName));
    return true;
  }

  /** Online counts for /health and the admin panel. */
  function stats() {
    const byRoom = {};
    let players = 0;
    for (const [name, room] of rooms) {
      byRoom[name] = room.players.size;
      players += room.players.size;
    }
    return { players, rooms: byRoom };
  }

  // --- Admin (server/admin-api.mjs) ---------------------------------------

  /** Everyone connected, for the admin panel. */
  function listPlayers() {
    const out = [];
    for (const [name, room] of rooms) {
      for (const p of room.players) {
        out.push({
          id: p.id,
          room: name,
          name: p.nameText,
          uid: p.uid,
          connectedAt: p.connectedAt,
          x: Math.round(p.x * 10) / 10,
          z: Math.round(p.z * 10) / 10,
        });
      }
    }
    return out;
  }

  /** Disconnect players by relay id and/or account uid; returns how many. */
  function kick({ id, uid }, code = CLOSE_KICKED, reason = 'kicked') {
    let count = 0;
    for (const room of rooms.values()) {
      for (const p of room.players) {
        if ((id && p.id === id) || (uid && p.uid === uid)) {
          p.ws.close(code, reason);
          count++;
        }
      }
    }
    return count;
  }

  /** Record an admin ban decision; banning also disconnects the account. */
  function setBanned(uid, banned) {
    forcedBans.set(uid, banned);
    banCache.delete(uid);
    return banned ? kick({ uid }, CLOSE_BANNED, 'banned') : 0;
  }

  const tickTimer = setInterval(tick, tickMs);
  // Drop connections that stopped answering pings (closed laptops, dead NATs).
  const pingTimer = setInterval(() => {
    for (const room of rooms.values()) {
      for (const p of room.players) {
        if (!p.alive) {
          p.ws.terminate();
          continue;
        }
        p.alive = false;
        p.ws.ping();
      }
    }
  }, 15_000);

  // Credit online time; tell an account's sessions when a reward tier is reached.
  const accrueTimer = setInterval(() => {
    for (const uid of wallets.onlineUids()) {
      if (wallets.accrue(uid)) for (const p of sessionsOf(uid)) sendWallet(p);
    }
  }, ACCRUE_MS);

  function close() {
    clearInterval(tickTimer);
    clearInterval(pingTimer);
    clearInterval(accrueTimer);
    for (const uid of wallets.onlineUids()) wallets.offline(uid);
    wallets.flush();
    for (const client of wss.clients) client.terminate();
    wss.close();
  }

  log(`ready on ${path} (tick ${tickMs} ms, max ${maxPlayersPerRoom}/room${viewDistance ? `, view ${viewDistance}` : ''}, account names ${verifyToken ? 'on' : 'off'})`);
  return { handleUpgrade, stats, close, listPlayers, kick, setBanned };
}

/**
 * Decode UTF-8 (rejecting invalid bytes), drop control/format characters
 * (bidi overrides, zero-width tricks; ZWJ kept for emoji), collapse
 * whitespace and cut to `maxChars` code points.
 */
function cleanText(bytes, maxChars) {
  let text;
  try {
    text = utf8.decode(bytes);
  } catch {
    return '';
  }
  text = text
    .normalize('NFC')
    .replace(/(?!\u200d)[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, maxChars).join('').trim();
}

function isValidName(name) {
  const chars = [...name].length;
  return chars >= NAME_MIN_CHARS && chars <= NAME_MAX_CHARS && /[\p{L}\p{N}]/u.test(name);
}
