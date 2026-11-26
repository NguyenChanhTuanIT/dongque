// Shop for the relay: the catalog (shared/shop-catalog.json, the same file the
// game reads), outfit checks (only free or owned items are shown to others)
// and the price list.
//
// Prices are edited in the admin panel and stored in the public Firestore
// document `config/scene` (field shop.items.<id> = { price, enabled }). The
// relay reads it through the Firestore REST API without credentials (the
// rules let anyone read config), caches it for PRICE_TTL_MS, and refetches on
// demand when a buyer saw a different price.

import fs from 'node:fs';

export const DEFAULT_PRICE = 1;
const PRICE_TTL_MS = 30_000;
/** Least time between two forced refetches. */
const MIN_REFETCH_MS = 2_000;

/**
 * @typedef {{ id: string, label: string, free?: boolean, category?: string, icon?: string, emote?: number }} CatalogItem
 * @typedef {{ id: string, label: string, items: string[] }} CatalogSlot
 */

/** @param {string} [file] */
export function loadCatalog(file = new URL('../shared/shop-catalog.json', import.meta.url)) {
  /** @type {{ slots: CatalogSlot[], items: CatalogItem[] }} */
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  /** @type {Map<string, CatalogItem>} */
  const items = new Map(data.items.map((it) => [it.id, it]));
  const slots = data.slots;
  /** Animation state → item id that unlocks it. */
  const emoteItems = new Map(data.items.filter((it) => Number.isInteger(it.emote)).map((it) => [/** @type {number} */ (it.emote), it.id]));
  const forSale = data.items.filter((it) => !it.free && it.category);

  /**
   * The outfit others may see: one byte per catalog slot, items the player
   * cannot wear (unknown, not free, not owned) replaced by the slot default (0).
   * Extra slots from newer clients are dropped.
   * @param {Uint8Array} wanted  item index per slot
   * @param {(id: string) => boolean} owns
   */
  function filterOutfit(wanted, owns) {
    const out = new Uint8Array(slots.length);
    slots.forEach((slot, s) => {
      const id = s < wanted.length ? slot.items[wanted[s]] : undefined;
      const item = id ? items.get(id) : undefined;
      out[s] = item && (item.free || owns(item.id)) ? wanted[s] : 0;
    });
    return out;
  }

  /** Outfit bytes → { slotId: itemId } (what the wallet keeps). */
  function outfitIds(bytes) {
    /** @type {Record<string, string>} */
    const out = {};
    slots.forEach((slot, s) => {
      const id = slot.items[bytes[s] ?? 0];
      if (id) out[slot.id] = id;
    });
    return out;
  }

  /** { slotId: itemId } → outfit bytes (unknown ids = slot default). */
  function outfitBytes(ids) {
    return Uint8Array.from(slots.map((slot) => Math.max(0, slot.items.indexOf(ids?.[slot.id] ?? ''))));
  }

  return { items, slots, emoteItems, forSale, filterOutfit, outfitIds, outfitBytes };
}

/** Whole flowers, 0 … 1e6 (anything else: the default price). */
export function normalizePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1_000_000, Math.max(0, Math.round(n))) : DEFAULT_PRICE;
}

/**
 * @param {object} options
 * @param {string} options.projectId  Firebase project ('' = always the default prices).
 * @param {string[]} options.ids      Items for sale.
 * @param {(msg: string) => void} [options.log]
 * @param {typeof fetch} [options.fetch]
 */
export function createPriceBook({ projectId, ids, log = (msg) => console.log(`[shop] ${msg}`), fetch: fetchImpl = globalThis.fetch }) {
  /** @type {Map<string, { price: number, enabled: boolean }>} */
  let prices = new Map(ids.map((id) => [id, { price: DEFAULT_PRICE, enabled: true }]));
  let fetchedAt = 0;
  /** @type {Promise<void> | null} */
  let inflight = null;
  const url = projectId
    ? `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/config/scene?mask.fieldPaths=shop`
    : '';

  /** Firestore REST value → JS number / boolean. */
  const num = (v) => (v?.integerValue !== undefined ? Number(v.integerValue) : v?.doubleValue);
  const bool = (v) => v?.booleanValue;

  async function refresh() {
    if (!url) return;
    try {
      const res = await fetchImpl(url);
      // 404: no config saved yet → defaults.
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      const doc = res.ok ? await res.json() : {};
      const fields = doc?.fields?.shop?.mapValue?.fields?.items?.mapValue?.fields ?? {};
      const next = new Map();
      for (const id of ids) {
        const f = fields[id]?.mapValue?.fields;
        const price = num(f?.price);
        const enabled = bool(f?.enabled);
        next.set(id, { price: price === undefined ? DEFAULT_PRICE : normalizePrice(price), enabled: enabled ?? true });
      }
      prices = next;
    } catch (err) {
      // Keep the last known prices.
      log(`could not read prices: ${err instanceof Error ? err.message : err}`);
    } finally {
      fetchedAt = Date.now();
    }
  }

  function load(force) {
    const age = Date.now() - fetchedAt;
    if (!inflight && (age > PRICE_TTL_MS || (force && age > MIN_REFETCH_MS))) {
      inflight = refresh().finally(() => {
        inflight = null;
      });
    }
    return inflight ?? Promise.resolve();
  }

  return {
    /**
     * Current offer for `id` (undefined = not for sale at all).
     * `fresh` refetches unless the list was read in the last couple of seconds.
     */
    async get(id, fresh = false) {
      await load(fresh);
      return prices.get(id);
    },
    /** Start loading now (so the first purchase does not wait). */
    warm: () => void load(false),
  };
}
