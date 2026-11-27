// Flower wallets ("hoa", the in-game currency for future shop items), kept by
// the relay so players cannot edit them: a JSON snapshot (wallets.json) plus a
// journal of the wallets changed since (wallets.journal), see "Storage" below.
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
/** Changes reach the journal this soon (a crash loses at most this much). */
const SAVE_DELAY_MS = 1_000;
/** Online time counting alone: written at least this often (a crash loses at most a minute of it). */
const MINOR_SAVE_DELAY_MS = 60_000;
/** Compact (rewrite the snapshot, empty the journal) once the journal passes both. */
const COMPACT_MIN_BYTES = 4 * 1024 * 1024;
const COMPACT_RATIO = 1;
const KEEP_CHECKINS = 14;
const KEEP_PURCHASES = 50;
const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];
/** A display name stays reserved for its account this long after it was last used. */
const NAME_HOLD_MS = 30 * 24 * 60 * 60 * 1000;
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
export function createWallets({ file, timeZone = 'Asia/Ho_Chi_Minh', isLive = () => false, log = (msg) => console.log(`[wallets] ${msg}`) }) {
  // Storage: `file` is a full snapshot; every change since is appended to the
  // journal (`wallets.journal`, one JSON line per changed wallet:
  // {"u": uid, "w": wallet}). Loading = snapshot, then the journal replayed
  // in order (the last line of a wallet wins). Appending a few changed
  // wallets is cheap whatever the number of accounts; the full snapshot is
  // only rewritten when the journal has grown (compact()) and on shutdown.
  const journalFile = file.replace(/\.json$/, '') + '.journal';
  /** @type {Record<string, Wallet>} */
  let wallets = {};
  /** Sizes on disk (bytes), to decide when to compact. */
  let snapshotBytes = 0;
  let journalBytes = 0;
  try {
    const text = fs.readFileSync(file, 'utf8');
    snapshotBytes = Buffer.byteLength(text);
    wallets = JSON.parse(text).wallets ?? {};
  } catch (err) {
    // A damaged snapshot must not be replaced by an empty one at the next save:
    // stop here so a person can restore it (wallets.json.tmp may be newer).
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw new Error(`could not read ${file}: ${err}`);
  }
  let replayed = 0;
  let skipped = 0;
  try {
    const text = fs.readFileSync(journalFile, 'utf8');
    journalBytes = Buffer.byteLength(text);
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.u !== 'string' || !entry.w || typeof entry.w !== 'object') throw new Error('bad entry');
        wallets[entry.u] = entry.w;
        replayed++;
      } catch {
        skipped++; // a line cut short by a crash while appending
      }
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw new Error(`could not read ${journalFile}: ${err}`);
  }
  log(`loaded ${Object.keys(wallets).length} wallets from ${file} (+${replayed} journal entries${skipped ? `, ${skipped} damaged lines skipped` : ''})`);
  /** Items taken out of the shop, and what their owners get instead. */
  const RENAMED_ITEMS = { 'pet.cat': 'pet.dog2' };
  const migrated = [];
  for (const [uid, w] of Object.entries(wallets)) {
    if (!Array.isArray(w.owned)) continue;
    let changed = false;
    w.owned = [...new Set(w.owned.map((id) => {
      if (!(id in RENAMED_ITEMS)) return id;
      changed = true;
      return RENAMED_ITEMS[id];
    }))];
    if (changed) migrated.push(uid);
  }
  /** Display names held by accounts: compare form (realm plainName) → uid (see claimName). */
  const nameIndex = new Map();
  for (const [uid, w] of Object.entries(wallets)) if (w.nameKey) nameIndex.set(w.nameKey, uid);
  /** Guest wallets (memory only), id → wallet; `seen` = last use. */
  /** @type {Map<string, Wallet & { seen: number }>} */
  const guests = new Map();
  /** uid → time online time was last credited (accounts online right now). */
  const lastAccrual = new Map();
  /** uid → share of online time counted towards milestones (1 = all; see setRate). */
  const rates = new Map();
  /** Accounts changed since the last journal write. */
  const dirty = new Set();
  /** @type {NodeJS.Timeout | null} */
  let saveTimer = null;
  /** When the pending write is due (ms). */
  let saveAt = Infinity;

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

  /**
   * Account `uid` changed: write it to the journal soon. Flowers, purchases,
   * names, outfits within SAVE_DELAY_MS; online time counting (`minor`, every
   * few seconds for everyone online) within MINOR_SAVE_DELAY_MS, or with the
   * next important write. Guest wallets are never saved.
   */
  function save(uid, minor = false) {
    if (isGuestId(uid)) return;
    dirty.add(uid);
    const delay = minor ? MINOR_SAVE_DELAY_MS : SAVE_DELAY_MS;
    const at = Date.now() + delay;
    if (saveTimer && saveAt <= at) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveAt = at;
    saveTimer = setTimeout(writeJournal, delay);
  }

  /** Append the changed accounts to the journal; compact once it has grown large. */
  function writeJournal() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    saveAt = Infinity;
    if (dirty.size) {
      let out = '';
      for (const uid of dirty) if (wallets[uid]) out += JSON.stringify({ u: uid, w: wallets[uid] }) + '\n';
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(journalFile, out);
        journalBytes += Buffer.byteLength(out);
        dirty.clear();
      } catch (err) {
        log(`could not write ${journalFile}: ${err}`);
        save([...dirty][0]); // keep them dirty, try again soon
        return;
      }
    }
    // Rewriting everything costs about 7 ms per 1000 accounts: only once the
    // journal is bigger than the snapshot (and a few MB), so it stays rare.
    if (journalBytes > Math.max(COMPACT_MIN_BYTES, snapshotBytes * COMPACT_RATIO)) compact();
  }

  /**
   * Full snapshot, then an empty journal. The journal was written first, so a
   * crash between the two only replays entries the snapshot already has.
   */
  function compact() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = JSON.stringify({ version: 1, wallets });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
      fs.writeFileSync(journalFile, '');
      snapshotBytes = Buffer.byteLength(text);
      journalBytes = 0;
    } catch (err) {
      log(`could not compact ${file}: ${err}`);
    }
  }

  /** Write everything now (shutdown): pending changes, then a fresh snapshot. */
  function flush() {
    writeJournal();
    if (journalBytes > 0) compact();
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
            if (!lastAccrual.has(id) && !isLive(id)) {
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

  function give(uid, w, flowers) {
    w.flowers += flowers;
    w.earned += flowers;
    save(uid);
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
    save(uid, true); // online time: a minor change
    if (w.stage >= ONLINE_TIERS.length) return false;
    const goal = tierMs(w.stage);
    if (w.stageMs >= goal) return false; // reached, waiting to be claimed
    w.stageMs = Math.min(goal, w.stageMs + delta * (rates.get(uid) ?? 1));
    return w.stageMs >= goal;
  }

  // Write the migrated wallets (items renamed above) to the journal.
  for (const uid of migrated) save(uid);
  if (migrated.length) log(`${migrated.length} wallets: removed items replaced (${Object.entries(RENAMED_ITEMS).map(([a, b]) => `${a} → ${b}`).join(", ")})`);

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
      rates.delete(uid);
    },
    /**
     * Share of online time that counts towards milestones from now on (many
     * wallets earning from one network count slower, see realm.mjs). Time so
     * far is credited at the old rate first.
     */
    setRate(uid, rate, now = Date.now()) {
      if ((rates.get(uid) ?? 1) === rate) return;
      accrue(uid, now);
      if (rate === 1) rates.delete(uid);
      else rates.set(uid, rate);
    },
    rate: (uid) => rates.get(uid) ?? 1,
    /** Accounts being counted right now. */
    onlineUids: () => [...lastAccrual.keys()],
    /** Whether `uid`'s online time is being counted. */
    counting: (uid) => lastAccrual.has(uid),
    accrue,

    /** @returns {{ ok: true, flowers: number } | { ok: false, error: 'already' }} */
    checkIn(uid, now = Date.now()) {
      const w = wallet(uid, now);
      if (w.checkins.includes(w.day)) return { ok: false, error: 'already' };
      const flowers = checkinReward(weekdayOf(now));
      w.checkins = [...w.checkins, w.day].slice(-KEEP_CHECKINS);
      give(uid, w, flowers);
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
      give(uid, w, t.flowers);
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
      save(uid);
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
      save(uid);
      return { ok: true, price };
    },

    /**
     * The account holding display name `key` (compare form), or '' when free:
     * a name stays with the account that last used it for NAME_HOLD_MS, so
     * nobody can take it while its owner is offline.
     */
    nameOwner(key, now = Date.now()) {
      const uid = nameIndex.get(key);
      const w = uid ? wallets[uid] : undefined;
      return w && now - (w.nameAt ?? 0) < NAME_HOLD_MS ? uid : '';
    },

    /** Account `uid` uses display name `key` (compare form): it holds it from now on. */
    claimName(uid, key, now = Date.now()) {
      if (isGuestId(uid)) return;
      const w = wallet(uid, now);
      if (w.nameKey && w.nameKey !== key && nameIndex.get(w.nameKey) === uid) nameIndex.delete(w.nameKey);
      w.nameKey = key;
      w.nameAt = now;
      nameIndex.set(key, uid);
      save(uid);
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
      save(uid);
      log(`guest wallet moved to ${uid} (${moved.flowers} flowers, ${moved.owned.length} items)`);
      return 'adopted';
    },

    /** Forget guest wallets nobody used for a while (and not online now). */
    sweepGuests(now = Date.now()) {
      for (const [id, w] of guests) if (now - w.seen > GUEST_IDLE_MS && !lastAccrual.has(id) && !isLive(id)) guests.delete(id);
    },

    setOutfit(uid, outfit, now = Date.now()) {
      const w = wallet(uid, now);
      if (JSON.stringify(w.outfit) === JSON.stringify(outfit)) return;
      w.outfit = outfit;
      save(uid);
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
        /** Share of online time counted (below 1: many wallets earn from this network). */
        rate: rates.get(uid) ?? 1,
        tiers: ONLINE_TIERS.map((t, i) => ({ minutes: t.minutes, flowers: t.flowers, claimed: i < w.stage })),
        owned: w.owned,
      };
    },

    flush,
  };
}
