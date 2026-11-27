// Faint watermark in the bottom-right corner: how many other players are in
// the room ("12 người đang chơi cùng bạn"). The relay sends the room's count
// (MSG_ONLINE, server/realm.mjs) on join and whenever someone joins or leaves;
// the characters on screen are only those in view range, so they cannot be
// counted here. Hidden until a count arrives and while disconnected.

import { events } from '../core/events';

const numberFormat = new Intl.NumberFormat('vi-VN');

export class OnlineCount {
  readonly root: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private count = -1;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'online-count';
    this.root.setAttribute('role', 'status');
    this.root.setAttribute('aria-live', 'polite');
    this.root.innerHTML = '<i class="online-dot" aria-hidden="true"></i><span></span>';
    this.text = this.root.querySelector('span') as HTMLSpanElement;
    this.root.hidden = true;
    parent.append(this.root);

    events.on('mp_online', (count: number) => this.set(count));
    events.on('mp_disconnected', () => this.set(-1));
  }

  private set(count: number) {
    if (count === this.count) return;
    const before = this.count;
    this.count = count;
    this.root.hidden = count < 0;
    if (count < 0) return;
    const others = Math.max(0, count - 1); // the count includes us
    this.text.textContent = others ? `${numberFormat.format(others)} người đang chơi cùng bạn` : 'Chỉ có mình bạn đang dạo chơi';
    this.root.title = `${numberFormat.format(count)} người trong làng`;
    // Someone came by: a short glow (not on the first count).
    if (before >= 0 && count > before) {
      this.root.classList.remove('bump');
      void this.root.offsetWidth; // restart the animation
      this.root.classList.add('bump');
    }
  }
}
