import { events } from '../core/events';
import { DEFAULT_CONFIG, type SceneConfig } from '../config/schema';
import { EMOTES } from '../scene/emotes';
import { DEFAULT_OUTFIT, PRESETS, SLOTS, sanitizeOutfit, type Outfit } from '../scene/appearance';
import { NAME_MAX_CHARS, NAME_MIN_CHARS, NOTICE_AUTH_FAILED, NOTICE_BAD_NAME, NOTICE_BANNED, NOTICE_LOGIN_UNAVAILABLE } from '../engine/multiplayer/socket';
import { chosenName, displayName } from '../social/presence';
import { currentUser, isLoginAvailable, savedName, setName, signOut, watchUser } from '../social/auth';
import { AuthModal, nameError, normalizeName } from './authModal';
import { ChatPanel } from './chat';
import { NameTags } from './nametags';
import { RewardsPanel, flowerIcon } from './rewards';

/** Emote menu entries: item n = key n (see scene/characters.ts emoteSlots). */
const EMOTE_MENU = EMOTES.map((e) => e.label);

const speakerIcon = '<svg class="sound sound2" viewBox="0 0 17 13" aria-hidden="true"><path d="M10.189 0.228 6.13 3.332H4.168c-.512 0-.938.41-.938.938v4.384c0 .165.043.321.118.457L.816 10.907a1 1 0 1 0 1.157 1.631l4.153-2.946h.021l.026.02 5.756-4.082v-.054l3.694-2.62a1 1 0 0 0-1.157-1.631l-2.537 1.8V1.08c-.017-.904-1.041-1.399-1.74-.853Z" fill="#716C66"/></svg>';
const mutedIcon = '<svg class="sound sound2" viewBox="0 0 17 13" aria-hidden="true"><path d="M6.96.228 2.9 3.332H.938A.94.94 0 0 0 0 4.27v4.384c0 .511.41.938.938.938h1.979l4.042 3.104a1 1 0 0 0 1.74-.853V1.08C8.682.177 7.659-.318 6.96.228Z" fill="#716C66"/></svg>';
const infoIcon = '<svg class="info" viewBox="0 0 4 18" aria-hidden="true"><path d="M2 6a2 2 0 0 1 2 2v6.818a2 2 0 1 1-4 0V8a2 2 0 0 1 2-2ZM4 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" fill="#716C66"/></svg>';
const emoteIcon = '<svg class="emote" viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M10 0a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-3.2 6.2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6.4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM5.6 12a.9.9 0 0 0-.8 1.3A5.8 5.8 0 0 0 10 16.3a5.8 5.8 0 0 0 5.2-3 .9.9 0 1 0-1.6-.8A4 4 0 0 1 10 14.5a4 4 0 0 1-3.6-2 .9.9 0 0 0-.8-.5Z" fill="#716C66"/></svg>';
const lookIcon = '<svg class="look" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8ZM2.5 19c0-4.3 3.4-7.5 7.5-7.5s7.5 3.2 7.5 7.5Z" fill="#716C66"/></svg>';
const chatIcon = '<svg class="chat" viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5c5 0 9 3.2 9 7.3s-4 7.2-9 7.2c-.9 0-1.8-.1-2.6-.3L3 18.2l1.1-3.9C2.2 13 1 11 1 8.8 1 4.7 5 1.5 10 1.5Z" fill="#716C66"/></svg>';
const closeIcon = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m1.5 1.5 15 15m0-15-15 15" stroke="#989389" stroke-width="2" stroke-linecap="round"/></svg>';

/** Credit for the original work; fixed, not part of the remote config. */
const ORIGINAL_CREDIT = '<a href="https://vlucendo.com" rel="noreferrer" target="_blank" class="link2">Vicente</a>';

type InfoName = 'about' | 'congrats';
interface InfoContent {
  title: string;
  paragraphs: string[];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}


export class UiController {
  readonly webglContainer: HTMLDivElement;
  private readonly loader: HTMLDivElement;
  private readonly nav: HTMLElement;
  private readonly secretModal: HTMLDivElement;
  private readonly infoModal: HTMLDivElement;
  private readonly infoPanel: HTMLElement;
  private readonly secretPanel: HTMLElement;
  private readonly colorSquare: HTMLDivElement;
  private readonly soundButton: HTMLButtonElement;
  private readonly count: HTMLDivElement;
  private readonly chat: ChatPanel;
  private readonly authModal: AuthModal;
  private easterEggs = 0;
  private totalEasterEggs = 0;
  private overlayOpen = false;
  private secretTimer = 0;
  private infoContent: Record<InfoName, InfoContent> = {
    about: { title: DEFAULT_CONFIG.ui.aboutTitle, paragraphs: DEFAULT_CONFIG.ui.aboutParagraphs },
    congrats: { title: DEFAULT_CONFIG.ui.congratsTitle, paragraphs: DEFAULT_CONFIG.ui.congratsParagraphs },
  };

  constructor(root: HTMLElement) {
    this.webglContainer = document.createElement('div');
    this.webglContainer.id = 'webgl';
    root.append(this.webglContainer);

    this.loader = document.createElement('div');
    this.loader.id = 'loader';
    this.loader.innerHTML = '<h1>Summer<br>Afternoon</h1><div class="spinner"><svg viewBox="0 0 66 66" aria-hidden="true"><circle class="path" fill="none" stroke-width="7" stroke-linecap="round" cx="33" cy="33" r="29"/></svg></div>';
    root.append(this.loader);

    this.nav = document.createElement('nav');
    this.nav.innerHTML = '<button class="button" type="button" aria-label="toggle sound"></button><button class="button" type="button" aria-label="randomize character color"><div class="color-square"></div></button><button class="button" type="button" aria-label="about">' + infoIcon + '</button><button class="button" type="button" aria-label="emote (E)" title="Biểu cảm (E)">' + emoteIcon + '</button><button class="button" type="button" aria-label="character" title="Nhân vật">' + lookIcon + '</button><button class="button" type="button" aria-label="chat (Enter)" title="Chat (Enter)">' + chatIcon + '</button><button class="button" type="button" aria-label="daily rewards" title="Quà mỗi ngày">' + flowerIcon + '</button><div class="cnt">0/0</div>';
    root.append(this.nav);
    this.soundButton = this.nav.querySelectorAll('button')[0];
    const colorButton = this.nav.querySelectorAll('button')[1];
    const infoButton = this.nav.querySelectorAll('button')[2];
    this.colorSquare = colorButton.querySelector('.color-square') as HTMLDivElement;
    this.count = this.nav.querySelector('.cnt') as HTMLDivElement;
    this.soundButton.innerHTML = speakerIcon;
    this.soundButton.addEventListener('click', () => events.emit('webgl_audio_mute_toggle'));
    colorButton.addEventListener('click', () => events.emit('webgl_character_randomize_color'));
    infoButton.addEventListener('click', () => this.toggleOverlay('about'));
    const emoteButton = this.nav.querySelectorAll('button')[3];
    emoteButton.setAttribute('aria-haspopup', 'menu');
    emoteButton.setAttribute('aria-expanded', 'false');
    const emoteMenu = document.createElement('div');
    emoteMenu.className = 'emote-menu';
    emoteMenu.setAttribute('role', 'menu');
    EMOTE_MENU.forEach((label, i) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = `<kbd>${EMOTES[i].key}</kbd>`;
      item.append(label);
      item.addEventListener('click', () => {
        events.emit('webgl_character_emote', i + 1);
        setMenu(false);
      });
      emoteMenu.append(item);
    });
    this.nav.append(emoteMenu);
    const setMenu = (open: boolean) => {
      emoteMenu.style.top = `${emoteButton.offsetTop - 4}px`;
      emoteMenu.classList.toggle('open', open);
      emoteButton.setAttribute('aria-expanded', String(open));
    };
    emoteButton.addEventListener('click', () => setMenu(!emoteMenu.classList.contains('open')));
    document.addEventListener('pointerdown', (e) => {
      if (!emoteMenu.contains(e.target as Node) && e.target !== emoteButton && !emoteButton.contains(e.target as Node)) setMenu(false);
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') setMenu(false);
    });
    this.authModal = new AuthModal(root);
    this.setupLookMenu(this.nav.querySelectorAll('button')[4]);

    new NameTags(root);
    this.chat = new ChatPanel(root, () => !this.overlayOpen && !this.authModal.isOpen);
    const chatButton = this.nav.querySelectorAll('button')[5];
    // Keep focus in the chat input while pressing the button (it toggles instead).
    chatButton.addEventListener('pointerdown', (e) => e.preventDefault());
    chatButton.addEventListener('click', () => this.chat.toggle());
    new RewardsPanel(this.nav, this.nav.querySelectorAll('button')[6], () => this.authModal.open('login'));

    this.secretModal = document.createElement('div');
    this.secretModal.id = 'modal';
    this.secretModal.innerHTML = '<div class="cnt"><div class="bg-dark"></div><div class="bg-light"></div><article></article><button class="button-close" type="button" aria-label="close">' + closeIcon + '</button></div>';
    root.append(this.secretModal);
    this.secretPanel = this.secretModal.querySelector('article') as HTMLElement;
    this.secretModal.querySelector('button')?.addEventListener('click', () => this.closeSecret());

    this.infoModal = document.createElement('div');
    this.infoModal.id = 'info';
    this.infoModal.innerHTML = '<div class="close-hit"></div><div class="cnt"><div class="bg-dark"></div><div class="bg-light"></div><article></article><button class="button-close" type="button" aria-label="close">' + closeIcon + '</button></div>';
    root.append(this.infoModal);
    this.infoPanel = this.infoModal.querySelector('article') as HTMLElement;
    this.infoModal.querySelector('.close-hit')?.addEventListener('click', () => this.closeOverlay());
    this.infoModal.querySelector('button')?.addEventListener('click', () => this.closeOverlay());
  }

  /** Character picker: boy / girl presets and one row per equipment slot. */
  private setupLookMenu(button: HTMLButtonElement) {
    let outfit: Outfit = [...DEFAULT_OUTFIT];
    const panel = document.createElement('div');
    panel.className = 'look-menu';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Nhân vật và trang phục');
    panel.append(this.createNameSection());
    const renderers: Array<() => void> = [];
    const group = (title: string, labels: string[], pick: (i: number) => Outfit, pressed: (i: number) => boolean) => {
      const section = document.createElement('div');
      section.className = 'look-group';
      const heading = document.createElement('span');
      heading.textContent = title;
      section.append(heading);
      const buttons = labels.map((label, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.addEventListener('click', () => events.emit('webgl_character_outfit', pick(i)));
        section.append(b);
        return b;
      });
      renderers.push(() => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(pressed(i)))));
      panel.append(section);
    };
    group('Nhân vật', PRESETS.map((p) => p.label), (i) => PRESETS[i].apply(outfit), (i) => PRESETS[i].is(outfit));
    SLOTS.forEach((slot, s) => {
      group(slot.label, slot.items.map((it) => it.label), (i) => {
        const next = [...outfit];
        next[s] = i;
        return sanitizeOutfit(next);
      }, (i) => outfit[s] === i);
    });
    this.nav.append(panel);
    const render = () => renderers.forEach((r) => r());
    events.on('webgl_character_update_outfit', (value: Outfit) => {
      outfit = sanitizeOutfit(value);
      render();
    });
    render();
    const setOpen = (open: boolean) => {
      panel.classList.toggle('open', open);
      button.setAttribute('aria-expanded', String(open));
    };
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (!panel.contains(target) && !button.contains(target) && !this.authModal.root.contains(target)) setOpen(false);
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') setOpen(false);
    });
  }

  /**
   * Display name: guests are "Khách <id>"; picking a name needs an account
   * (email + password, see AuthModal); the relay verifies the token before
   * showing it to others.
   */
  private createNameSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'look-group name-group';
    section.innerHTML =
      '<span>Tên hiển thị</span>' +
      '<b class="name-current"></b><button type="button" class="name-edit">Đổi tên</button>' +
      '<form class="name-form" hidden><input type="text" autocomplete="nickname" aria-label="Tên mới"><button type="submit">Lưu</button><button type="button" class="name-signout">Đăng xuất</button></form>' +
      '<small class="name-status" aria-live="polite"></small>';
    const current = section.querySelector('.name-current') as HTMLElement;
    const edit = section.querySelector('.name-edit') as HTMLButtonElement;
    const form = section.querySelector('.name-form') as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    const signOutButton = section.querySelector('.name-signout') as HTMLButtonElement;
    const status = section.querySelector('.name-status') as HTMLElement;
    input.maxLength = NAME_MAX_CHARS * 2; // code points are checked on submit
    const say = (text: string) => {
      status.textContent = text;
    };
    let pending = false;

    const render = () => {
      current.textContent = displayName('local');
      const user = currentUser();
      edit.textContent = user ? 'Đổi tên' : 'Đăng nhập';
      edit.title = user ? (user.email ?? '') : 'Đăng nhập hoặc đăng ký để đặt tên hiển thị';
      edit.hidden = !form.hidden;
      if (!isLoginAvailable()) {
        edit.disabled = true;
        edit.title = 'Chưa cấu hình Firebase (xem README)';
      }
    };
    const openForm = () => {
      const user = currentUser();
      if (!user) return;
      input.value = chosenName('local') || savedName(user.uid);
      form.hidden = false;
      render();
      input.focus();
    };

    edit.addEventListener('click', () => {
      say('');
      if (currentUser()) return openForm();
      // After a sign-in, offer the name form unless this account already has a name.
      this.authModal.open('login', () => {
        const user = currentUser();
        if (user && !chosenName('local') && !savedName(user.uid)) openForm();
      });
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const user = currentUser();
      const name = normalizeName(input.value);
      if (!user) return;
      const bad = nameError(name);
      if (bad) {
        say(bad);
        return;
      }
      pending = true;
      say('Đang lưu…');
      setName(user, name);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        form.hidden = true;
        render();
      }
    });
    signOutButton.addEventListener('click', () => {
      form.hidden = true;
      say('');
      void signOut();
    });

    events.on('social_names_changed', () => {
      if (pending && chosenName('local')) {
        pending = false;
        form.hidden = true;
        say('Đã đổi tên.');
      }
      render();
    });
    events.on('mp_connected', render);
    events.on('mp_notice', (code: number) => {
      if (!pending && code !== NOTICE_AUTH_FAILED && code !== NOTICE_BANNED) return;
      pending = false;
      if (code === NOTICE_BAD_NAME) say(`Tên không hợp lệ (${NAME_MIN_CHARS}–${NAME_MAX_CHARS} ký tự, có chữ hoặc số).`);
      else if (code === NOTICE_AUTH_FAILED) say('Máy chủ không xác thực được tài khoản.');
      else if (code === NOTICE_LOGIN_UNAVAILABLE) say('Máy chủ chưa bật đăng nhập (FIREBASE_PROJECT_ID).');
      else if (code === NOTICE_BANNED) say('Tài khoản đã bị khoá.');
    });
    watchUser((user) => {
      if (!user) form.hidden = true;
      render();
    });
    render();
    return section;
  }

  /** Apply UI texts from the remote config (safe to call repeatedly). */
  applyConfig(config: SceneConfig) {
    const { ui } = config;
    const title = this.loader.querySelector('h1');
    if (title) title.innerHTML = ui.loaderTitle.split('\n').map(escapeHtml).join('<br>');
    this.infoContent = {
      about: { title: ui.aboutTitle, paragraphs: ui.aboutParagraphs },
      congrats: { title: ui.congratsTitle, paragraphs: ui.congratsParagraphs },
    };
  }

  showUnsupported() {
    this.loader.remove();
    const unsupported = document.createElement('div');
    unsupported.id = 'unsupported';
    unsupported.textContent = 'Seems like WebGL2 is not supported by your browser 😰 Please update it to access the experience.';
    this.webglContainer.parentElement?.append(unsupported);
  }

  showExperience() {
    this.loader.remove();
    this.nav.classList.add('visible');
    this.chat.root.classList.add('visible');
  }

  showSecret(message: string) {
    if (this.overlayOpen) this.closeOverlay();
    this.secretPanel.textContent = message;
    this.secretModal.classList.add('visible');
    this.count.textContent = this.easterEggs + '/' + this.totalEasterEggs;
    window.clearTimeout(this.secretTimer);
    this.secretTimer = window.setTimeout(() => this.closeSecret(), 10000);
    window.setTimeout(() => { this.easterEggs = Math.min(this.totalEasterEggs, this.easterEggs + 1); this.count.textContent = this.easterEggs + '/' + this.totalEasterEggs; }, 750);
  }

  incrementEasterEggs() {
    this.totalEasterEggs += 1;
    this.count.textContent = `${this.easterEggs}/${this.totalEasterEggs}`;
  }

  setMuted(muted: boolean) {
    this.soundButton.innerHTML = muted ? speakerIcon : mutedIcon;
  }

  setCharacterColor(color: string) {
    this.colorSquare.style.backgroundColor = color;
  }

  closeOverlay() {
    if (!this.overlayOpen) return;
    this.overlayOpen = false;
    this.infoModal.classList.remove('visible');
    this.nav.classList.add('visible');
    events.emit('webgl_overlay_animation', 0);
    events.emit('webgl_overlay_volume', 1);
    events.emit('webgl_character_controls_enable', true);
  }

  private toggleOverlay(name: InfoName) {
    if (this.overlayOpen) {
      this.closeOverlay();
      return;
    }
    this.overlayOpen = true;
    this.secretModal.classList.remove('visible');
    this.nav.classList.remove('visible');
    const content = this.infoContent[name];
    const paragraphs = content.paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`);
    if (name === 'about') paragraphs.push(`<p>${ORIGINAL_CREDIT}</p>`);
    this.infoPanel.innerHTML = `<h1>${escapeHtml(content.title)}</h1>${paragraphs.join('')}`;
    this.infoModal.classList.add('visible');
    events.emit('webgl_overlay_animation', 1);
    events.emit('webgl_overlay_volume', 0.4);
    events.emit('webgl_character_controls_enable', false);
  }

  private closeSecret() {
    if (!this.secretModal.classList.contains('visible')) return;
    this.secretModal.classList.remove('visible');
    if (this.easterEggs >= this.totalEasterEggs) this.toggleOverlay('congrats');
  }
}
