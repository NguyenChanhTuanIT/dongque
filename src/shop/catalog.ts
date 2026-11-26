// Typed view of the shop catalog (shared/shop-catalog.json, also read by the
// relay in server/shop.mjs). Prices are not here: they live in the admin
// config (`config/scene` → shop.items), see priceOf() in inventory.ts.

import data from '../../shared/shop-catalog.json';

export type CategoryId = 'outfit' | 'shoes' | 'accessory' | 'picnic';
export type SlotId = 'hat' | 'hair' | 'top' | 'bottom' | 'shoes' | 'glasses' | 'necklace';

export interface CatalogItem {
  id: string;
  label: string;
  /** Everyone has it: never sold, never locked. */
  free?: boolean;
  /** Shop shelf (sold items only). */
  category?: CategoryId;
  icon?: string;
  /** Network animation state this item unlocks (picnic items). */
  emote?: number;
}

export interface CatalogSlot {
  id: SlotId;
  label: string;
  /** Item ids; the index is what travels on the wire. Item 0 is the default. */
  items: string[];
}

export const CATEGORIES = data.categories as Array<{ id: CategoryId; label: string }>;
export const CATALOG_SLOTS = data.slots as CatalogSlot[];
export const ITEMS = data.items as CatalogItem[];
export const ITEM_BY_ID: Record<string, CatalogItem> = Object.fromEntries(ITEMS.map((it) => [it.id, it]));

/** Items for sale, in catalog order. */
export const SHOP_ITEMS = ITEMS.filter((it) => !it.free && it.category);

/** Slot that wears this item (undefined for picnic items). */
export function slotOfItem(id: string): { slot: CatalogSlot; index: number; item: number } | undefined {
  for (let s = 0; s < CATALOG_SLOTS.length; s++) {
    const item = CATALOG_SLOTS[s].items.indexOf(id);
    if (item >= 0) return { slot: CATALOG_SLOTS[s], index: s, item };
  }
  return undefined;
}

/** The sold item that unlocks animation state `state`, if any. */
export function itemForEmote(state: number): CatalogItem | undefined {
  return ITEMS.find((it) => it.emote === state);
}

export const DEFAULT_PRICE = 1;
/** Clamp an admin-entered price: whole flowers, 0 … 1e6. */
export function normalizePrice(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1_000_000, Math.max(0, Math.round(n))) : DEFAULT_PRICE;
}
