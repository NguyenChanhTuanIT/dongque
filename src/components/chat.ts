// Room-wide chat (bottom left). Enter opens the input, Enter sends, Escape
// closes; on touch screens the "Chạm để chat" line under the log opens it.
// Recent lines stay visible for a while, the full log shows while the input is open.
// Every line also pops up as a bubble over the speaker (components/nametags.ts).
//
// The chat box is also where the game talks to the player (nothing floats over
// the scene): notice lines (`game_hint`), one-time how-tos (`game_tip`, e.g. the
// fishing pier) and the actions of the place the player stands in (`chat_action`:
// sit / lie on a bench, fish on the pier…), each a message line of the log that
// follows the place (updated in place, moved to the bottom when it changes, faded
// out when the player leaves). Action buttons carry `data-slot` (an emote slot)
// so touch screens can use them.

import { events } from '../core/events';
import { CHAT_MAX_CHARS, CLOSE_BANNED, NOTICE_BANNED, NOTICE_CHAT_MUTED, NOTICE_CHAT_REPEAT, NOTICE_CHAT_TOO_FAST, NOTICE_GUEST_BLOCKED } from '../engine/multiplayer/socket';
import { displayName } from '../social/presence';
import { announcementLine, isAnnouncement } from './announce';

const MAX_LINES = 100;
/** How long a line stays visible while the input is closed. */
const LINE_VISIBLE_MS = 15_000;
/** How-tos are longer: they stay a bit more. */
const TIP_VISIBLE_MS = 30_000;

export class ChatPanel {
  readonly root: HTMLDivElement;
  private readonly log: HTMLOListElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  /** Place actions by source (bench, pier, coop…): their HTML and log line. */
  private readonly actions = new Map<string, { html: string; li: HTMLLIElement }>();
  private open = false;

  /** `canOpen` is false while a full-screen overlay is up. */
  constructor(parent: HTMLElement, private readonly canOpen: () => boolean) {
    this.root = document.createElement('div');
    this.root.id = 'chat';
    this.root.innerHTML =
      '<ol class="chat-log" aria-live="polite" aria-label="Tin nhắn"></ol>' +
      '<form class="chat-form" autocomplete="off"><input type="text" enterkeyhint="send" aria-label="Tin nhắn" placeholder="Nói gì đó… (Enter gửi, Esc đóng)"><button type="submit">Gửi</button></form>' +
      '<button type="button" class="chat-hint"><span class="hint-keys">Nhấn <kbd>Enter</kbd> để chat</span><span class="hint-touch">💬 Chạm để chat</span></button>';
    parent.append(this.root);
    this.log = this.root.querySelector('.chat-log') as HTMLOListElement;
    this.form = this.root.querySelector('form') as HTMLFormElement;
    this.input = this.form.querySelector('input') as HTMLInputElement;
    this.input.maxLength = CHAT_MAX_CHARS;
    const hint = this.root.querySelector('.chat-hint') as HTMLButtonElement;
    hint.addEventListener('click', () => this.setOpen(true));
    // Buttons inside lines of the log: an emote slot (`data-slot`) or an event
    // with one argument (`data-emit` / `data-arg`, e.g. answering an invitation).
    this.log.addEventListener('click', (e) => {
      const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (!button || button.disabled) return;
      if (button.dataset.slot) events.emit('webgl_character_emote', Number(button.dataset.slot));
      else if (button.dataset.emit) events.emit(button.dataset.emit, button.dataset.arg);
    });
    // Keep the game (not a button) focused: keys keep moving the character.
    this.log.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('button')) e.preventDefault();
    });

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
    events.on('mp_chat', (id: string, text: string) => {
      // Fishing news: a notice line ("🎣 Tuấn câu được Cá thu 3,2 kg!"), not a message.
      if (isAnnouncement(text)) this.addLine('', announcementLine(displayName(id), text), 'system');
      else this.addLine(displayName(id), text, id === 'local' ? 'self' : '');
    });
    events.on('mp_notice', (code: number) => {
      if (code === NOTICE_CHAT_TOO_FAST) this.addLine('', 'Bạn gửi hơi nhanh, chờ một chút nhé.', 'system');
      else if (code === NOTICE_CHAT_REPEAT) this.addLine('', 'Tin nhắn này vừa gửi rồi, đừng lặp lại nhé.', 'system');
      else if (code === NOTICE_CHAT_MUTED) this.addLine('', 'Bạn gửi quá nhiều tin nhắn nên tạm thời không chat được, thử lại sau ít phút.', 'system');
      else if (code === NOTICE_GUEST_BLOCKED) this.addLine('', 'Khách từ mạng này tạm thời không chat được. Đăng nhập tài khoản để trò chuyện nhé.', 'system');
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
    // Short game hints (e.g. stone benches: "move closer", "bench is full"),
    // optionally with one button (e.g. "Bạn cần có Cần câu" → "Cửa hàng").
    events.on('game_hint', (text: string, action?: { label: string; run: () => void }) => {
      const li = this.addLine('', text, 'system');
      if (!action) return;
      li.classList.add('action');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', () => {
        button.disabled = true;
        action.run();
      });
      li.append(button);
    });
    // One-time how-tos of a place (scene/spots.ts): first line bold, line breaks kept.
    events.on('game_tip', (text: string) => this.addLine('', text, 'tip'));
    events.on('chat_action', (source: string, html: string) => this.setAction(source, html));
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

  /**
   * The action line of a place: a message in the log (with its buttons) while
   * the player is there. A change rewrites it and moves it to the bottom (it is
   * the latest news); leaving fades it out and removes it.
   */
  private setAction(source: string, html: string) {
    const current = this.actions.get(source);
    if ((current?.html ?? '') === html) return;
    if (!html) {
      if (!current) return;
      this.actions.delete(source);
      const li = current.li;
      li.querySelectorAll('button').forEach((b) => (b.disabled = true));
      li.classList.add('old', 'gone');
      window.setTimeout(() => li.remove(), 700);
      return;
    }
    const li = current?.li ?? document.createElement('li');
    li.className = 'system action';
    li.innerHTML = html;
    this.actions.set(source, { html, li });
    this.appendLine(li);
  }

  /** Append (or move) a line to the bottom of the log, trimmed and scrolled. */
  private appendLine(li: HTMLLIElement) {
    const stick = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 4;
    this.log.append(li);
    while (this.log.children.length > MAX_LINES) this.log.firstElementChild?.remove();
    if (stick || !this.open) this.log.scrollTop = this.log.scrollHeight;
  }

  private addLine(author: string, text: string, kind: '' | 'self' | 'system' | 'tip'): HTMLLIElement {
    const li = document.createElement('li');
    if (kind) li.className = kind;
    if (author) {
      const who = document.createElement('b');
      who.textContent = author;
      li.append(who, ': ');
    }
    if (kind === 'tip') {
      // Shown like the other notices (italic line): "🐔 Chuồng gà: how-to…".
      const [title, ...rest] = text.split('\n');
      li.className = 'system';
      li.append(rest.length ? `${title}: ${rest.join(' ')}` : title);
    } else {
      li.append(text);
    }
    this.appendLine(li);
    window.setTimeout(() => li.classList.add('old'), kind === 'tip' ? TIP_VISIBLE_MS : LINE_VISIBLE_MS);
    return li;
  }
}
