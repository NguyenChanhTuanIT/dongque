// Wardrobe ("Tủ đồ" tab of the character panel): every item the player has —
// free basics and bought ones, clothes, accessories and picnic items — in one
// grid of pictures, ordered by type (slot order of the catalog, picnic items
// last). Clothes: click to put on, click the worn one again to take it off.
// Picnic items: click to play their emote. Hair lives in the Nhân vật tab.
// Buying stays in the shop (components/shop.ts).

import { events } from '../core/events';
import { EMOTES } from '../scene/emotes';
import { DEFAULT_OUTFIT, SLOTS, sanitizeOutfit, type Outfit } from '../scene/appearance';
import { ITEM_BY_ID, SHOP_ITEMS, slotOfItem, type CatalogItem } from '../shop/catalog';
import { ownedItems, owns } from '../shop/inventory';
import { cardIcon } from './itemIcons';

const emoteOf = (item: CatalogItem) => (item.emote === undefined ? -1 : EMOTES.findIndex((e) => e.state === item.emote));

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** All wearable / usable items in display order: by slot (hair excluded), then picnic items. */
const ORDER: string[] = [
  ...SLOTS.filter((s) => s.id !== 'hair').flatMap((s) => s.items.map((it) => it.id).filter((id) => !id.endsWith('.none'))),
  ...SHOP_ITEMS.filter((it) => !slotOfItem(it.id)).map((it) => it.id),
];

export class Wardrobe {
  /** The item grid; rebuilt on render. */
  readonly root: HTMLDivElement;
  /** Link to the shop, shown under the clothes colour row. */
  readonly footer: HTMLParagraphElement;
  private outfit: Outfit = [...DEFAULT_OUTFIT];
  private html = '';
  /** Item to point out (opened from the shop on an owned item). */
  highlight = '';

  /** `onUse` runs before a picnic item's emote plays (the panel closes). */
  constructor(private readonly onUse: () => void) {
    this.root = document.createElement('div');
    this.root.className = 'look-group wardrobe-items';
    this.root.addEventListener('click', (e) => this.onClick(e.target as HTMLElement));
    this.footer = document.createElement('p');
    this.footer.className = 'rewards-note shop-empty';
    this.footer.innerHTML = 'Mua thêm quần áo, phụ kiện và đồ dã ngoại ở <button type="button" class="link" data-shop>Cửa hàng</button> nhé!';
    this.footer.addEventListener('click', (e) => this.onClick(e.target as HTMLElement));

    events.on('inventory_changed', () => this.render());
    events.on('webgl_character_update_outfit', (outfit: Outfit) => {
      this.outfit = sanitizeOutfit(outfit);
      this.render();
    });
    this.render();
  }

  /** Number of bought items (for the tab label). */
  get count(): number {
    return ownedItems().length;
  }

  render() {
    const html = this.buildHtml();
    // Rebuilt only when something shown changed (a rebuild mid-click would eat the click).
    if (html !== this.html) this.root.innerHTML = this.html = html;
  }

  private onClick(target: HTMLElement) {
    const button = target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    if (button.dataset.shop !== undefined) {
      this.onUse();
      events.emit('shop_open');
      return;
    }
    const id = button.dataset.item;
    if (!id || !owns(id)) return;
    const at = slotOfItem(id);
    if (at) {
      // Click the worn item again to take it off (back to the slot default).
      const next = [...this.outfit];
      next[at.index] = this.outfit[at.index] === at.item ? 0 : at.item;
      events.emit('webgl_character_outfit', sanitizeOutfit(next));
      return;
    }
    const slot = emoteOf(ITEM_BY_ID[id]);
    if (slot >= 0) {
      this.onUse();
      events.emit('webgl_character_emote', slot + 1);
    }
  }

  private buildHtml(): string {
    return ORDER.filter(owns)
      .map((id) => {
        const it = ITEM_BY_ID[id];
        const label = it?.label ?? id;
        const at = slotOfItem(id);
        const worn = !!at && this.outfit[at.index] === at.item;
        const slot = it ? emoteOf(it) : -1;
        const title = at ? (worn && at.item !== 0 ? `${label} (bấm để tháo)` : label) : `${label}: dùng${slot >= 0 ? ` (phím ${EMOTES[slot].key})` : ''}`;
        return `<button type="button" class="look-item${this.highlight === id ? ' highlight' : ''}" data-item="${id}" aria-pressed="${worn}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${cardIcon(it ?? { id })}</button>`;
      })
      .join('');
  }
}
