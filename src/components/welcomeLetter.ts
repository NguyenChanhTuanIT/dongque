// Welcome letter: when the player is connected (first time this visit, once
// the loader is gone), a thank-you card for coming by, in the same style as
// the feedback thank-you (feedback.ts: .thank-card with its stamp). Closed by
// its button, a click outside or Escape. Reconnects don't show it again.

import { events } from '../core/events';
import { getConfig } from '../config/store';
import { chosenName } from '../social/presence';
import { setOverlay } from './overlay';

/** Shown this visit (tab): not again after a reconnect or a reload of the scene. */
const SHOWN_KEY = 'dq-welcome-shown';
/** A moment after the loader goes, so the scene is seen first. */
const DELAY_MS = 1200;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function shownThisVisit(): boolean {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    return false;
  }
}

export class WelcomeLetter {
  private _root: HTMLDivElement;
  private _done = shownThisVisit();
  private _timer = 0;

  constructor(parent: HTMLElement) {
    this._root = document.createElement('div');
    this._root.className = 'nav-modal welcome-modal';
    this._root.setAttribute('role', 'dialog');
    this._root.setAttribute('aria-modal', 'true');
    this._root.setAttribute('aria-label', 'Thư cảm ơn');
    parent.append(this._root);
    this._root.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t.closest('.close-hit') || t.closest('.thank-close')) this._close();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && this._root.classList.contains('visible')) this._close();
    });
    events.on('mp_connected', () => this._schedule());
  }

  private _schedule() {
    if (this._done) return;
    window.clearTimeout(this._timer);
    // Wait for the scene: the loader is removed when the experience shows.
    const tryShow = () => {
      if (document.getElementById('loader')) this._timer = window.setTimeout(tryShow, 500);
      else this._timer = window.setTimeout(() => this._show(), DELAY_MS);
    };
    tryShow();
  }

  private _show() {
    if (this._done) return;
    this._done = true;
    try {
      sessionStorage.setItem(SHOWN_KEY, '1');
    } catch {
      /* storage blocked: once per page load then */
    }
    const name = chosenName('local');
    const place = getConfig().ui.aboutTitle.trim() || 'Một góc quê để thư giãn';
    this._root.innerHTML = `
      <div class="close-hit"></div>
      <div class="modal-card welcome-card">
        <div class="thank-card fresh">
          <div class="thank-stamp" aria-hidden="true">💌</div>
          <p class="thank-greeting">Gửi ${name ? escapeHtml(name) : 'bạn'} thân mến,</p>
          <p>Cảm ơn bạn đã ghé thăm <b>${escapeHtml(place)}</b> hôm nay!</p>
          <p>Ở đây chẳng có gì phải vội: ra cầu câu ngồi chờ phao chìm, vãi thóc cho đàn gà, chạy theo mấy cánh bướm, hay chỉ ngồi ghế đá nghe sóng vỗ.</p>
          <p>Mong bạn tìm được chút bình yên. Có điều gì muốn nhắn nhủ, hộp thư góp ý 💌 luôn mở chờ bạn.</p>
          <p class="thank-sign">Thân mến,<br><b>Đội ngũ phát triển</b> 🌸</p>
        </div>
        <button type="button" class="thank-close">Vào chơi thôi!</button>
      </div>`;
    this._root.classList.add('visible');
    setOverlay('welcome-letter', true); // washed-out scene, quieter audio, controls off
    (this._root.querySelector('.thank-close') as HTMLButtonElement | null)?.focus();
  }

  private _close() {
    if (!this._root.classList.contains('visible')) return;
    this._root.classList.remove('visible');
    setOverlay('welcome-letter', false);
  }
}
