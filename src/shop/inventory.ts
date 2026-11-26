// What the local player owns (from the relay's WALLET messages) and what the
// shop sells at which price (admin config, live). The relay decides: this is
// only for showing locks and prices; it checks everything again.
//
// Events: 'inventory_changed' when ownership or prices change.

import { events } from '../core/events';
import { watchConfig } from '../config/store';
import { ITEM_BY_ID, itemForEmote, normalizePrice, DEFAULT_PRICE } from './catalog';

let owned = new Set<string>();
let signedIn = false;
let flowers = 0;
let prices: Record<string, { price: number; enabled: boolean }> = {};

const changed = () => events.emit('inventory_changed');

events.on('mp_wallet', (wallet: { owned?: unknown; flowers?: unknown } | null) => {
  const next = new Set(Array.isArray(wallet?.owned) ? wallet.owned.filter((id): id is string => typeof id === 'string') : []);
  const nextFlowers = typeof wallet?.flowers === 'number' ? wallet.flowers : 0;
  const same = signedIn === !!wallet && flowers === nextFlowers && next.size === owned.size && [...next].every((id) => owned.has(id));
  owned = next;
  signedIn = !!wallet;
  flowers = nextFlowers;
  if (!same) changed();
});
events.on('mp_disconnected', () => {
  owned = new Set();
  signedIn = false;
  flowers = 0;
  changed();
});
watchConfig((config) => {
  const json = JSON.stringify(config.shop.items);
  if (json === JSON.stringify(prices)) return;
  prices = JSON.parse(json);
  changed();
});

/** Signed in (the relay sent a wallet). */
export const isSignedIn = () => signedIn;
export const flowerBalance = () => flowers;

/** Free items and bought ones. */
export function owns(id: string): boolean {
  return !!ITEM_BY_ID[id]?.free || owned.has(id);
}

/** Bought items (sold items only), in purchase order. */
export const ownedItems = () => [...owned].filter((id) => ITEM_BY_ID[id]);

export function priceOf(id: string): { price: number; enabled: boolean } {
  const p = prices[id];
  return { price: p ? normalizePrice(p.price) : DEFAULT_PRICE, enabled: p ? p.enabled !== false : true };
}

/** Whether the local player may play animation state `state`. */
export function canUseEmote(state: number): boolean {
  const item = itemForEmote(state);
  return !item || owns(item.id);
}
