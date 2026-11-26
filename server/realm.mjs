// RelaxTime multiplayer relay: WebSocket rooms that fan out character state.
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
//     9 SOCIAL   [u8 kind][u32 fromId][u8 activity]   play-together invitations, see "Together" below
//    10 TIME     [f64 clientMs][f64 serverMs]    answer to a TIME ping (shared clock)
//   close codes: 4001 kicked by an admin · 4003 account banned (clients do not reconnect)
//   client → server   [2] OUTFIT · [3] PROFILE [u16 n][Firebase ID token][u8 m][name] (n = m = 0: sign out)
//                     · [4] CHAT [UTF-8 text] · [5] REWARD [u8 action] (0 status, 1 check-in, 2-4 online tier 0-2)
//                     · [6] VISIBLE [u8 0|1] (game tab shown / hidden: online rewards only count while shown)
//                     · [7] SHOP [UTF-8 JSON {"buy": itemId, "price": n}] (price = what the buyer saw)
//                     · [8] GUEST [ASCII key, 16-64 chars of A-Z a-z 0-9 _ -] (the tab's guest wallet,
//                       sent right after WELCOME; see "Guests" in server/wallets.mjs)
//                     · [9] SOCIAL [u8 kind][u32 targetId][u8 activity] · [10] TIME [f64 clientMs]
//   Together: INVITE (1) goes to a player of the room within SOCIAL_RANGE, at
//   most SOCIAL_BURST in a row (refilled one per SOCIAL_REFILL_MS). ACCEPT (2)
//   only counts for a pending invitation (SOCIAL_INVITE_MS) of that player
//   with that activity; the relay then confirms it to both. DECLINE (3) /
//   END (4) / CANCEL (5) are passed on. Treating someone to an ice cream
//   (activity 2) needs the ice cream item; the treated player may then show
//   the treat pose (TREAT_STATE) for TREAT_MS.
//   Guests play like accounts (check-in, online rewards, shop) with a wallet
//   that lives as long as their tab; signing up moves it into the new account
//   (the WALLET then carries result {"sync": "adopted" | "skipped"}).
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
import { createWallets, GUEST_PREFIX } from './wallets.mjs';
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
const MSG_SOCIAL = 9;
const MSG_TIME = 10;
const CLIENT_OUTFIT = 2; // client → server: [2][u8 n][n bytes], item index per slot
const CLIENT_PROFILE = 3;
const CLIENT_CHAT = 4;
const CLIENT_REWARD = 5;
const CLIENT_VISIBLE = 6;
const CLIENT_SHOP = 7;
const CLIENT_GUEST = 8;
const CLIENT_SOCIAL = 9;
const CLIENT_TIME = 10;
const SOCIAL_INVITE = 1;
const SOCIAL_ACCEPT = 2;
const SOCIAL_DECLINE = 3;
const SOCIAL_END = 4;
const SOCIAL_CANCEL = 5;
/** Activities (src/scene/together.ts): 1 flower, 2 ice cream, 3 hand in hand, 4 dance. */
const ACTIVITY_ICECREAM = 2;
const MAX_ACTIVITY = 4;
const SOCIAL_RANGE = 8;
const SOCIAL_INVITE_MS = 30_000;
const SOCIAL_BURST = 4;
const SOCIAL_REFILL_MS = 3_000;
/** Animation states tied to the ice cream item (src/scene/emotes.ts). */
const OFFER_ICECREAM_STATE = 33;
const TREAT_STATE = 35;
const TREAT_MS = 120_000;
const ICECREAM_ITEM = 'picnic.icecream';
const GUEST_KEY = /^[A-Za-z0-9_-]{16,64}$/;
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
/** The display name is taken by another player online, or reserved (admin, system…). */
export const NOTICE_NAME_TAKEN = 6;
/** Kicked / banned players' IPs are refused for a while (they would come back as guests). */
const KICK_BLOCK_MS = 10 * 60_000;
const BAN_BLOCK_MS = 6 * 60 * 60_000;
/** Online rewards only count while the player did something in this window (anti idle bots). */
const DEFAULT_ACTIVE_MS = 10 * 60_000;
/** Names nobody may take (impersonating staff / the game), compared without accents. */
const RESERVED_NAMES = /admin|quan ?tri|moderator|\bmod\b|he ?thong|system|game ?master|\bgm\b|ban quan ly|support|ho ?tro/;
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
 *  11 kite, 12 ice cream, 13 high five, 14 walking a dog, 15 walking a cat,
 *  16 … 38 countryside emotes, stone benches, play together, 39 … 42 fishing
 *  mini-game stages, 43 catching butterflies, 44 … 64 holding up a caught fish
 *  (one per species) (src/scene/emotes.ts
 *  MAX_NET_STATE). The field has 7 bits (bit 7 = sprinting). */
const MAX_ANIM_STATE = 64;
/** Fishing mini-game stages (bite, fight, landed, snapped) and holding up a catch (44 … 64): they need the fishing rod like state 7. */
const FISH_STATE = 7;
/** Items that can break and be lost (then bought again): the fishing rod. */
const BREAKABLE_ITEMS = new Set(['picnic.fishing']);
const FISH_STAGE_STATES = new Set([39, 40, 41, 42, ...Array.from({ length: 21 }, (_, k) => 44 + k)]);
const ANIM_MASK = 0x7f;

/**
 * @typedef {object} RealmOptions
 * @property {string} [path]              URL path that accepts WebSocket upgrades.
 * @property {number} [maxPlayersPerRoom] The game renders at most 128 characters (incl. local).
 * @property {number} [tickMs]            Broadcast interval.
 * @property {number} [maxMsgsPerSec]     Per-client frame budget; extra frames are dropped.
 * @property {number} [viewDistance]      Only relay players closer than this (0 = everyone).
 * @property {string[]} [allowedOrigins]  Browser origins allowed to connect (empty = any).
 * @property {number} [maxConnections]   All connections together (default 1000).
 * @property {number} [maxPerIp]         Connections from one IP (default 12; behind a proxy, from X-Forwarded-For).
 * @property {number} [maxRooms]         Rooms open at once (default 20; new room names past that are refused).
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
    maxConnections = 1000,
    maxPerIp = 12,
    maxRooms = 20,
    activeMs = DEFAULT_ACTIVE_MS,
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
  // options.verifyToken / options.isBanned: test doubles (production uses Firebase).
  const verifyToken = options.verifyToken ?? (firebaseProjectId ? createTokenVerifier(firebaseProjectId) : null);
  /** @type {Map<string, { players: Set<Player>, dirty: Set<Player> }>} */
  const rooms = new Map();
  let nextId = 1;
  /** Open connections per client IP (see clientIp). */
  const perIp = new Map();
  /** IP → { until, uid } refused after a kick / ban (uid: the banned account, for unbans). */
  const blockedIps = new Map();
  let connections = 0;
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
    return (buf[21] & ANIM_MASK) <= MAX_ANIM_STATE; // bits 0-6 a (0 ground, 1 air, 2 bored, 3+ emotes), 7 sprint
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

  /** Wallet of the session: the account once signed in, else the tab's guest wallet ('' = none yet). */
  function walletIdOf(player) {
    return player.uid || (player.guest ? GUEST_PREFIX + player.guest : '');
  }

  function sendWallet(player, result) {
    const id = walletIdOf(player);
    const body = id ? { ...wallets.status(id), guest: !player.uid, result } : null;
    send(player.ws, Buffer.concat([Buffer.from([MSG_WALLET]), Buffer.from(JSON.stringify(body), 'utf8')]));
  }

  /** Sessions sharing wallet `id` (account uid or guest id). */
  function sessionsOf(id) {
    const out = [];
    for (const room of rooms.values()) for (const p of room.players) if (walletIdOf(p) === id) out.push(p);
    return out;
  }

  /**
   * Online time counts while a wallet has at least one visible game tab whose
   * player did something (moved, changed pose, chatted) in the last activeMs,
   * so an idle bot tab does not farm the online rewards.
   */
  function refreshOnline(uid) {
    if (!uid) return;
    const now = Date.now();
    if (sessionsOf(uid).some((p) => p.visible && now - p.activeAt < activeMs)) wallets.online(uid);
    else wallets.offline(uid);
  }

  /** Something happened on this session: resume its online time if it was paused. */
  function markActive(player) {
    const wasIdle = Date.now() - player.activeAt >= activeMs;
    player.activeAt = Date.now();
    if (wasIdle) refreshOnline(walletIdOf(player));
  }

  /** Accent-free lower case, to compare names ("Quản trị" ~ "quan tri"). */
  const plainName = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();

  /** Whether `name` is reserved or used by another account online. */
  function nameUnavailable(name, uid) {
    const plain = plainName(name);
    if (RESERVED_NAMES.test(plain)) return true;
    for (const room of rooms.values()) {
      for (const p of room.players) if (p.uid !== uid && p.nameText && plainName(p.nameText) === plain) return true;
    }
    return false;
  }

  /**
   * Sign a session in / out. Returns the guest wallet sync result when signing
   * in from a guest wallet with progress ('adopted' / 'skipped', else '').
   */
  function setUid(player, uid) {
    const old = player.uid;
    if (old === uid) return '';
    const oldWallet = walletIdOf(player);
    player.uid = uid;
    refreshOnline(oldWallet);
    // Signing up after playing as a guest: the new account takes the guest wallet.
    const sync = uid && oldWallet.startsWith(GUEST_PREFIX) ? wallets.adopt(uid, oldWallet) : '';
    refreshOnline(walletIdOf(player));
    // Outfit: signing in puts on the account's saved outfit (or saves the
    // current one the first time); signing out takes off bought items.
    const saved = uid ? wallets.getOutfit(uid) : null;
    if (saved) {
      player.wanted = catalog.outfitBytes(saved);
      applyOutfit(player, { echo: true });
    } else {
      applyOutfit(player, { save: !!uid });
    }
    return sync;
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
    const shown = catalog.filterOutfit(wanted, (id) => wallets.owns(walletIdOf(player), id));
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
    const uid = walletIdOf(player); // account or guest wallet
    // {"broke": item}: the player's rod broke (src/scene/fishingGame.ts), it is
    // gone until bought again. Only breakable items; nothing is refunded.
    if (typeof request?.broke === 'string') {
      const lost = request.broke.slice(0, 64);
      if (!uid || !BREAKABLE_ITEMS.has(lost)) return;
      const result = wallets.lose(uid, lost);
      if (!result.ok) return;
      log(`${uid} broke ${lost}`);
      for (const p of sessionsOf(uid)) {
        // Not a shop result (the shop panel would say "bought"): its own key.
        sendWallet(p, p === player ? { broke: lost } : undefined);
      }
      return;
    }
    const id = typeof request?.buy === 'string' ? request.buy.slice(0, 64) : '';
    const seen = Number.isInteger(request?.price) ? request.price : -1;
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
    if (walletIdOf(player) !== uid) return; // signed in / out meanwhile
    if (!offer || !offer.enabled) return reply({ ok: false, error: 'disabled' });
    if (offer.price !== seen) return reply({ ok: false, error: 'price', price: offer.price });
    const result = wallets.buy(uid, id, offer.price);
    if (result.ok) log(`${uid} bought ${id} for ${offer.price}`);
    reply(result);
  }

  function onReward(player, buf) {
    if (buf.length !== 2) return;
    const action = buf[1];
    const id = walletIdOf(player); // account or guest wallet
    if (!id) return sendWallet(player, { action, ok: false, error: 'login' });
    if (action === REWARD_STATUS) return sendWallet(player);
    let result;
    if (action === REWARD_CHECKIN) result = wallets.checkIn(id);
    else if (action >= REWARD_ONLINE && action < REWARD_ONLINE + 3) result = wallets.claimOnline(id, action - REWARD_ONLINE);
    else return;
    // Every session of the wallet sees the new balance; the result goes to the asker.
    for (const p of sessionsOf(id)) sendWallet(p, p === player ? { action, ...result } : undefined);
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
    let sync = '';
    try {
      const { uid, provider } = await verifyToken(token);
      if (provider !== 'password') throw new Error(`provider ${provider}`);
      banned = await (options.isBanned ?? isBanned)(uid, token);
      if (!banned && wantsName && nameUnavailable(name, uid)) {
        notice(player, NOTICE_NAME_TAKEN);
        // Still sign in (rewards, wallet), just without that name.
        if (room.players.has(player)) sync = setUid(player, uid);
        if (room.players.has(player)) sendWallet(player, sync ? { sync } : undefined);
        return;
      }
      if (!banned && room.players.has(player)) sync = setUid(player, uid);
    } catch (err) {
      log(`#${player.id} profile rejected: ${err instanceof Error ? err.message : err}`);
      notice(player, NOTICE_AUTH_FAILED);
      return;
    } finally {
      player.profilePending = false;
    }
    if (banned) {
      notice(player, NOTICE_BANNED);
      return;
    }
    if (!room.players.has(player)) return; // left while we were verifying
    sendWallet(player, sync ? { sync } : undefined);
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
    markActive(player);
    const text = cleanText(buf.subarray(1), CHAT_MAX_CHARS);
    if (!text) return;
    player.chatTokens--;
    broadcast(room, idMessage(MSG_CHAT, player.id, text, false));
  }

  /** [9][kind][u32 id][activity] */
  function socialMessage(kind, id, activity) {
    const msg = Buffer.alloc(7);
    msg.writeUInt8(MSG_SOCIAL, 0);
    msg.writeUInt8(kind, 1);
    msg.writeUInt32LE(id, 2);
    msg.writeUInt8(activity, 6);
    return msg;
  }

  /** Play-together messages: [9][kind][u32 target][activity]. */
  function onSocial(player, room, buf) {
    if (buf.length !== 7) return;
    const kind = buf[1];
    const targetId = buf.readUInt32LE(2);
    const activity = buf[6];
    if (activity < 1 || activity > MAX_ACTIVITY || targetId === player.id) return;
    let target = null;
    for (const p of room.players) if (p.id === targetId) target = p;
    if (!target) return;
    const now = Date.now();
    if (kind === SOCIAL_INVITE) {
      const refills = Math.floor((now - player.socialRefillAt) / SOCIAL_REFILL_MS);
      if (refills > 0) {
        player.socialTokens = Math.min(SOCIAL_BURST, player.socialTokens + refills);
        player.socialRefillAt += refills * SOCIAL_REFILL_MS;
      }
      if (player.socialTokens <= 0) return notice(player, NOTICE_CHAT_TOO_FAST);
      const dx = player.x - target.x;
      const dz = player.z - target.z;
      if (dx * dx + dz * dz > SOCIAL_RANGE * SOCIAL_RANGE) return;
      if (activity === ACTIVITY_ICECREAM && !wallets.owns(walletIdOf(player), ICECREAM_ITEM)) return;
      player.socialTokens--;
      player.invites.set(target.id, { activity, at: now });
      send(target.ws, socialMessage(SOCIAL_INVITE, player.id, activity));
      return;
    }
    if (kind === SOCIAL_ACCEPT) {
      // target = the inviter
      const invite = target.invites.get(player.id);
      if (!invite || invite.activity !== activity || now - invite.at > SOCIAL_INVITE_MS) return;
      target.invites.delete(player.id);
      if (activity === ACTIVITY_ICECREAM) {
        if (!wallets.owns(walletIdOf(target), ICECREAM_ITEM)) return;
        player.treatUntil = now + TREAT_MS;
      }
      send(target.ws, socialMessage(SOCIAL_ACCEPT, player.id, activity));
      send(player.ws, socialMessage(SOCIAL_ACCEPT, target.id, activity));
      return;
    }
    if (kind === SOCIAL_DECLINE) target.invites.delete(player.id);
    else if (kind === SOCIAL_CANCEL) player.invites.delete(target.id);
    else if (kind !== SOCIAL_END) return;
    send(target.ws, socialMessage(kind, player.id, activity));
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

  function onConnection(ws, req, roomName, ip) {
    const room = getRoom(roomName);
    if (room.players.size >= maxPlayersPerRoom) {
      ws.close(1013, 'room full');
      return;
    }
    connections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    // Remembered for kicks / bans (IP block) on this session.
    ws.clientIp = ip;
    ws.once('close', () => {
      connections--;
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n > 0) perIp.set(ip, n);
      else perIp.delete(ip);
    });
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
      /** Guest wallet key of the tab (CLIENT_GUEST), '' until sent. */
      guest: '',
      /** Game tab shown (reported by the client; hidden tabs earn no online time). */
      visible: false,
      /** When `visible` last changed (rate limit). */
      visibleAt: 0,
      /** Last activity (moved, changed pose, chatted): online rewards pause after activeMs without. */
      activeAt: Date.now(),
      connectedAt: Date.now(),
      profilePending: false,
      profileAt: 0,
      chatTokens: CHAT_BURST,
      chatRefillAt: Date.now(),
      socialTokens: SOCIAL_BURST,
      socialRefillAt: Date.now(),
      /** Pending invitations we sent: target id → { activity, at }. */
      invites: new Map(),
      /** Treated to an ice cream until (ms). */
      treatUntil: 0,
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
      if (buf[0] === CLIENT_GUEST) {
        // Once per connection, before signing in matters: the tab's guest wallet.
        const key = buf.subarray(1).toString('latin1');
        if (player.guest || !GUEST_KEY.test(key)) return;
        player.guest = key;
        if (!player.uid) {
          refreshOnline(walletIdOf(player));
          applyOutfit(player, { echo: true }); // items this guest wallet owns
          sendWallet(player);
        }
        return;
      }
      if (buf[0] === CLIENT_SHOP) {
        void onShop(player, buf).catch((err) => log(`#${player.id} shop failed: ${err instanceof Error ? err.message : err}`));
        return;
      }
      if (buf[0] === CLIENT_SOCIAL) {
        onSocial(player, room, buf);
        return;
      }
      if (buf[0] === CLIENT_TIME) {
        if (buf.length !== 9) return;
        const msg = Buffer.alloc(17);
        msg.writeUInt8(MSG_TIME, 0);
        buf.copy(msg, 1, 1, 9);
        msg.writeDoubleLE(Date.now(), 9);
        send(ws, msg);
        return;
      }
      if (buf[0] === CLIENT_VISIBLE) {
        if (buf.length !== 2) return;
        const visible = buf[1] === 1;
        if (visible === player.visible) return;
        // A real tab flips this a few times a minute at most; each flip scans
        // the sessions of the wallet, so ignore anything faster than 2/s.
        if (now - player.visibleAt < 500) return;
        player.visibleAt = now;
        player.visible = visible;
        refreshOnline(walletIdOf(player));
        if (walletIdOf(player)) sendWallet(player); // "counting" changed
        return;
      }
      if (!isValidState(buf)) return;
      // Activity (anti idle bots): position or pose changed since the last frame.
      if (!player.state || Math.abs(buf.readFloatLE(1) - player.x) + Math.abs(buf.readFloatLE(9) - player.z) > 0.05 || (buf[21] & ANIM_MASK) !== (player.state[21] & ANIM_MASK)) markActive(player);
      player.state = Uint8Array.from(buf);
      // Picnic emotes need their item: relay a standing pose otherwise.
      const anim = player.state[21] & ANIM_MASK;
      const needs = catalog.emoteItems.get(FISH_STAGE_STATES.has(anim) ? FISH_STATE : anim) ?? (anim === OFFER_ICECREAM_STATE ? ICECREAM_ITEM : undefined);
      if (needs && !wallets.owns(walletIdOf(player), needs)) player.state[21] &= ~ANIM_MASK & 0xff;
      // A treat pose only after someone with an ice cream treated us.
      if (anim === TREAT_STATE && player.treatUntil < now) player.state[21] &= ~ANIM_MASK & 0xff;
      player.x = buf.readFloatLE(1);
      player.z = buf.readFloatLE(9);
      room.dirty.add(player);
    });

    ws.on('close', () => {
      room.players.delete(player);
      room.dirty.delete(player);
      setUid(player, '');
      refreshOnline(walletIdOf(player)); // a guest wallet stops counting too
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
    // Limits: total connections, connections per IP, number of open rooms
    // (any ?room= would otherwise open a new room and dodge the per-room cap).
    const ip = clientIp(req);
    const refuse = (status, reason) => {
      socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return true;
    };
    if (connections >= maxConnections) return refuse(503, 'Service Unavailable');
    if ((perIp.get(ip) ?? 0) >= maxPerIp) return refuse(429, 'Too Many Requests');
    const block = blockedIps.get(ip);
    if (block && block.until > Date.now()) return refuse(403, 'Forbidden');
    if (block) blockedIps.delete(ip);
    if (!rooms.has(roomName) && rooms.size >= maxRooms) return refuse(503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, roomName, ip));
    return true;
  }

  /**
   * The client's IP: behind a proxy (Render) the first X-Forwarded-For entry,
   * otherwise the socket address.
   */
  function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    return forwarded || req.socket.remoteAddress || 'unknown';
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

  /**
   * Disconnect players by relay id and/or account uid; returns how many. Their
   * IPs are refused for a while (KICK_BLOCK_MS, BAN_BLOCK_MS for bans) so they
   * cannot come straight back as guests.
   */
  function kick({ id, uid }, code = CLOSE_KICKED, reason = 'kicked') {
    let count = 0;
    const ms = code === CLOSE_BANNED ? BAN_BLOCK_MS : KICK_BLOCK_MS;
    for (const room of rooms.values()) {
      for (const p of room.players) {
        if ((id && p.id === id) || (uid && p.uid === uid)) {
          const ip = p.ws.clientIp;
          if (ip) blockedIps.set(ip, { until: Date.now() + ms, uid: code === CLOSE_BANNED ? uid || p.uid : '' });
          p.ws.close(code, reason);
          count++;
        }
      }
    }
    return count;
  }

  /** Record an admin ban decision; banning also disconnects the account. */
  function setBanned(uid, banned) {
    // An unban removes the override (Firestore decides again) instead of
    // forcing "not banned" over a Firestore ban until the next restart.
    if (banned) forcedBans.set(uid, true);
    else {
      forcedBans.delete(uid);
      for (const [ip, block] of blockedIps) if (block.uid === uid) blockedIps.delete(ip);
    }
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
      refreshOnline(uid); // pauses wallets whose players went idle
    }
    wallets.sweepGuests();
    const now = Date.now();
    for (const [ip, block] of blockedIps) if (block.until <= now) blockedIps.delete(ip);
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
