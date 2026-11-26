// Shop & bag panel (nav bag button): two tabs.
//   - Cửa hàng: items for sale by shelf (clothes, shoes, accessories, picnic),
//     priced in flowers (admin config). Buying takes two clicks (buy → confirm).
//   - Túi đồ: what the account bought: put on / take off clothes, use picnic items.
// The relay decides every purchase (server/realm.mjs onShop) and answers with a
// WALLET carrying a `shop` result; this only shows state and sends requests.

import { events } from '../core/events';
import { EMOTES } from '../scene/emotes';
import { DEFAULT_OUTFIT, sanitizeOutfit, type Outfit } from '../scene/appearance';
import { CATEGORIES, ITEM_BY_ID, SHOP_ITEMS, itemForEmote, slotOfItem, type CatalogItem, type CategoryId } from '../shop/catalog';
import { flowerBalance, isSignedIn, ownedItems, owns, priceOf } from '../shop/inventory';
import { isConnected } from '../social/presence';
import { addPanelBar } from './panelBar';

export const bagIcon =
  '<svg class="bag" viewBox="0 0 20 20" aria-hidden="true"><path d="M6.5 6V5a3.5 3.5 0 0 1 7 0v1h2.3c.6 0 1 .4 1.1 1l.9 10.3c.1.9-.6 1.7-1.5 1.7H3.7c-.9 0-1.6-.8-1.5-1.7L3.1 7c.1-.6.5-1 1.1-1Zm1.8 0h3.4V5a1.7 1.7 0 0 0-3.4 0Z" fill="#716C66"/><circle cx="7.4" cy="9.3" r="1" fill="#f9efdc"/><circle cx="12.6" cy="9.3" r="1" fill="#f9efdc"/></svg>';

const CONFIRM_MS = 4000;
const PENDING_MS = 8000;
const TOAST_MS = 4000;

const ERRORS: Record<string, string> = {
  login: 'Đăng nhập để mua nhé.',
  owned: 'Bạn đã có món này rồi.',
  poor: 'Chưa đủ hoa. Điểm danh và online để nhận thêm 🌸',
  disabled: 'Món này đã ngừng bán.',
  item: 'Không tìm thấy món này.',
  offline: 'Chưa kết nối được máy chủ.',
};

interface ShopResult {
  shop: true;
  item: string;
  ok: boolean;
  error?: string;
  price?: number;
}

const flowers = (n: number) => `${n} 🌸`;
const categoryLabel = (id?: CategoryId) => CATEGORIES.find((c) => c.id === id)?.label ?? '';
const emoteOf = (item: CatalogItem) => (item.emote === undefined ? -1 : EMOTES.findIndex((e) => e.state === item.emote));

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export class ShopPanel {
  private readonly panel: HTMLDivElement;
  /** Rebuilt on render; the title bar above it stays. */
  private readonly content: HTMLDivElement;
  private tab: 'shop' | 'bag' = 'shop';
  private filter: CategoryId | 'all' = 'all';
  private outfit: Outfit = [...DEFAULT_OUTFIT];
  /** First click on "Mua" arms it; a second click within CONFIRM_MS buys. */
  private confirm = { id: '', until: 0 };
  private pending = { id: '', until: 0 };
  private toast = { text: '', until: 0 };
  /** Item to point out after opening from a lock (picker, emote). */
  private highlight = '';
  private html = '';
  private timer = 0;

  /** `openLogin` shows the sign-in dialog. */
  constructor(nav: HTMLElement, private readonly button: HTMLButtonElement, private readonly openLogin: () => void) {
    this.panel = document.createElement('div');
    this.panel.className = 'look-menu shop-menu';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Cửa hàng và túi đồ');
    nav.append(this.panel);
    this.content = addPanelBar(this.panel, 'Cửa hàng & túi đồ', () => this.setOpen(false));

    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('click', () => this.setOpen(!this.isOpen));
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.contains(e.target as Node) && !button.contains(e.target as Node)) this.setOpen(false);
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') this.setOpen(false);
    });
    this.panel.addEventListener('click', (e) => this.onClick(e.target as HTMLElement));

    events.on('inventory_changed', () => this.render());
    events.on('mp_connected', () => this.render());
    events.on('mp_disconnected', () => this.render());
    events.on('webgl_character_update_outfit', (outfit: Outfit) => {
      this.outfit = sanitizeOutfit(outfit);
      this.render();
    });
    events.on('mp_wallet', (wallet: { result?: ShopResult | { shop?: undefined } } | null) => {
      const result = wallet?.result;
      if (result?.shop) this.onResult(result);
    });
    /** Open the shop on an item (locked outfit / emote), or just open it. */
    events.on('shop_open', (id?: string) => this.openAt(id));
    events.on('webgl_emote_locked', (state: number) => {
      const item = itemForEmote(state);
      if (item) this.openAt(item.id, `${item.label} cần mua ở cửa hàng trước nhé.`);
    });
    this.render();
  }

  private get isOpen() {
    return this.panel.classList.contains('open');
  }

  private setOpen(open: boolean) {
    this.panel.classList.toggle('open', open);
    this.button.setAttribute('aria-expanded', String(open));
    window.clearInterval(this.timer);
    if (open) {
      events.emit('mp_reward', 0); // fresh wallet (REWARD_STATUS)
      // Confirmations, toasts and pending purchases expire.
      this.timer = window.setInterval(() => this.render(), 500);
    } else {
      this.highlight = '';
      this.confirm.id = '';
    }
    this.render();
  }

  private openAt(id?: string, message?: string) {
    const item = id ? ITEM_BY_ID[id] : undefined;
    if (item?.category) {
      this.tab = owns(item.id) ? 'bag' : 'shop';
      this.filter = this.tab === 'shop' ? item.category : 'all';
      this.highlight = item.id;
    }
    if (message) this.say(message);
    if (!this.isOpen) this.setOpen(true);
    else this.render();
    this.panel.querySelector('.highlight')?.scrollIntoView({ block: 'nearest' });
  }

  private say(text: string) {
    this.toast = { text, until: performance.now() + TOAST_MS };
  }

  private onClick(target: HTMLElement) {
    const button = target.closest<HTMLButtonElement>('button');
    if (!button || button.disabled) return;
    const d = button.dataset;
    if (d.login !== undefined) {
      this.setOpen(false);
      this.openLogin();
    } else if (d.tab) {
      this.tab = d.tab === 'bag' ? 'bag' : 'shop';
      this.highlight = '';
    } else if (d.filter) {
      this.filter = d.filter as CategoryId | 'all';
      this.highlight = '';
    } else if (d.buy) {
      this.buy(d.buy);
    } else if (d.equip) {
      this.wear(d.equip, true);
    } else if (d.unequip) {
      this.wear(d.unequip, false);
    } else if (d.use) {
      const slot = emoteOf(ITEM_BY_ID[d.use]);
      if (slot >= 0) {
        this.setOpen(false);
        events.emit('webgl_character_emote', slot + 1);
      }
      return;
    }
    this.render();
  }

  private buy(id: string) {
    const now = performance.now();
    if (this.confirm.id !== id || now > this.confirm.until) {
      this.confirm = { id, until: now + CONFIRM_MS };
      return;
    }
    this.confirm.id = '';
    const { price } = priceOf(id);
    events.emit('mp_shop_buy', id, price, (sent: boolean) => {
      if (sent) this.pending = { id, until: performance.now() + PENDING_MS };
      else this.say(ERRORS.offline);
    });
  }

  /** Put an item on (or back to the slot default). */
  private wear(id: string, on: boolean) {
    const at = slotOfItem(id);
    if (!at) return;
    const next = [...this.outfit];
    next[at.index] = on ? at.item : 0;
    events.emit('webgl_character_outfit', sanitizeOutfit(next));
  }

  private onResult(result: ShopResult) {
    if (this.pending.id === result.item) this.pending.id = '';
    const item = ITEM_BY_ID[result.item];
    const label = item?.label ?? result.item;
    if (result.ok) {
      const slot = item ? emoteOf(item) : -1;
      if (slotOfItem(result.item)) {
        this.wear(result.item, true); // try it on right away
        this.say(`Đã mua ${label}! Đang mặc thử ✓`);
      } else {
        this.say(`Đã mua ${label}! ${slot >= 0 ? `Bấm Dùng hoặc phím ${EMOTES[slot].key}.` : ''}`);
      }
      this.button.classList.remove('rewarded');
      void this.button.offsetWidth; // restart the animation
      this.button.classList.add('rewarded');
    } else if (result.error === 'price') {
      this.say(`Giá ${label} vừa đổi${result.price !== undefined ? ` thành ${flowers(result.price)}` : ''}, xem lại nhé.`);
    } else {
      this.say(ERRORS[result.error ?? ''] ?? 'Chưa mua được, thử lại nhé.');
    }
    this.render();
  }

  private render() {
    if (!this.isOpen) return;
    // Rebuilt only when something shown changed (a rebuild mid-click would eat the click).
    const html = this.buildHtml();
    if (html !== this.html) this.content.innerHTML = this.html = html;
  }

  private buildHtml(): string {
    const now = performance.now();
    const signedIn = isSignedIn();
    const bag = ownedItems();
    const head = signedIn
      ? `<div class="look-group shop-head"><span>Hoa của bạn</span><b class="rewards-balance">${flowers(flowerBalance())}</b></div>`
      : `<div class="look-group shop-head"><p class="rewards-note">${isConnected() ? 'Đăng nhập để mua đồ bằng hoa 🌸' : 'Đang kết nối máy chủ…'}</p>${isConnected() ? '<button type="button" class="primary" data-login>Đăng nhập</button>' : ''}</div>`;
    const tabs = `<div class="shop-tabs" role="tablist">
        <button type="button" role="tab" data-tab="shop" aria-selected="${this.tab === 'shop'}">Cửa hàng</button>
        <button type="button" role="tab" data-tab="bag" aria-selected="${this.tab === 'bag'}">Túi đồ${bag.length ? ` (${bag.length})` : ''}</button>
      </div>`;
    const body = this.tab === 'shop' ? this.shopHtml(now, signedIn) : this.bagHtml(bag);
    const toast = now < this.toast.until ? escapeHtml(this.toast.text) : '';
    return `${head}${tabs}${body}<p class="rewards-toast" aria-live="polite">${toast}</p>`;
  }

  private shopHtml(now: number, signedIn: boolean): string {
    const filters = [{ id: 'all', label: 'Tất cả' }, ...CATEGORIES]
      .map((c) => `<button type="button" data-filter="${c.id}" aria-pressed="${this.filter === c.id}">${c.label}</button>`)
      .join('');
    const balance = flowerBalance();
    const cards = SHOP_ITEMS.filter((it) => (this.filter === 'all' || it.category === this.filter) && (owns(it.id) || priceOf(it.id).enabled))
      .map((it) => {
        const { price } = priceOf(it.id);
        let action: string;
        if (owns(it.id)) {
          action = '<button type="button" disabled>Đã có ✓</button>';
        } else if (!signedIn) {
          action = `<button type="button" disabled>${flowers(price)}</button>`;
        } else if (this.pending.id === it.id && now < this.pending.until) {
          action = '<button type="button" disabled>Đang mua…</button>';
        } else if (balance < price) {
          action = `<button type="button" disabled title="Giá ${flowers(price)}">Thiếu ${flowers(price - balance)}</button>`;
        } else if (this.confirm.id === it.id && now < this.confirm.until) {
          action = `<button type="button" class="primary confirm" data-buy="${it.id}">${price ? `Trả ${flowers(price)}?` : 'Nhận nhé?'}</button>`;
        } else {
          action = `<button type="button" class="primary" data-buy="${it.id}">${price ? `Mua ${flowers(price)}` : 'Nhận miễn phí'}</button>`;
        }
        return this.card(it, categoryLabel(it.category), action);
      })
      .join('');
    return `<div class="shop-filters">${filters}</div><ul class="shop-grid">${cards || '<li class="shop-empty">Chưa có món nào.</li>'}</ul>
      <p class="rewards-note">Bấm Mua rồi bấm lần nữa để xác nhận. Đồ đã mua dùng mãi mãi.</p>`;
  }

  private bagHtml(bag: string[]): string {
    if (!bag.length) {
      return `<p class="rewards-note shop-empty">Túi đồ còn trống. Ghé <button type="button" class="link" data-tab="shop">Cửa hàng</button> nhé!</p>`;
    }
    return CATEGORIES.map((c) => {
      const items = SHOP_ITEMS.filter((it) => it.category === c.id && bag.includes(it.id));
      if (!items.length) return '';
      const cards = items
        .map((it) => {
          const at = slotOfItem(it.id);
          let action: string;
          if (at) {
            const worn = this.outfit[at.index] === at.item;
            action = worn
              ? `<button type="button" aria-pressed="true" data-unequip="${it.id}" title="Bấm để tháo">Đang mặc</button>`
              : `<button type="button" class="primary" data-equip="${it.id}">Mặc</button>`;
          } else {
            const slot = emoteOf(it);
            action = `<button type="button" class="primary" data-use="${it.id}">Dùng${slot >= 0 ? ` <kbd>${EMOTES[slot].key}</kbd>` : ''}</button>`;
          }
          return this.card(it, at ? at.slot.label : 'Phím tắt / menu biểu cảm', action);
        })
        .join('');
      return `<div class="look-group"><span>${c.label}</span><ul class="shop-grid">${cards}</ul></div>`;
    }).join('');
  }

  private card(it: CatalogItem, subtitle: string, action: string): string {
    return `<li class="shop-card${this.highlight === it.id ? ' highlight' : ''}" data-item="${it.id}">
        <span class="shop-icon" aria-hidden="true">${it.icon ?? '🎁'}</span>
        <b>${escapeHtml(it.label)}</b><small>${escapeHtml(subtitle)}</small>${action}
      </li>`;
  }
}
