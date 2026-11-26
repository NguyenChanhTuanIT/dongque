// Feedback panel (nav letter button): one textarea, sent to the relay
// (POST /api/feedback, server/feedback.mjs). One feedback per day: the relay
// enforces it (per account, or per IP for guests); this tab also remembers the
// day it sent one, so reopening the panel shows the thank-you card right away.

import { events } from '../core/events';
import { getConfig } from '../config/store';
import { defaultMultiplayerUrl } from '../engine/multiplayer/socket';
import { currentUser } from '../social/auth';
import { addPanelBar } from './panelBar';
import { mountPanelModal } from './overlay';

export const letterIcon =
  '<svg class="letter" viewBox="0 0 22 16" aria-hidden="true"><path fill-rule="evenodd" d="M2.6 0h16.8A2.6 2.6 0 0 1 22 2.6v10.8a2.6 2.6 0 0 1-2.6 2.6H2.6A2.6 2.6 0 0 1 0 13.4V2.6A2.6 2.6 0 0 1 2.6 0Zm.3 2.4 8.1 6 8.1-6H2.9Zm16.9 2.2-8.1 6a1.2 1.2 0 0 1-1.4 0l-8.1-6v8.8c0 .2.2.4.4.4h16.8c.2 0 .4-.2.4-.4V4.6Z" fill="#716C66"/></svg>';

/** Same limits as server/feedback.mjs. */
const MIN_CHARS = 5;
const MAX_CHARS = 1000;
const SENT_KEY = 'feedback-sent-day';
/** The relay's calendar (REWARDS_TZ default): the limit resets at midnight Vietnam time. */
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
const today = () => dayFormat.format(new Date());

const ERRORS: Record<string, string> = {
  too_short: `Viết thêm chút nữa nhé (ít nhất ${MIN_CHARS} ký tự).`,
  too_long: `Góp ý dài quá, tối đa ${MAX_CHARS} ký tự.`,
  busy: 'Hôm nay hộp thư đã đầy, bạn quay lại vào ngày mai nhé.',
  unauthenticated: 'Phiên đăng nhập đã hết hạn, hãy đăng nhập lại rồi gửi.',
};

/** HTTP base of the relay (the game may talk to a relay on another host). */
function relayBase(): string {
  const ws = getConfig().features.multiplayerUrl || import.meta.env.VITE_MULTIPLAYER_URL || defaultMultiplayerUrl();
  try {
    const url = new URL(ws, location.href);
    url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    url.pathname = url.pathname.replace(/\/mp\/?$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function sentToday(): boolean {
  try {
    return localStorage.getItem(SENT_KEY) === today();
  } catch {
    return false;
  }
}

function rememberSent() {
  try {
    localStorage.setItem(SENT_KEY, today());
  } catch {
    /* storage blocked: the relay still enforces the limit */
  }
}

/** Characters as the relay counts them (code points, not UTF-16 units). */
const length = (text: string) => [...text.trim()].length;

export class FeedbackPanel {
  private readonly panel: HTMLDivElement;
  private readonly showModal: (open: boolean) => void;
  private readonly content: HTMLDivElement;
  private draft = '';
  private sending = false;
  /** Set after a successful send (or the relay saying one was sent today). */
  private thanked: 'sent' | 'already' | null = null;

  constructor(nav: HTMLElement, private readonly button: HTMLButtonElement) {
    this.panel = document.createElement('div');
    this.panel.className = 'look-menu feedback-menu';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Góp ý');
    this.showModal = mountPanelModal(this.panel, nav.parentElement ?? nav);
    this.content = addPanelBar(this.panel, 'Góp ý', () => this.setOpen(false));

    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => this.setOpen(!this.panel.classList.contains('open')));
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.contains(e.target as Node) && !button.contains(e.target as Node)) this.setOpen(false);
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') this.setOpen(false);
    });
  }

  private setOpen(open: boolean) {
    if (open === this.panel.classList.contains('open')) return;
    this.panel.classList.toggle('open', open);
    this.showModal(open);
    this.button.setAttribute('aria-expanded', String(open));
    if (open) {
      if (!this.thanked && sentToday()) this.thanked = 'already';
      // A new day: the form again.
      if (this.thanked && !sentToday()) this.thanked = null;
      this.render();
    }
  }

  private render() {
    if (this.thanked) {
      this.renderThanks();
      return;
    }
    this.content.innerHTML = `
      <form class="feedback-form" novalidate>
        <label class="look-group">
          <span>Bạn thấy trò chơi thế nào? Điều gì làm bạn thích, điều gì chưa ổn, bạn muốn có thêm gì?</span>
          <textarea name="text" rows="6" maxlength="${MAX_CHARS}" placeholder="Viết góp ý của bạn ở đây…" required></textarea>
        </label>
        <div class="feedback-foot">
          <small class="feedback-count" aria-live="polite"></small>
          <button type="submit" class="primary">Gửi góp ý</button>
        </div>
        <p class="rewards-note">Mỗi ngày bạn gửi được 1 góp ý. Đội ngũ phát triển đọc tất cả góp ý.</p>
        <p class="rewards-toast" role="alert"></p>
      </form>`;
    const form = this.content.querySelector('form') as HTMLFormElement;
    const textarea = form.querySelector('textarea') as HTMLTextAreaElement;
    const count = form.querySelector('.feedback-count') as HTMLElement;
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    const error = form.querySelector('.rewards-toast') as HTMLElement;

    const update = () => {
      this.draft = textarea.value;
      const n = length(textarea.value);
      count.textContent = `${n}/${MAX_CHARS}`;
      submit.disabled = this.sending || n < MIN_CHARS || n > MAX_CHARS;
    };
    textarea.value = this.draft;
    textarea.addEventListener('input', () => {
      error.textContent = '';
      update();
    });
    // Ctrl/⌘ + Enter sends.
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      void this.send(textarea.value, (text) => {
        error.textContent = text;
        update();
      });
      submit.textContent = 'Đang gửi…';
      update();
    });
    update();
    // Focus once the card has popped in (focusing earlier scrolls the scene on mobile).
    window.setTimeout(() => {
      if (this.panel.classList.contains('open') && textarea.isConnected) textarea.focus({ preventScroll: true });
    }, 650);
  }

  private async send(text: string, showError: (text: string) => void) {
    this.sending = true;
    let error = '';
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const user = currentUser();
      if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
      const res = await fetch(`${relayBase()}/api/feedback`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: text.trim() }),
        cache: 'no-store',
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        this.thanked = 'sent';
        this.draft = '';
        rememberSent();
      } else if (body?.error === 'already') {
        this.thanked = 'already';
        rememberSent();
      } else {
        error = ERRORS[body?.error] ?? 'Chưa gửi được, bạn thử lại sau nhé.';
      }
    } catch {
      error = 'Không kết nối được máy chủ, bạn thử lại sau nhé.';
    }
    this.sending = false;
    if (!this.panel.classList.contains('open') && !this.thanked) return;
    if (this.thanked) this.render();
    else {
      const submit = this.content.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submit) submit.textContent = 'Gửi góp ý';
      showError(error);
    }
  }

  private renderThanks() {
    const sent = this.thanked === 'sent';
    this.content.innerHTML = `
      <div class="thank-card${sent ? ' fresh' : ''}">
        <div class="thank-stamp" aria-hidden="true">💌</div>
        <p class="thank-greeting">Gửi bạn thân mến,</p>
        <p>${sent
          ? 'Cảm ơn bạn đã dành thời gian viết góp ý! Mỗi dòng bạn gửi đều được đội ngũ phát triển đọc kỹ, để buổi chiều ở làng biển ngày càng dễ chịu hơn.'
          : 'Hôm nay bạn đã gửi góp ý rồi, cảm ơn bạn rất nhiều! Đội ngũ phát triển đang đọc từng dòng.'}</p>
        <p>Ngày mai bạn có thể gửi thêm góp ý mới nhé.</p>
        <p class="thank-sign">Thân mến,<br><b>Đội ngũ phát triển</b> 🌸</p>
      </div>
      <button type="button" class="primary thank-close">Đóng</button>`;
    this.content.querySelector('.thank-close')?.addEventListener('click', () => this.setOpen(false));
  }
}
