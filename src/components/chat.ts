// Room-wide chat (bottom left). Enter opens the input, Enter sends, Escape
// closes; the chat button in the nav does the same on touch screens. Recent
// lines stay visible for a while, the full log shows while the input is open.
// Every line also pops up as a bubble over the speaker (components/nametags.ts).

import { events } from '../core/events';
import { CHAT_MAX_CHARS, CLOSE_BANNED, NOTICE_BANNED, NOTICE_CHAT_TOO_FAST } from '../engine/multiplayer/socket';
import { displayName } from '../social/presence';

const MAX_LINES = 100;
/** How long a line stays visible while the input is closed. */
const LINE_VISIBLE_MS = 15_000;

export class ChatPanel {
  readonly root: HTMLDivElement;
  private readonly log: HTMLOListElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private open = false;

  /** `canOpen` is false while a full-screen overlay is up. */
  constructor(parent: HTMLElement, private readonly canOpen: () => boolean) {
    this.root = document.createElement('div');
    this.root.id = 'chat';
    this.root.innerHTML =
      '<ol class="chat-log" aria-live="polite" aria-label="Tin nhắn"></ol>' +
      '<form class="chat-form" autocomplete="off"><input type="text" enterkeyhint="send" aria-label="Tin nhắn" placeholder="Nói gì đó… (Enter gửi, Esc đóng)"><button type="submit">Gửi</button></form>' +
      '<div class="chat-hint">Nhấn <kbd>Enter</kbd> để chat</div>';
    parent.append(this.root);
    this.log = this.root.querySelector('.chat-log') as HTMLOListElement;
    this.form = this.root.querySelector('form') as HTMLFormElement;
    this.input = this.form.querySelector('input') as HTMLInputElement;
    this.input.maxLength = CHAT_MAX_CHARS;

    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setOpen(false);
    });
    // Tapping the game closes the input (keeps the typed text for later).
    this.input.addEventListener('blur', () => {
      if (!this.input.value.trim()) this.setOpen(false);
    });

    // Keys reach the bus only when no text field has focus (engine/globals.ts).
    events.on('keydown', (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.code === 'NumpadEnter') && !e.repeat && !this.open && this.canOpen()) {
        e.preventDefault();
        this.setOpen(true);
      }
    });
    events.on('mp_chat', (id: string, text: string) => this.addLine(displayName(id), text, id === 'local' ? 'self' : ''));
    events.on('mp_notice', (code: number) => {
      if (code === NOTICE_CHAT_TOO_FAST) this.addLine('', 'Bạn gửi hơi nhanh, chờ một chút nhé.', 'system');
      else if (code === NOTICE_BANNED) this.addLine('', 'Tài khoản này đã bị khoá, bạn đang chơi với tư cách khách.', 'system');
    });
    events.on('mp_kicked', (code: number) => {
      this.addLine(
        '',
        code === CLOSE_BANNED
          ? 'Tài khoản của bạn đã bị khoá và bị ngắt khỏi máy chủ.'
          : 'Bạn đã bị quản trị viên mời ra khỏi máy chủ. Tải lại trang để vào lại.',
        'system',
      );
    });
    events.on('auth_banned', () => this.addLine('', 'Tài khoản này đã bị khoá nên đã được đăng xuất.', 'system'));
  }

  toggle() {
    this.setOpen(!this.open);
  }

  setOpen(open: boolean) {
    if (open && !this.canOpen()) return;
    this.open = open;
    this.root.classList.toggle('open', open);
    if (open) {
      this.input.focus();
      this.log.scrollTop = this.log.scrollHeight;
    } else {
      this.input.blur();
    }
  }

  private submit() {
    const text = this.input.value.trim();
    if (!text) {
      this.setOpen(false);
      return;
    }
    events.emit('mp_send_chat', text, (sent: boolean) => {
      if (sent) {
        this.input.value = '';
        this.setOpen(false);
      } else {
        this.addLine('', 'Chưa kết nối được máy chủ, thử lại sau.', 'system');
      }
    });
  }

  private addLine(author: string, text: string, kind: '' | 'self' | 'system') {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    if (author) {
      const who = document.createElement('b');
      who.textContent = author;
      li.append(who, ': ');
    }
    li.append(text);
    const stick = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 4;
    this.log.append(li);
    while (this.log.children.length > MAX_LINES) this.log.firstElementChild?.remove();
    if (stick || !this.open) this.log.scrollTop = this.log.scrollHeight;
    window.setTimeout(() => li.classList.add('old'), LINE_VISIBLE_MS);
  }
}
