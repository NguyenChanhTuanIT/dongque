// Shop panel (nav bag button): items for sale by shelf (clothes, shoes,
// accessories, picnic), priced in flowers (admin config). Buying takes two
// clicks (buy → confirm). What the account owns is worn / used from the
// "Tủ đồ" tab of the character panel (components/wardrobe.ts).
// The relay decides every purchase (server/realm.mjs onShop) and answers with a
// WALLET carrying a `shop` result; this only shows state and sends requests.

import { events } from '../core/events';
import { EMOTES } from '../scene/emotes';
import { DEFAULT_OUTFIT, sanitizeOutfit, type Outfit } from '../scene/appearance';
import { CATEGORIES, ITEM_BY_ID, SHOP_ITEMS, slotOfItem, type CatalogItem, type CategoryId } from '../shop/catalog';
import { flowerBalance, isGuest, isSignedIn, owns, priceOf } from '../shop/inventory';
import { guestWarning } from './guestNote';
import { isConnected } from '../social/presence';
import { addPanelBar } from './panelBar';
import { mountPanelModal } from './overlay';
import { cardIcon } from './itemIcons';

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
  /** Shows / hides the centred modal card around the panel (see overlay.ts). */
  private readonly showModal: (open: boolean) => void;
  /** Rebuilt on render; the title bar above it stays. */
  private readonly content: HTMLDivElement;
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

  /** `openAuth` shows the sign-in dialog (login or sign-up tab). */
  constructor(nav: HTMLElement, private readonly button: HTMLButtonElement, private readonly openAuth: (mode: 'login' | 'register') => void) {
    this.panel = document.createElement('div');
    this.panel.className = 'look-menu shop-menu';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Cửa hàng');
    this.showModal = mountPanelModal(this.panel, nav.parentElement ?? nav);
    this.content = addPanelBar(this.panel, 'Cửa hàng', () => this.setOpen(false));

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
    /** Open the shop on an item (from the "Bạn cần có…" notice, the wardrobe), or just open it. */
    events.on('shop_open', (id?: string) => this.openAt(id));
    this.render();
  }

  private get isOpen() {
    return this.panel.classList.contains('open');
  }

  private setOpen(open: boolean) {
    this.panel.classList.toggle('open', open);
    this.showModal(open);
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
    if (item && owns(item.id)) {
      // Already bought: it is worn / used from the wardrobe.
      this.setOpen(false);
      events.emit('wardrobe_open', item.id);
      return;
    }
    if (item?.category) {
      this.filter = item.category;
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
    if (d.login !== undefined || d.register !== undefined) {
      this.setOpen(false);
      this.openAuth(d.register !== undefined ? 'register' : 'login');
    } else if (d.filter) {
      this.filter = d.filter as CategoryId | 'all';
      this.highlight = '';
    } else if (d.buy) {
      this.buy(d.buy);
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
        this.say(`Đã mua ${label}! ${slot >= 0 ? `Dùng trong Tủ đồ (nút nhân vật) hoặc phím ${EMOTES[slot].key}.` : ''}`);
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
    const head = signedIn
      ? `${isGuest() ? guestWarning() : ''}<div class="look-group shop-head"><span>Hoa của bạn</span><b class="rewards-balance">${flowers(flowerBalance())}</b></div>`
      : `<div class="look-group shop-head"><p class="rewards-note">${isConnected() ? 'Đăng nhập để mua đồ bằng hoa 🌸' : 'Đang kết nối máy chủ…'}</p>${isConnected() ? '<button type="button" class="primary" data-login>Đăng nhập</button>' : ''}</div>`;
    const body = this.shopHtml(now, signedIn);
    const toast = now < this.toast.until ? escapeHtml(this.toast.text) : '';
    return `${head}${body}<p class="rewards-toast" aria-live="polite">${toast}</p>`;
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

  private card(it: CatalogItem, subtitle: string, action: string): string {
    return `<li class="shop-card${this.highlight === it.id ? ' highlight' : ''}" data-item="${it.id}">
        <span class="shop-icon" aria-hidden="true">${cardIcon(it)}</span>
        <b>${escapeHtml(it.label)}</b><small>${escapeHtml(subtitle)}</small>${action}
      </li>`;
  }
}
