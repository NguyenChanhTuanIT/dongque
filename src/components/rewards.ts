// Daily rewards panel (nav flower button): the flower balance, the daily
// check-in (5 flowers, 10 on Saturday / Sunday) and the online-time rewards
// (10 / 30 / 60 minutes online that day → 5 / 10 / 15 flowers). The relay
// keeps the wallet and decides everything (server/wallets.mjs); this only
// shows its status and sends the requests.

import { events } from '../core/events';
import { REWARD_CHECKIN, REWARD_ONLINE, REWARD_STATUS } from '../engine/multiplayer/socket';
import { isConnected } from '../social/presence';

interface WalletStatus {
  flowers: number;
  checkedIn: boolean;
  checkinFlowers: number;
  week: Array<{ label: string; flowers: number; checked: boolean; today: boolean }>;
  onlineSec: number;
  /** Online milestones claimed today; the current one is tiers[stage]. */
  stage: number;
  /** Time counted towards the current milestone. */
  stageSec: number;
  counting: boolean;
  tiers: Array<{ minutes: number; flowers: number; claimed: boolean }>;
  result?: { action: number; ok: boolean; flowers?: number; error?: string };
}

export const flowerIcon =
  '<svg class="flower" viewBox="0 0 20 20" aria-hidden="true"><g fill="#716C66"><circle cx="10" cy="4.6" r="3.4"/><circle cx="15.1" cy="8.3" r="3.4"/><circle cx="13.2" cy="14.3" r="3.4"/><circle cx="6.8" cy="14.3" r="3.4"/><circle cx="4.9" cy="8.3" r="3.4"/></g><circle cx="10" cy="10" r="2.6" fill="#f9efdc"/></svg>';

const ERRORS: Record<string, string> = {
  already: 'Hôm nay bạn đã điểm danh rồi.',
  claimed: 'Phần quà này đã nhận rồi.',
  'not-yet': 'Chưa đủ thời gian online.',
  login: 'Đăng nhập để nhận hoa nhé.',
};

const flowers = (n: number) => `${n} 🌸`;

export class RewardsPanel {
  private readonly panel: HTMLDivElement;
  private readonly badge: HTMLSpanElement;
  private wallet: WalletStatus | null = null;
  /** performance.now() when `wallet` arrived (online time keeps running locally). */
  private receivedAt = 0;
  private timer = 0;
  private toast = { text: '', until: 0 };
  private html = '';

  /** `openLogin` shows the sign-in dialog. */
  constructor(nav: HTMLElement, private readonly button: HTMLButtonElement, openLogin: () => void) {
    this.badge = document.createElement('span');
    this.badge.className = 'badge';
    this.badge.hidden = true;
    button.append(this.badge);

    this.panel = document.createElement('div');
    this.panel.className = 'look-menu rewards-menu';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Quà mỗi ngày');
    nav.append(this.panel);

    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => this.setOpen(!this.panel.classList.contains('open')));
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.contains(e.target as Node) && !button.contains(e.target as Node)) this.setOpen(false);
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') this.setOpen(false);
    });
    this.panel.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button[data-login]')) {
        this.setOpen(false);
        openLogin();
        return;
      }
      const action = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]')?.dataset.action;
      if (action !== undefined) events.emit('mp_reward', Number(action));
    });

    events.on('mp_wallet', (wallet: WalletStatus | null) => {
      this.wallet = wallet;
      this.receivedAt = performance.now();
      if (wallet?.result) this.showResult(wallet.result);
      this.render();
    });
    events.on('mp_connected', () => this.render());
    events.on('mp_disconnected', () => {
      this.wallet = null;
      this.render();
    });
    this.render();
  }

  private setOpen(open: boolean) {
    this.panel.classList.toggle('open', open);
    this.button.setAttribute('aria-expanded', String(open));
    window.clearInterval(this.timer);
    if (open) {
      events.emit('mp_reward', REWARD_STATUS); // fresh numbers
      this.timer = window.setInterval(() => this.render(), 1000);
    }
    this.render();
  }

  /** Seconds towards the current milestone, counting on locally between server updates. */
  private stageSec(): number {
    const w = this.wallet;
    const tier = w?.tiers[w.stage];
    if (!w || !tier) return 0;
    const running = w.counting && !document.hidden ? Math.floor((performance.now() - this.receivedAt) / 1000) : 0;
    return Math.min(tier.minutes * 60, w.stageSec + running);
  }

  private render() {
    const w = this.wallet;
    const sec = this.stageSec();
    const tier = w?.tiers[w.stage];
    const ready = !!tier && sec >= tier.minutes * 60;
    this.badge.hidden = !w || !(!w.checkedIn || ready);
    if (!this.panel.classList.contains('open')) return;
    // Rebuilt only when something shown changed (a rebuild mid-click would eat the click).
    const html = this.buildHtml(w, sec, ready);
    if (html !== this.html) this.panel.innerHTML = this.html = html;
  }

  private buildHtml(w: WalletStatus | null, sec: number, ready: boolean): string {
    if (!w) {
      return (
        '<div class="look-group"><span>Quà mỗi ngày</span><p class="rewards-note">' +
        (isConnected()
          ? 'Đăng nhập để điểm danh và nhận hoa mỗi ngày.</p><button type="button" class="primary" data-login>Đăng nhập</button>'
          : 'Đang kết nối máy chủ…</p>') +
        '</div>'
      );
    }

    const week = w.week
      .map((d) => `<li class="${d.today ? 'today' : ''}${d.checked ? ' checked' : ''}"><b>${d.label}</b><i>${d.checked ? '✓' : `+${d.flowers}`}</i></li>`)
      .join('');
    const label = (minutes: number) => (minutes >= 60 ? `${minutes / 60} tiếng` : `${minutes} phút`);
    // Milestones one after the other: claimed ✓, current, still locked.
    const steps = w.tiers
      .map((t, i) => `<li class="${t.claimed ? 'checked' : i === w.stage ? 'today' : ''}"><b>${label(t.minutes)}</b><i>${t.claimed ? '✓' : `+${t.flowers}`}</i></li>`)
      .join('');
    const tier = w.tiers[w.stage];
    let current: string;
    if (!tier) {
      current = '<p class="rewards-note">Đã nhận hết quà online hôm nay ✓ Mai quay lại nhé!</p>';
    } else {
      const goal = tier.minutes * 60;
      const done = Math.floor(sec / 60);
      const left = Math.max(1, Math.ceil((goal - sec) / 60));
      const action = ready
        ? `<button type="button" class="primary" data-action="${REWARD_ONLINE + w.stage}">Nhận +${flowers(tier.flowers)}</button>`
        : `<button type="button" disabled>Còn ${left} phút</button>`;
      current = `
        <div class="rewards-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${tier.minutes}" aria-valuenow="${Math.min(tier.minutes, done)}"><div style="width:${Math.min(100, Math.floor((sec / goal) * 100))}%"></div></div>
        <ul class="rewards-tiers"><li><span>Mốc ${w.stage + 1}/${w.tiers.length}: ${Math.min(done, tier.minutes)}/${tier.minutes} phút</span>${action}</li></ul>
        <p class="rewards-note">${ready ? 'Nhận quà để bắt đầu mốc tiếp theo.' : 'Chỉ tính giờ khi game đang mở trên màn hình.'}</p>`;
    }
    const toast = performance.now() < this.toast.until ? this.toast.text : '';
    return `
      <div class="look-group"><span>Hoa của bạn</span><b class="rewards-balance">${flowers(w.flowers)}</b></div>
      <div class="look-group">
        <span>Điểm danh hằng ngày (T7, CN được gấp đôi)</span>
        <ol class="rewards-week">${week}</ol>
        ${w.checkedIn
          ? '<button type="button" disabled>Hôm nay đã điểm danh ✓</button>'
          : `<button type="button" class="primary" data-action="${REWARD_CHECKIN}">Điểm danh +${flowers(w.checkinFlowers)}</button>`}
      </div>
      <div class="look-group">
        <span>Quà online (lần lượt từng mốc)</span>
        <ol class="rewards-week rewards-steps">${steps}</ol>
        ${current}
      </div>
      <p class="rewards-note">Hoa dùng để mua phụ kiện: quần áo, kính, giày, cần câu, diều, kem… (sắp có)</p>
      <p class="rewards-toast" aria-live="polite">${toast}</p>`;
  }

  private showResult(result: NonNullable<WalletStatus['result']>) {
    const text = result.ok ? `Nhận được +${flowers(result.flowers ?? 0)}` : ERRORS[result.error ?? ''] ?? 'Chưa nhận được, thử lại nhé.';
    this.toast = { text, until: performance.now() + 4000 };
    if (result.ok) {
      this.button.classList.remove('rewarded');
      void this.button.offsetWidth; // restart the animation
      this.button.classList.add('rewarded');
    }
  }
}
