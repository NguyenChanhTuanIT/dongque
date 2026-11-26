// "Lưu dữ liệu của bạn" modal for guests (players without an account): their
// flowers and items live in a guest wallet that only lasts as long as the
// browser tab (server/wallets.mjs "Guests"). Browsers do not let a page show
// its own dialog when the tab is closing (beforeunload only allows the
// browser's generic prompt), so this game-styled modal warns *before* there is
// anything to lose: the first time the guest wallet gets flowers or an item
// (once per tab), and whenever the game asks for it (open()).

import { events } from '../core/events';
import { guestHasProgress, flowerBalance, ownedItems } from '../shop/inventory';
import { addPanelBar } from './panelBar';
import { mountPanelModal } from './overlay';
import { isLoginAvailable } from '../social/auth';

const SHOWN_KEY = 'relaxtime-guest-warned';

export class GuestSaveModal {
  private readonly panel: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private readonly showModal: (open: boolean) => void;

  /** `openRegister` / `openLogin` show the sign-in dialog on its sign-up / login tab. */
  constructor(host: HTMLElement, private readonly openRegister: () => void, private readonly openLogin: () => void) {
    this.panel = document.createElement('div');
    this.panel.className = 'look-menu guest-modal';
    this.panel.setAttribute('role', 'alertdialog');
    this.panel.setAttribute('aria-label', 'Lưu dữ liệu của bạn');
    this.showModal = mountPanelModal(this.panel, host);
    this.content = addPanelBar(this.panel, 'Lưu dữ liệu của bạn', () => this.close());
    this.panel.closest('.nav-modal')?.querySelector('.close-hit')?.addEventListener('click', () => this.close());
    this.panel.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-choice]');
      if (!button) return;
      const choice = button.dataset.choice;
      this.close();
      if (choice === 'register') this.openRegister();
      else if (choice === 'login') this.openLogin();
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') this.close();
    });

    // First progress of the guest wallet in this tab: warn once (reloads included).
    events.on('inventory_changed', () => {
      if (!guestHasProgress() || this.alreadyShown()) return;
      this.markShown();
      this.open();
    });
  }

  open() {
    // Without a Firebase config there is no sign-up: only the warning.
    const accounts = isLoginAvailable();
    const items = ownedItems().length;
    const flowers = flowerBalance();
    const have = [flowers ? `<b>${flowers} 🌸</b>` : '', items ? `<b>${items} món đồ</b>` : ''].filter(Boolean).join(' và ');
    this.content.innerHTML = `
      <p class="guest-modal-lead">Bạn đang chơi <b>ẩn danh</b>${have ? ` và đã có ${have}` : ''}.</p>
      <ul class="guest-modal-points">
        <li>Hoa, đồ đã mua và lịch điểm danh chỉ lưu trong <b>tab này</b>.</li>
        <li><b>Đóng tab là mất hết</b> (tải lại trang thì vẫn còn).</li>
        ${accounts ? '<li>Đăng ký tài khoản để <b>đồng bộ</b> và chơi tiếp trên mọi thiết bị.</li>' : ''}
      </ul>
      <div class="look-group guest-modal-actions">
        ${accounts ? '<button type="button" class="primary" data-choice="register">Đăng ký ngay</button><button type="button" data-choice="login">Đã có tài khoản</button>' : ''}
        <button type="button" class="link" data-choice="later">Để sau</button>
      </div>`;
    this.panel.classList.add('open');
    this.showModal(true);
    (this.panel.querySelector('[data-choice="register"]') as HTMLButtonElement | null)?.focus();
  }

  close() {
    if (!this.panel.classList.contains('open')) return;
    this.panel.classList.remove('open');
    this.showModal(false);
  }

  private alreadyShown(): boolean {
    try {
      return sessionStorage.getItem(SHOWN_KEY) === '1';
    } catch {
      return false;
    }
  }

  private markShown() {
    try {
      sessionStorage.setItem(SHOWN_KEY, '1');
    } catch {
      /* storage blocked: may show again after a reload */
    }
  }
}
