// Sign-in / sign-up modal (email + password). Opened from the character panel
// ("Đăng nhập"); new players switch to the sign-up tab, which also picks the
// display name.

import { setOverlay } from './overlay';
import { NAME_MAX_CHARS, NAME_MIN_CHARS } from '../engine/multiplayer/socket';
import { authErrorMessage, isLoginAvailable, registerWithEmail, resetPassword, setName, signInWithEmail } from '../social/auth';

const closeIcon = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m1.5 1.5 15 15m0-15-15 15" stroke="#989389" stroke-width="2" stroke-linecap="round"/></svg>';

type Mode = 'login' | 'register';

/** Trimmed name with inner whitespace collapsed. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

/** Error message for an invalid display name, or '' when it is fine. */
export function nameError(name: string): string {
  const chars = [...name].length;
  if (chars < NAME_MIN_CHARS || chars > NAME_MAX_CHARS || !/[\p{L}\p{N}]/u.test(name)) {
    return `Tên cần ${NAME_MIN_CHARS}–${NAME_MAX_CHARS} ký tự, có chữ hoặc số.`;
  }
  return '';
}

export class AuthModal {
  readonly root: HTMLDivElement;
  private readonly form: HTMLFormElement;
  private readonly title: HTMLElement;
  private readonly nameRow: HTMLElement;
  private readonly confirmRow: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly emailInput: HTMLInputElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly confirmInput: HTMLInputElement;
  private readonly submit: HTMLButtonElement;
  private readonly switchText: HTMLElement;
  private readonly switchButton: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly forgotButton: HTMLButtonElement;
  private mode: Mode = 'login';
  private busy = false;
  private onDone: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'auth';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-labelledby', 'auth-title');
    this.root.innerHTML =
      '<div class="close-hit"></div>' +
      '<div class="cnt"><div class="bg-dark"></div><div class="bg-light"></div>' +
      '<form novalidate>' +
      '<h1 id="auth-title"></h1>' +
      '<label class="auth-name">Tên hiển thị<input type="text" name="name" autocomplete="nickname"></label>' +
      '<label>Email<input type="email" name="email" autocomplete="email" inputmode="email" required></label>' +
      '<label>Mật khẩu<input type="password" name="password" required minlength="6"></label>' +
      '<button type="button" class="auth-forgot">Quên mật khẩu?</button>' +
      '<label class="auth-confirm">Nhập lại mật khẩu<input type="password" name="confirm" autocomplete="new-password" minlength="6"></label>' +
      '<small class="auth-status" aria-live="polite"></small>' +
      '<button type="submit" class="auth-submit"></button>' +
      '<p class="auth-switch"><span></span> <button type="button"></button></p>' +
      '</form>' +
      '<button class="button-close" type="button" aria-label="Đóng">' + closeIcon + '</button></div>';
    parent.append(this.root);

    this.form = this.root.querySelector('form') as HTMLFormElement;
    this.title = this.root.querySelector('h1') as HTMLElement;
    this.nameRow = this.root.querySelector('.auth-name') as HTMLElement;
    this.confirmRow = this.root.querySelector('.auth-confirm') as HTMLElement;
    this.nameInput = this.form.elements.namedItem('name') as HTMLInputElement;
    this.emailInput = this.form.elements.namedItem('email') as HTMLInputElement;
    this.passwordInput = this.form.elements.namedItem('password') as HTMLInputElement;
    this.confirmInput = this.form.elements.namedItem('confirm') as HTMLInputElement;
    this.submit = this.root.querySelector('.auth-submit') as HTMLButtonElement;
    this.switchText = this.root.querySelector('.auth-switch span') as HTMLElement;
    this.switchButton = this.root.querySelector('.auth-switch button') as HTMLButtonElement;
    this.status = this.root.querySelector('.auth-status') as HTMLElement;
    this.forgotButton = this.root.querySelector('.auth-forgot') as HTMLButtonElement;
    this.forgotButton.addEventListener('click', () => void this.handleForgot());
    this.nameInput.maxLength = NAME_MAX_CHARS * 2; // code points are checked on submit

    this.root.querySelector('.close-hit')?.addEventListener('click', () => this.close());
    this.root.querySelector('.button-close')?.addEventListener('click', () => this.close());
    this.switchButton.addEventListener('click', () => this.setMode(this.mode === 'login' ? 'register' : 'login'));
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleSubmit();
    });
    // Escape from inside a field (keys in text fields never reach the bus).
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    this.setMode('login');
  }

  get isOpen(): boolean {
    return this.root.classList.contains('visible');
  }

  /** Show the modal; `onDone` runs after a successful sign-in / sign-up. */
  open(mode: Mode = 'login', onDone?: () => void) {
    this.onDone = onDone ?? null;
    this.form.reset();
    this.setMode(mode);
    this.root.classList.add('visible');
    // Without a Firebase config (.env) accounts cannot work: say so up front.
    this.submit.disabled = !isLoginAvailable();
    if (!isLoginAvailable()) this.say('Máy chủ chưa bật tài khoản (thiếu cấu hình Firebase).');
    // Same scene treatment as the info (i) modal (washed-out scene, quieter
    // audio, no controls, nav hidden); may sit over a nav panel modal.
    setOverlay('auth', true);
    (this.mode === 'register' ? this.nameInput : this.emailInput).focus();
  }

  close() {
    if (!this.isOpen) return;
    this.root.classList.remove('visible');
    this.passwordInput.value = '';
    this.confirmInput.value = '';
    this.onDone = null;
    setOverlay('auth', false);
  }

  private setMode(mode: Mode) {
    this.mode = mode;
    const register = mode === 'register';
    this.title.textContent = register ? 'Đăng ký' : 'Đăng nhập';
    this.submit.textContent = register ? 'Tạo tài khoản' : 'Đăng nhập';
    this.switchText.textContent = register ? 'Đã có tài khoản?' : 'Chưa có tài khoản?';
    this.switchButton.textContent = register ? 'Đăng nhập' : 'Đăng ký';
    this.nameRow.hidden = !register;
    this.confirmRow.hidden = !register;
    this.forgotButton.hidden = register;
    this.passwordInput.autocomplete = register ? 'new-password' : 'current-password';
    this.say('');
    if (this.isOpen) (register ? this.nameInput : this.emailInput).focus();
  }

  private say(text: string) {
    this.status.textContent = text;
  }

  private async handleSubmit() {
    if (this.busy) return;
    const register = this.mode === 'register';
    const email = this.emailInput.value.trim();
    const password = this.passwordInput.value;
    const name = normalizeName(this.nameInput.value);

    if (register) {
      const bad = nameError(name);
      if (bad) return this.fail(bad, this.nameInput);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return this.fail('Email không hợp lệ.', this.emailInput);
    if (!password) return this.fail('Vui lòng nhập mật khẩu.', this.passwordInput);
    if (register) {
      if (password.length < 6) return this.fail('Mật khẩu cần ít nhất 6 ký tự.', this.passwordInput);
      if (password !== this.confirmInput.value) return this.fail('Mật khẩu nhập lại không khớp.', this.confirmInput);
    }

    this.busy = true;
    this.submit.disabled = true;
    this.say(register ? 'Đang tạo tài khoản…' : 'Đang đăng nhập…');
    try {
      if (register) {
        const user = await registerWithEmail(email, password);
        setName(user, name);
      } else {
        await signInWithEmail(email, password);
      }
      const done = this.onDone;
      this.close();
      done?.();
    } catch (err) {
      console.warn('[auth] email auth failed', err);
      this.say(authErrorMessage(err));
    } finally {
      this.busy = false;
      this.submit.disabled = false;
    }
  }

  /** "Quên mật khẩu?": email a reset link to the address typed above. */
  private async handleForgot() {
    if (this.busy || !isLoginAvailable()) return;
    const email = this.emailInput.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return this.fail('Nhập email của tài khoản ở trên rồi bấm "Quên mật khẩu?".', this.emailInput);
    this.busy = true;
    this.forgotButton.disabled = true;
    this.say('Đang gửi thư…');
    try {
      await resetPassword(email);
      // Same answer whether or not the email has an account.
      this.say(`Nếu ${email} có tài khoản, thư đặt lại mật khẩu đã được gửi. Kiểm tra cả mục thư rác nhé.`);
    } catch (err) {
      console.warn('[auth] password reset failed', err);
      this.say(authErrorMessage(err));
    } finally {
      this.busy = false;
      this.forgotButton.disabled = false;
    }
  }

  private fail(message: string, field: HTMLInputElement) {
    this.say(message);
    field.focus();
  }
}
