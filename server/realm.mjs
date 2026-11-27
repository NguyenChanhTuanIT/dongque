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
//    11 ONLINE   [u16 count]                     players in the room (us included), sent on
//                                                join and whenever it changes (at most once a tick)
//    12 HIDE     [u16 n][n × u32 id]             crowded room: these players left your view
//                                                (only the nearest visibleMax are sent; names /
//                                                outfits stay known for when they come back)
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
import { createBuckets } from './rate-limit.mjs';
import { foldText, hasProfanity, maskProfanity } from './profanity.mjs';
import { nearest } from './interest.mjs';
import { createClientIp } from './client-ip.mjs';

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
const MSG_ONLINE = 11;
/** [12][u16 n][n × u32 id]: these players left your view (crowded room); keep their name / outfit. */
const MSG_HIDE = 12;
/** How often each player's view (nearest visibleMax players) is recomputed in a crowded room. */
const VIEW_REFRESH_MS = 500;
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
/** The same chat line again within CHAT_REPEAT_MS: dropped. */
export const NOTICE_CHAT_REPEAT = 7;
/** Too many dropped chat lines in a row: chat muted for a while (escalating). */
export const NOTICE_CHAT_MUTED = 8;
/** Guests from the IP / tab of a recently banned account cannot chat or invite (accounts can). */
export const NOTICE_GUEST_BLOCKED = 9;
/** How long guests of a banned account's IP / tab stay without chat (in memory: a restart forgets it). */
const GUEST_BLOCK_MS = 7 * 24 * 60 * 60_000;
/** Kicked / banned players' IPs are refused for a while (they would come back as guests). */
const KICK_BLOCK_MS = 10 * 60_000;
const BAN_BLOCK_MS = 6 * 60 * 60_000;
/** Online rewards only count while the player did something in this window (anti idle bots). */
const DEFAULT_ACTIVE_MS = 10 * 60_000;
/** Walking this far (m) from the last active spot counts as activity. */
const ACTIVE_MOVE = 2;
/** The automatic pose after standing still (src/scene/emotes.ts 'bored'): not activity. */
const BORED_STATE = 2;
/** A position change of at least JUMP_MIN_DIST m faster than JUMP_SPEED m/s is a jump (teleport / respawn). */
const JUMP_MIN_DIST = 10;
const JUMP_SPEED = 40;
/** The only room: every player is in it, whatever ?room= the client asks for. */
const SINGLE_ROOM = 'main';
/** A room this full (share of maxPlayersPerRoom) closes connections silent for SILENT_MS. */
const CROWDED_SHARE = 0.9;
const SILENT_MS = 3 * 60_000;
/** No play-together invitations this long after a jump. */
const JUMP_COOLDOWN_MS = 1_500;
/** Names nobody may take (impersonating staff / the game), compared without accents. */
const RESERVED_NAMES = /admin|quan ?tri|moderator|\bmod\b|he ?thong|system|game ?master|\bgm\b|ban quan ly|support|ho ?tro/;
export const CLOSE_KICKED = 4001;
export const CLOSE_BANNED = 4003;
/** How long a Firestore ban lookup is trusted before asking again. */
const BAN_CACHE_MS = 30_000;
const NAME_MIN_CHARS = 2;
const NAME_MAX_CHARS = 20;
const CHAT_MAX_CHARS = 160;
/**
 * Chat budget: a burst of CHAT_BURST messages, refilled one per CHAT_REFILL_MS,
 * per sender (the account when signed in, else the IP), kept across reconnects
 * and shared by all tabs. Each IP also has a larger shared budget (several
 * accounts on one network, or one person with many accounts).
 */
const CHAT_BURST = 5;
const CHAT_REFILL_MS = 2_000;
const CHAT_IP_BURST = 15;
const CHAT_IP_REFILL_MS = 500;
/** A line equal to one of the sender's last CHAT_REPEAT_KEEP lines within this window is dropped. */
const CHAT_REPEAT_MS = 30_000;
const CHAT_REPEAT_KEEP = 3;
/** CHAT_STRIKES dropped lines within CHAT_STRIKE_WINDOW_MS mute the sender (account and IP). */
const CHAT_STRIKES = 6;
const CHAT_STRIKE_WINDOW_MS = 60_000;
/** First mute; each new mute within CHAT_MUTE_MEMORY_MS doubles it, up to CHAT_MUTE_MAX_MS. */
const CHAT_MUTE_MS = 60_000;
const CHAT_MUTE_MAX_MS = 10 * 60_000;
const CHAT_MUTE_MEMORY_MS = 60 * 60_000;
/** At most one "too fast / muted" notice per sender this often (the notices are spam too). */
const CHAT_NOTICE_MS = 3_000;
/** Outfit changes are shown to the room at most this often per player (the last one wins). */
const OUTFIT_MIN_MS = 500;
/** Sign in / sign out / name changes: a burst, then one per PROFILE_REFILL_MS. */
const PROFILE_BURST = 4;
const PROFILE_REFILL_MS = 5_000;
/** Decline / cancel / end of play-together: a burst, then one per second. */
const SOCIAL_MISC_BURST = 10;
const SOCIAL_MISC_REFILL_MS = 1_000;
/** Fishing news ("🎣 …", src/components/announce.ts): at most one per player this often. */
const ANNOUNCE_PREFIX = '🎣';
const ANNOUNCE_MIN_MS = 5_000;
/** New WebSocket connections per IP: a burst, then one per CONNECT_REFILL_MS (reconnect loops). */
const CONNECT_BURST = 30;
const CONNECT_REFILL_MS = 2_000;
/** Minimum delay between two profile (name) changes. */
const PROFILE_COOLDOWN_MS = 3_000;
/** Large enough for a Firebase ID token (~1 KB) plus a name, or a chat line. */
const MAX_PAYLOAD = 4096;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const MAX_OUTFIT_SLOTS = 16;
const MAX_OUTFIT_ITEM = 63;
const ENTRY_BYTES = 4 + STATE_BYTES;
/** Positions/angles outside this range are rejected as garbage. */
const MAX_ABS_COORD = 10_000;
/** Highest animation state: 0 ground, 1 airborne, 2 bored, 3 wave, 4 clap, 5 dance,
 *  6 sit cross-legged, 7 fishing, 8 lying prone, 9 sunbathing, 10 guitar,
 *  11 kite, 12 ice cream, 13 high five, 14 / 15 walking the shop's 1st / 2nd dog,
 *  16 … 38 countryside emotes, stone benches, play together, 39 … 42 fishing
 *  mini-game stages, 43 catching butterflies, 44 … 64 holding up a caught fish
 *  (one per species), 65 … 66 walking the shop's 3rd / 4th dog (src/scene/emotes.ts
 *  MAX_NET_STATE). The field has 7 bits (bit 7 = sprinting). */
const MAX_ANIM_STATE = 66;
/** Fishing mini-game stages (bite, fight, landed, snapped) and holding up a catch (44 … 64): they need the fishing rod like state 7. */
const FISH_STATE = 7;
/** Items that can break and be lost (then bought again): the fishing rod. */
const BREAKABLE_ITEMS = new Set(['picnic.fishing']);
const FISH_STAGE_STATES = new Set([39, 40, 41, 42, ...Array.from({ length: 21 }, (_, k) => 44 + k)]);
const ANIM_MASK = 0x7f;

/**
 * @typedef {object} RealmOptions
 * @property {string} [path]              URL path that accepts WebSocket upgrades.
 * @property {number} [maxPlayersPerRoom] Default 1000 (one shared room); each client is sent the nearest visibleMax.
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
    maxPlayersPerRoom = 1000,
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
    maxEarningPerIp = 4,
    // Players each client is sent at most (the game draws 128 characters,
    // NPCs and the local player included). More players than this in the room:
    // everyone gets the nearest ones and nearby chat (see tick()).
    visibleMax = 100,
    log = (msg) => console.log(`[realm] ${msg}`),
  } = options;
  const clientIp = options.clientIp ?? createClientIp();
  /** Chat budgets: "u:<uid>" / "ip:<ip>" (guests) and the shared one per IP. */
  const chatBuckets = createBuckets({ burst: CHAT_BURST, refillMs: CHAT_REFILL_MS });
  const chatIpBuckets = createBuckets({ burst: CHAT_IP_BURST, refillMs: CHAT_IP_REFILL_MS });
  const socialBuckets = createBuckets({ burst: SOCIAL_BURST, refillMs: SOCIAL_REFILL_MS });
  const connectBuckets = createBuckets({ burst: CONNECT_BURST, refillMs: CONNECT_REFILL_MS });
  /** Keyed like chat (account / IP): reconnecting does not reset them. */
  const profileBuckets = createBuckets({ burst: PROFILE_BURST, refillMs: PROFILE_REFILL_MS });
  const socialMiscBuckets = createBuckets({ burst: SOCIAL_MISC_BURST, refillMs: SOCIAL_MISC_REFILL_MS });
  /** Chat moderation state per key ("u:<uid>" / "ip:<ip>"). */
  /** @type {Map<string, { recent: Array<{ text: string, at: number }>, strikes: number[], muteUntil: number, muteMs: number, lastMuteAt: number }>} */
  const chatGuards = new Map();
  /** "ip:<ip>" / "g:<guest key>" → { until, uid }: guests there may not chat or invite (a banned account came from there). */
  const guestBlocks = new Map();
  /** wallet id → when it started earning online time (earliest keep full rate, see updateEarningRates). */
  const earningSince = new Map();
  // isLive: a guest wallet with a connected tab is never dropped to make room
  // (otherwise flooding new guest keys could wipe other players' flowers).
  const wallets = createWallets({ file: nodePath.join(dataDir, 'wallets.json'), timeZone, isLive: (id) => sessionsOf(id).length > 0 });
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
 * @property {string} ip  client IP (see client-ip.mjs)
   * @property {number} x
   * @property {number} z
   * @property {number} windowStart
   * @property {number} windowCount
   * @property {boolean} alive
   */

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = { players: new Set(), dirty: new Set(), countDirty: false };
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
    if (sessionsOf(uid).some((p) => p.visible && now - p.activeAt < activeMs)) {
      if (!wallets.counting(uid)) earningSince.set(uid, now);
      wallets.online(uid);
    } else {
      wallets.offline(uid);
      earningSince.delete(uid);
    }
  }

  /**
   * Many wallets earning from one IP (one person with many accounts / guest
   * tabs, or a classroom): nobody is stopped, but past the first
   * maxEarningPerIp wallets (the earliest to start) time counts slower: ×½ for
   * the next maxEarningPerIp, ×¼ after. A wallet on several IPs gets its best rate.
   */
  function updateEarningRates() {
    /** ip → wallet ids earning with a session there */
    const byIp = new Map();
    for (const room of rooms.values()) {
      for (const p of room.players) {
        const id = walletIdOf(p);
        if (!id || !wallets.counting(id)) continue;
        if (!byIp.has(p.ip)) byIp.set(p.ip, new Set());
        byIp.get(p.ip).add(id);
      }
    }
    const best = new Map();
    for (const ids of byIp.values()) {
      const ranked = [...ids].sort((a, b) => (earningSince.get(a) ?? 0) - (earningSince.get(b) ?? 0));
      ranked.forEach((id, rank) => {
        const rate = !maxEarningPerIp || rank < maxEarningPerIp ? 1 : rank < 2 * maxEarningPerIp ? 0.5 : 0.25;
        best.set(id, Math.max(best.get(id) ?? 0, rate));
      });
    }
    for (const [id, rate] of best) {
      if (wallets.rate(id) === rate) continue;
      wallets.setRate(id, rate);
      for (const p of sessionsOf(id)) sendWallet(p); // the rewards panel shows the rate
    }
  }

  /** Something happened on this session: resume its online time if it was paused. */
  function markActive(player) {
    const wasIdle = Date.now() - player.activeAt >= activeMs;
    player.activeAt = Date.now();
    if (wasIdle) refreshOnline(walletIdOf(player));
  }

  /** Accent-free lower case, to compare names ("Quản trị" ~ "quan tri"). */
  // Also folds look-alike letters ("Аdmin" with a Cyrillic А, "𝐀𝐝𝐦𝐢𝐧"), see profanity.mjs.
  const plainName = (name) => foldText(name);

  /** Whether `name` is reserved or used by another account online. */
  function nameUnavailable(name, uid) {
    const plain = plainName(name);
    if (RESERVED_NAMES.test(plain)) return true;
    // Held by another account that used it in the last 30 days (offline or not).
    const owner = wallets.nameOwner(plain);
    if (owner && owner !== uid) return true;
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
    // Signing in / out in a loop re-broadcasts names and outfits to the room.
    if (player.profilePending || !profileBuckets.take(`p:${player.id}`)) return;
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
      if (banned) blockGuestsOf(player, uid); // still plays as a guest, but cannot chat / invite
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
    wallets.claimName(player.uid, plainName(name));
    player.name = idMessage(MSG_NAME, player.id, name, true);
    broadcast(room, player.name);
  }

  /** Chat moderation state of `key`, created on first use. */
  function chatGuard(key) {
    let g = chatGuards.get(key);
    if (!g) {
      g = { recent: [], strikes: [], muteUntil: 0, muteMs: 0, lastMuteAt: 0 };
      chatGuards.set(key, g);
    }
    return g;
  }

  /** Distinct accounts and guest sessions connected from `ip`. */
  function peopleOnIp(ip) {
    const uids = new Set();
    let guests = 0;
    for (const room of rooms.values()) {
      for (const p of room.players) {
        if (p.ip !== ip) continue;
        if (p.uid) uids.add(p.uid);
        else guests++;
      }
    }
    return { accounts: uids.size, guests };
  }

  /** Whether this guest session comes from the IP / tab of a recently banned account. */
  function guestBlocked(player, now) {
    for (const k of [`ip:${player.ip}`, player.guest && `g:${player.guest}`]) {
      const block = k && guestBlocks.get(k);
      if (block && block.until > now) return true;
    }
    return false;
  }

  /** Banned account `uid` seen on this session: its IP and guest tab may not chat / invite as guests for GUEST_BLOCK_MS. */
  function blockGuestsOf(player, uid) {
    const until = Date.now() + GUEST_BLOCK_MS;
    guestBlocks.set(`ip:${player.ip}`, { until, uid });
    if (player.guest) guestBlocks.set(`g:${player.guest}`, { until, uid });
  }

  /** Who is chatting: the account when signed in, else the IP (all guest tabs of a network). */
  const chatKeyOf = (player) => (player.uid ? `u:${player.uid}` : `ip:${player.ip}`);

  /** Compared form of a chat line: case, accents, spacing and repeated letters ignored ("Spammm" = "spam"). */
  const repeatKey = (text) => plainName(text).replace(/[\s\p{P}\p{S}]+/gu, '').replace(/(.)\1+/gu, '$1');

  /** Tell the sender why a line was dropped, at most once per CHAT_NOTICE_MS. */
  function chatNotice(player, code, now) {
    if (now - player.chatNoticeAt < CHAT_NOTICE_MS) return;
    player.chatNoticeAt = now;
    notice(player, code);
  }

  /** A dropped line: CHAT_STRIKES within the window mute the account and the IP (escalating). */
  function chatStrike(player, guards, now) {
    const [main] = guards;
    main.strikes = main.strikes.filter((t) => now - t < CHAT_STRIKE_WINDOW_MS);
    main.strikes.push(now);
    if (main.strikes.length < CHAT_STRIKES) return false;
    main.strikes = [];
    const ms = now - main.lastMuteAt < CHAT_MUTE_MEMORY_MS ? Math.min(CHAT_MUTE_MAX_MS, Math.max(CHAT_MUTE_MS, main.muteMs * 2)) : CHAT_MUTE_MS;
    for (const g of guards) {
      g.muteMs = ms;
      g.lastMuteAt = now;
      g.muteUntil = Math.max(g.muteUntil, now + ms);
    }
    log(`#${player.id} (${player.uid || 'guest'}, ${player.ip}) chat muted for ${ms / 1000}s`);
    return true;
  }

  function onChat(player, room, buf) {
    const now = Date.now();
    const key = chatKeyOf(player);
    const ipKey = `ip:${player.ip}`;
    // A muted account also mutes the guests of its IP (signing out to chat as a
    // guest does not help), but not the other accounts of that network.
    const guards = key === ipKey ? [chatGuard(key)] : [chatGuard(key), chatGuard(ipKey)];
    const [guard] = guards;
    if (guard.muteUntil > now) return chatNotice(player, NOTICE_CHAT_MUTED, now);
    // A banned player back as a guest: guests of that IP / tab cannot talk for a while.
    if (!player.uid && guestBlocked(player, now)) return chatNotice(player, NOTICE_GUEST_BLOCKED, now);
    // Profane words become '*' for everyone (the sender sees the masked line too).
    const raw = cleanText(buf.subarray(1), CHAT_MAX_CHARS);
    let text = maskProfanity(raw);
    if (text !== raw) player.chatMasked++;
    // Fishing news show as a system line: only from a player who is fishing
    // right now (rod owned, else the state was already reset to standing), at
    // most one per ANNOUNCE_MIN_MS. Anything else loses the 🎣 and is plain chat.
    if (text.startsWith(ANNOUNCE_PREFIX)) {
      const anim = player.state ? player.state[21] & ANIM_MASK : 0;
      const fishing = anim === FISH_STATE || FISH_STAGE_STATES.has(anim);
      if (fishing && now - player.announceAt >= ANNOUNCE_MIN_MS) player.announceAt = now;
      else text = text.replace(/^(?:🎣\s*)+/u, '').trim();
    }
    if (!text) return;
    const drop = (code) => {
      const muted = chatStrike(player, guards, now);
      player.chatDrops++;
      if (muted) player.chatMutes++;
      if (muted) player.chatNoticeAt = 0; // always say so when it starts
      chatNotice(player, muted ? NOTICE_CHAT_MUTED : code, now);
    };
    // Budgets grow with the people really behind the IP (a classroom, a café):
    // accounts count one each, guest tabs up to 3 (tabs are free to open).
    const { accounts, guests } = peopleOnIp(player.ip);
    const keyScale = key === ipKey ? Math.min(guests, 3) : 1;
    const ipScale = Math.max(1, (accounts + Math.min(guests, 3)) / 2);
    if (!chatBuckets.has(key, now, keyScale) || !chatIpBuckets.has(player.ip, now, ipScale)) return drop(NOTICE_CHAT_TOO_FAST);
    guard.recent = guard.recent.filter((r) => now - r.at < CHAT_REPEAT_MS);
    const same = repeatKey(text);
    if (same && guard.recent.some((r) => r.text === same)) return drop(NOTICE_CHAT_REPEAT);
    chatBuckets.take(key, now, keyScale);
    chatIpBuckets.take(player.ip, now, ipScale);
    guard.recent = [...guard.recent, { text: same, at: now }].slice(-CHAT_REPEAT_KEEP);
    markActive(player);
    // Small room: everyone. Crowded room: the players who can see the speaker
    // (a thousand people in one chat box would be unreadable).
    const line = idMessage(MSG_CHAT, player.id, text, false);
    for (const p of audienceOf(room, player)) send(p.ws, line);
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
      // Same budget across tabs / reconnects of the account (guests: of the IP).
      const key = chatKeyOf(player);
      if (!player.uid && guestBlocked(player, now)) return notice(player, NOTICE_GUEST_BLOCKED);
      if (!socialBuckets.has(key, now)) return notice(player, NOTICE_CHAT_TOO_FAST);
      const dx = player.x - target.x;
      const dz = player.z - target.z;
      if (dx * dx + dz * dz > SOCIAL_RANGE * SOCIAL_RANGE) return;
      // Just teleported next to someone: wait a moment (walking up is never affected).
      if (now - player.jumpAt < JUMP_COOLDOWN_MS) return;
      if (activity === ACTIVITY_ICECREAM && !wallets.owns(walletIdOf(player), ICECREAM_ITEM)) return;
      socialBuckets.take(key, now);
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
    // Decline / cancel only for an invitation that exists; all three are throttled.
    if (kind === SOCIAL_DECLINE) {
      if (!target.invites.delete(player.id)) return;
    } else if (kind === SOCIAL_CANCEL) {
      if (!player.invites.delete(target.id)) return;
    } else if (kind !== SOCIAL_END) return;
    if (!socialMiscBuckets.take(`p:${player.id}`, now)) return;
    send(target.ws, socialMessage(kind, player.id, activity));
  }

  /** Whether players of `room` only receive the ones near them (crowded room, or VIEW_DISTANCE set). */
  const filtered = (room) => !!viewDistance || room.players.size - 1 > visibleMax;

  /** [12][u16 n][ids] */
  function hideMessage(players) {
    const msg = Buffer.alloc(3 + players.length * 4);
    msg.writeUInt8(MSG_HIDE, 0);
    msg.writeUInt16LE(players.length, 1);
    players.forEach((p, i) => msg.writeUInt32LE(p.id, 3 + i * 4));
    return msg;
  }

  /**
   * Recompute who each player sees: the nearest visibleMax (within
   * viewDistance if set). Players coming into view are sent their state right
   * away, players leaving it a HIDE. `null` = sees everyone (small room).
   */
  function refreshViews(room) {
    const crowded = filtered(room);
    for (const p of room.players) {
      const before = p.inView;
      if (!crowded) {
        if (!before) continue;
        // Back to a small room: everyone is visible again.
        p.inView = null;
        const back = [...room.players].filter((o) => o !== p && o.state && !before.has(o));
        if (back.length) send(p.ws, entriesBuffer(back));
        continue;
      }
      const after = nearest(p, room.players, visibleMax, before, viewDistance);
      p.inView = after;
      const entered = before ? [...after].filter((o) => !before.has(o)) : [];
      const left = before ? [...before].filter((o) => !after.has(o) && room.players.has(o)) : [...room.players].filter((o) => o !== p && !after.has(o));
      // HIDE first, so the client never holds more than visibleMax characters.
      if (left.length) send(p.ws, hideMessage(left));
      if (entered.length) send(p.ws, entriesBuffer(entered));
    }
  }

  /** Players who see `player` (and so get its chat lines / bubbles), itself included. */
  function audienceOf(room, player) {
    if (!filtered(room)) return room.players;
    const out = [player];
    for (const p of room.players) if (p !== player && p.inView?.has(player)) out.push(p);
    return out;
  }

  /** Broadcast changed states of every room. */
  function tick() {
    for (const [name, room] of rooms) {
      if (room.players.size === 0) {
        rooms.delete(name);
        continue;
      }
      // Joins / leaves since the last tick: one ONLINE for the whole room.
      if (room.countDirty) {
        room.countDirty = false;
        const online = Buffer.alloc(3);
        online.writeUInt8(MSG_ONLINE, 0);
        online.writeUInt16LE(Math.min(room.players.size, 0xffff), 1);
        broadcast(room, online);
      }
      const now = Date.now();
      for (const p of room.players) {
        if (p.outfitPending && now - p.outfitAt >= OUTFIT_MIN_MS) {
          p.outfitAt = now;
          p.outfitPending = false;
          applyOutfit(p, { save: true });
        }
      }
      if (now - (room.viewsAt ?? 0) >= VIEW_REFRESH_MS) {
        room.viewsAt = now;
        refreshViews(room);
      }
      if (room.dirty.size === 0) continue;
      const changed = [...room.dirty].filter((p) => p.state);
      const dirty = room.dirty;
      room.dirty = new Set();
      if (!filtered(room)) {
        // Same buffer for everyone; receivers skip their own id.
        const buf = entriesBuffer(changed);
        for (const p of room.players) send(p.ws, buf);
      } else {
        // Each player: the changed ones among those it sees (≤ visibleMax checks).
        let all = null;
        for (const p of room.players) {
          if (!p.inView) {
            // The room just became crowded: everything until its view is computed.
            all ??= entriesBuffer(changed);
            send(p.ws, all);
            continue;
          }
          const visible = [];
          for (const o of p.inView) if (dirty.has(o) && o.state) visible.push(o);
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
      /** Client IP (per-IP chat budget, mutes, online reward cap). */
      ip,
      /** Last "too fast / muted" notice sent to this session. */
      chatNoticeAt: 0,
      /** Last outfit shown to the room; a newer one waits for the tick when set too soon. */
      outfitAt: 0,
      outfitPending: false,
      /** Last fishing news ("🎣 …") relayed for this player. */
      announceAt: 0,
      /** Players this one is sent in a crowded room (nearest visibleMax); null = everyone. */
      inView: null,
      /** Last message of any kind (silent connections are let go when the room is crowded). */
      lastMsgAt: Date.now(),
      /** Where activity was last seen (anti idle bots, ACTIVE_MOVE). */
      anchorX: 0,
      anchorZ: 0,
      /** Last state frame; last sudden position jump and how many (admin panel). */
      stateAt: 0,
      jumpAt: 0,
      jumps: 0,
      /** Chat lines dropped (too fast / repeated) and mutes, for the admin panel. */
      chatDrops: 0,
      chatMutes: 0,
      /** Chat lines with profane words masked. */
      chatMasked: 0,
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
    room.countDirty = true;

    const welcome = Buffer.alloc(5);
    welcome.writeUInt8(MSG_WELCOME, 0);
    welcome.writeUInt32LE(player.id, 1);
    send(ws, welcome);
    // Bootstrap the newcomer with everyone already here (crowded: the nearest;
    // its position is not known yet, so the ones near the spawn point).
    if (filtered(room)) player.inView = nearest(player, room.players, visibleMax, null, viewDistance);
    const present = player.inView ? [...player.inView] : [...room.players].filter((p) => p !== player && p.state);
    if (present.length) send(ws, entriesBuffer(present));
    for (const p of room.players) if (p !== player && p.outfit) send(ws, p.outfit);
    for (const p of room.players) if (p !== player && p.name) send(ws, p.name);

    ws.on('pong', () => {
      player.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      player.lastMsgAt = now;
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
        // Each change goes to the whole room: flipping outfits 40×/s would flood
        // everyone. Faster changes wait for the tick (only the last one is sent).
        if (now - player.outfitAt >= OUTFIT_MIN_MS) {
          player.outfitAt = now;
          player.outfitPending = false;
          applyOutfit(player, { save: true });
        } else {
          player.outfitPending = true;
        }
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
      const nx = buf.readFloatLE(1);
      const nz = buf.readFloatLE(9);
      const nanim = buf[21] & ANIM_MASK;
      // Activity (anti idle bots): walked ACTIVE_MOVE m away from where the last
      // activity was seen (jittering on the spot does not count), or a pose the
      // player chose (jump, emotes); the automatic "bored" pose does not count.
      const moved = Math.hypot(nx - player.anchorX, nz - player.anchorZ) >= ACTIVE_MOVE;
      const posed = !!player.state && nanim !== (player.state[21] & ANIM_MASK) && nanim !== 0 && nanim !== BORED_STATE;
      if (!player.state || moved || posed) {
        player.anchorX = nx;
        player.anchorZ = nz;
        markActive(player);
      }
      // Sudden jumps in position (teleport hacks, or a respawn): no penalty, just
      // no play-together invitations for JUMP_COOLDOWN_MS, and a count for admins.
      if (player.state) {
        const dist = Math.hypot(nx - player.x, nz - player.z);
        const dt = Math.max(1, now - player.stateAt) / 1000;
        if (dist >= JUMP_MIN_DIST && dist / dt > JUMP_SPEED) {
          player.jumpAt = now;
          player.jumps++;
        }
      }
      player.stateAt = now;
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
      room.countDirty = true;
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
    // Everyone plays in one room: ?room= from the client is ignored.
    const roomName = SINGLE_ROOM;
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
    // Reconnect loops (each new connection used to get a fresh chat budget).
    if (!connectBuckets.take(ip)) return refuse(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, roomName, ip));
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
          // Signs for admins to look at (nothing is decided automatically from them).
          flags: {
            chatDrops: p.chatDrops,
            chatMutes: p.chatMutes,
            chatMasked: p.chatMasked,
            jumps: p.jumps,
            earningRate: walletIdOf(p) && wallets.counting(walletIdOf(p)) ? wallets.rate(walletIdOf(p)) : null,
            sameIp: perIp.get(p.ip) ?? 1,
            guestBlocked: !p.uid && guestBlocked(p, Date.now()),
          },
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
          if (code === CLOSE_BANNED) blockGuestsOf(p, uid || p.uid);
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
      for (const [k, block] of guestBlocks) if (block.uid === uid) guestBlocks.delete(k);
    }
    banCache.delete(uid);
    return banned ? kick({ uid }, CLOSE_BANNED, 'banned') : 0;
  }

  const tickTimer = setInterval(tick, tickMs);
  // Drop connections that stopped answering pings (closed laptops, dead NATs).
  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      // Nearly full: free the places of connections that never talk (a real
      // client sends a heartbeat every few seconds, even in a background tab
      // at least once a minute). They may reconnect; nobody is blocked.
      const crowded = room.players.size >= maxPlayersPerRoom * CROWDED_SHARE;
      for (const p of room.players) {
        if (!p.alive || (crowded && now - p.lastMsgAt > SILENT_MS)) {
          if (p.alive) p.ws.close(1000, 'idle');
          else p.ws.terminate();
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
    updateEarningRates();
    wallets.sweepGuests();
    const now = Date.now();
    for (const buckets of [chatBuckets, chatIpBuckets, socialBuckets, connectBuckets, profileBuckets, socialMiscBuckets]) buckets.sweep(now);
    for (const [key, g] of chatGuards) {
      if (g.muteUntil < now && now - g.lastMuteAt > CHAT_MUTE_MEMORY_MS && !g.recent.some((r) => now - r.at < CHAT_REPEAT_MS) && !g.strikes.some((t) => now - t < CHAT_STRIKE_WINDOW_MS)) chatGuards.delete(key);
    }
    for (const [ip, block] of blockedIps) if (block.until <= now) blockedIps.delete(ip);
    for (const [k, block] of guestBlocks) if (block.until <= now) guestBlocks.delete(k);
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
  return chars >= NAME_MIN_CHARS && chars <= NAME_MAX_CHARS && /[\p{L}\p{N}]/u.test(name) && !hasProfanity(name);
}
