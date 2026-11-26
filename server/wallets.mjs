// Flower wallets ("hoa", the in-game currency for future shop items), kept by
// the relay so players cannot edit them: one JSON file, saved shortly after
// every change (write to a temp file, then rename).
//
// Daily rewards, by calendar day in `timeZone` (Vietnam by default):
//   - check-in once a day: 5 flowers, Saturday / Sunday 10;
//   - online milestones, one after the other: 10 min → 5, then 30 more min
//     → 10, then 60 more min → 15. A milestone's clock starts when the previous
//     one is claimed and stops once it is reached (until claimed). Time counts
//     while the account is "online": the relay calls online()/offline() when it
//     has / no longer has a visible game tab (several tabs count once).
//
// Shop (server/shop.mjs): buy() spends flowers on an item for good (`owned`);
// the account's equipped outfit (`outfit`, slot id → item id) is kept here too,
// so it follows the account to any device.
//
// Guests (players who are not signed in) get a wallet too, keyed
// "guest:<key>" where the key is a random secret their browser tab keeps in
// sessionStorage. Guest wallets live in memory only (never saved, dropped after
// GUEST_IDLE_MS without a session): closing the tab loses them. Registering
// moves the guest wallet into the new account (adopt()).

import fs from 'node:fs';
import path from 'node:path';

export const CHECKIN_FLOWERS = { weekday: 5, weekend: 10 };
export const ONLINE_TIERS = [
  { minutes: 10, flowers: 5 },
  { minutes: 30, flowers: 10 },
  { minutes: 60, flowers: 15 },
];
/** Longest gap credited between two accruals (sleeping laptop, stalled tick). */
const MAX_ACCRUAL_MS = 60_000;
const SAVE_DELAY_MS = 3_000;
const KEEP_CHECKINS = 14;
const KEEP_PURCHASES = 50;
const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
/** Guest wallets unused this long are forgotten. */
const GUEST_IDLE_MS = 6 * 60 * 60 * 1000;
/** At most this many guest wallets in memory (the least recently used go first, never online ones). */
const MAX_GUESTS = 20_000;
export const GUEST_PREFIX = 'guest:';
const isGuestId = (id) => id.startsWith(GUEST_PREFIX);

/**
 * @typedef {object} Wallet
 * @property {number} flowers   current balance
 * @property {number} earned    lifetime total
 * @property {string} day       YYYY-MM-DD the daily fields below belong to
 * @property {number} onlineMs  online time that day (stats)
 * @property {number} stage     online milestones claimed that day (0 … ONLINE_TIERS.length)
 * @property {number} stageMs   time counted towards milestone `stage`
 * @property {string[]} checkins recent check-in days (YYYY-MM-DD)
 * @property {string[]} owned   shop items bought (ids from shared/shop-catalog.json)
 * @property {number} spent     lifetime flowers spent in the shop
 * @property {Array<{ id: string, price: number, at: number }>} purchases  latest purchases (support / audit)
 * @property {Record<string, string> | null} outfit  equipped items, slot id → item id (null = never saved)
 */

/**
 * @param {object} options
 * @param {string} options.file      JSON file path (created on first save).
 * @param {string} [options.timeZone]
 * @param {(msg: string) => void} [options.log]
 */
export function createWallets({ file, timeZone = 'Asia/Ho_Chi_Minh', log = (msg) => console.log(`[wallets] ${msg}`) }) {
  /** @type {Record<string, Wallet>} */
  let wallets = {};
  try {
    wallets = JSON.parse(fs.readFileSync(file, 'utf8')).wallets ?? {};
    log(`loaded ${Object.keys(wallets).length} wallets from ${file}`);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') log(`could not read ${file}: ${err}`);
  }
  /** Guest wallets (memory only), id → wallet; `seen` = last use. */
  /** @type {Map<string, Wallet & { seen: number }>} */
  const guests = new Map();
  /** uid → time online time was last credited (accounts online right now). */
  const lastAccrual = new Map();
  /** @type {NodeJS.Timeout | null} */
  let saveTimer = null;

  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekdayFormat = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
  const dayOf = (now) => dayFormat.format(now); // YYYY-MM-DD
  /** 0 = Monday … 6 = Sunday, in the wallet time zone. */
  const weekdayOf = (now) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekdayFormat.format(now));
  const addDays = (day, n) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const checkinReward = (weekday) => (weekday >= 5 ? CHECKIN_FLOWERS.weekend : CHECKIN_FLOWERS.weekday);

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
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, wallets }));
      fs.renameSync(tmp, file);
    } catch (err) {
      log(`could not save ${file}: ${err}`);
    }
  }

  const emptyWallet = () => ({ flowers: 0, earned: 0, day: '', onlineMs: 0, stage: 0, stageMs: 0, checkins: [], owned: [], spent: 0, purchases: [], outfit: null });
  /** Saved wallet or guest wallet, without creating one. */
  const peek = (id) => (isGuestId(id) ? guests.get(id) : wallets[id]);

  /** The wallet of `uid` (account uid or guest id), its daily fields reset when the day changed. */
  function wallet(uid, now) {
    let w;
    if (isGuestId(uid)) {
      w = guests.get(uid);
      if (w) {
        guests.delete(uid); // re-insert: the Map stays in least-recently-used order
      } else {
        if (guests.size >= MAX_GUESTS) {
          // Make room: the least recently used wallet without a live session.
          for (const id of guests.keys()) {
            if (!lastAccrual.has(id)) {
              guests.delete(id);
              break;
            }
          }
        }
        w = { ...emptyWallet(), seen: now };
      }
      guests.set(uid, w);
      w.seen = now;
    } else {
      w = wallets[uid];
      if (!w) w = wallets[uid] = emptyWallet();
    }
    if (!Array.isArray(w.owned)) {
      // Saved before the shop.
      w.owned = [];
      w.spent = 0;
      w.purchases = [];
      w.outfit = null;
    }
    const day = dayOf(now);
    if (w.day !== day) {
      w.day = day;
      w.onlineMs = 0;
      w.stage = 0;
      w.stageMs = 0;
    }
    if (w.stage === undefined) {
      // Saved before milestones were sequential.
      w.stage = Array.isArray(w.claimed) ? Math.min(w.claimed.length, ONLINE_TIERS.length) : 0;
      w.stageMs = 0;
      delete w.claimed;
    }
    return w;
  }

  function give(w, flowers) {
    w.flowers += flowers;
    w.earned += flowers;
    save();
  }

  const tierMs = (stage) => ONLINE_TIERS[stage].minutes * 60_000;

  /** Credit online time up to `now`; returns true when the current milestone was just reached. */
  function accrue(uid, now = Date.now()) {
    const last = lastAccrual.get(uid);
    if (last === undefined) return false;
    lastAccrual.set(uid, now);
    const w = wallet(uid, now);
    // Across midnight the new day gets the (≤ 1 min) gap: close enough.
    const delta = Math.max(0, Math.min(MAX_ACCRUAL_MS, now - last));
    w.onlineMs += delta;
    save();
    if (w.stage >= ONLINE_TIERS.length) return false;
    const goal = tierMs(w.stage);
    if (w.stageMs >= goal) return false; // reached, waiting to be claimed
    w.stageMs = Math.min(goal, w.stageMs + delta);
    return w.stageMs >= goal;
  }

  return {
    /** The account has a live session: start counting its online time. */
    online(uid, now = Date.now()) {
      if (!lastAccrual.has(uid)) lastAccrual.set(uid, now);
    },
    /** Its last visible session ended / was hidden. */
    offline(uid, now = Date.now()) {
      if (!lastAccrual.has(uid)) return;
      accrue(uid, now);
      lastAccrual.delete(uid);
    },
    /** Accounts being counted right now. */
    onlineUids: () => [...lastAccrual.keys()],
    accrue,

    /** @returns {{ ok: true, flowers: number } | { ok: false, error: 'already' }} */
    checkIn(uid, now = Date.now()) {
      const w = wallet(uid, now);
      if (w.checkins.includes(w.day)) return { ok: false, error: 'already' };
      const flowers = checkinReward(weekdayOf(now));
      w.checkins = [...w.checkins, w.day].slice(-KEEP_CHECKINS);
      give(w, flowers);
      return { ok: true, flowers };
    },

    /** Claim milestone `tier`: only the current one, once reached. */
    claimOnline(uid, tier, now = Date.now()) {
      const t = ONLINE_TIERS[tier];
      if (!t) return { ok: false, error: 'tier' };
      accrue(uid, now);
      const w = wallet(uid, now);
      if (tier < w.stage) return { ok: false, error: 'claimed' };
      if (tier > w.stage || w.stageMs < tierMs(tier)) return { ok: false, error: 'not-yet' };
      w.stage += 1;
      w.stageMs = 0; // the next milestone starts now
      give(w, t.flowers);
      return { ok: true, flowers: t.flowers };
    },

    /** Whether the account bought `id` (no wallet is created for the check). */
    owns(uid, id) {
      return !!uid && !!peek(uid)?.owned?.includes(id);
    },

    /**
     * Item `id` is gone (a fishing rod broke on a big fish): no longer owned,
     * it can be bought again in the shop. Flowers are not given back.
     * @returns {{ ok: true } | { ok: false, error: 'not-owned' }}
     */
    lose(uid, id, now = Date.now()) {
      const w = wallet(uid, now);
      if (!w.owned.includes(id)) return { ok: false, error: 'not-owned' };
      w.owned = w.owned.filter((owned) => owned !== id);
      w.purchases = [...w.purchases, { id, price: 0, at: now, lost: true }].slice(-KEEP_PURCHASES);
      save();
      return { ok: true };
    },

    /**
     * Spend `price` flowers on item `id`. The caller checked that the item is
     * for sale at that price.
     * @returns {{ ok: true, price: number } | { ok: false, error: 'owned' | 'poor' }}
     */
    buy(uid, id, price, now = Date.now()) {
      const w = wallet(uid, now);
      if (w.owned.includes(id)) return { ok: false, error: 'owned' };
      if (w.flowers < price) return { ok: false, error: 'poor' };
      w.flowers -= price;
      w.spent += price;
      w.owned = [...w.owned, id];
      w.purchases = [...w.purchases, { id, price, at: now }].slice(-KEEP_PURCHASES);
      save();
      return { ok: true, price };
    },

    /** The account's saved outfit (slot id → item id), or null. */
    getOutfit(uid) {
      return peek(uid)?.outfit ?? null;
    },

    /**
     * Registering after playing as a guest: move guest wallet `guestId` into
     * account `uid` when that account has no progress yet (a new account).
     * Returns 'adopted', 'skipped' (the account already has progress: the guest
     * wallet stays with the tab) or '' (nothing to move).
     */
    adopt(uid, guestId, now = Date.now()) {
      const g = guests.get(guestId);
      if (!g || (!g.earned && !g.owned.length && !g.checkins.length)) return '';
      const mine = wallets[uid];
      if (mine && (mine.earned || mine.owned.length || mine.checkins.length)) return 'skipped';
      const { seen, ...moved } = g;
      wallets[uid] = moved;
      guests.delete(guestId);
      wallet(uid, now); // normalise the day fields
      save();
      log(`guest wallet moved to ${uid} (${moved.flowers} flowers, ${moved.owned.length} items)`);
      return 'adopted';
    },

    /** Forget guest wallets nobody used for a while (and not online now). */
    sweepGuests(now = Date.now()) {
      for (const [id, w] of guests) if (now - w.seen > GUEST_IDLE_MS && !lastAccrual.has(id)) guests.delete(id);
    },

    setOutfit(uid, outfit, now = Date.now()) {
      const w = wallet(uid, now);
      if (JSON.stringify(w.outfit) === JSON.stringify(outfit)) return;
      w.outfit = outfit;
      save();
    },

    /** Everything the rewards panel shows. */
    status(uid, now = Date.now()) {
      accrue(uid, now);
      const w = wallet(uid, now);
      const weekday = weekdayOf(now);
      const monday = addDays(w.day, -weekday);
      return {
        flowers: w.flowers,
        day: w.day,
        checkedIn: w.checkins.includes(w.day),
        checkinFlowers: checkinReward(weekday),
        week: WEEKDAYS.map((label, i) => {
          const day = addDays(monday, i);
          return { label, day, flowers: checkinReward(i), checked: w.checkins.includes(day), today: i === weekday };
        }),
        onlineSec: Math.floor(w.onlineMs / 1000),
        stage: w.stage,
        stageSec: Math.floor(w.stageMs / 1000),
        counting: lastAccrual.has(uid),
        tiers: ONLINE_TIERS.map((t, i) => ({ minutes: t.minutes, flowers: t.flowers, claimed: i < w.stage })),
        owned: w.owned,
      };
    },

    flush,
  };
}
