import { events } from '../core/events';
import { DEFAULT_CONFIG, type SceneConfig } from '../config/schema';
import { isConfigFromServer } from '../config/store';
import { emoteGroups, emoteKeyHtml } from '../scene/emotes';
import { DEFAULT_OUTFIT, PRESETS, SLOTS, sanitizeOutfit, type Outfit } from '../scene/appearance';
import { chosenName, displayName } from '../social/presence';
import { currentUser, isLoginAvailable, savedName, setName, signOut, watchUser } from '../social/auth';
import { AuthModal, nameError, normalizeName } from './authModal';
import { NAME_MAX_CHARS, NAME_MIN_CHARS, NOTICE_AUTH_FAILED, NOTICE_BAD_NAME, NOTICE_BANNED, NOTICE_LOGIN_UNAVAILABLE, NOTICE_NAME_TAKEN } from '../engine/multiplayer/socket';
import { PRESET_ICONS, itemIcon } from './itemIcons';
import { ChatPanel } from './chat';
import { NameTags } from './nametags';
import { RewardsPanel, flowerIcon } from './rewards';
import { ShopPanel, bagIcon } from './shop';
import { ScreenshotTool, cameraIcon } from './screenshot';
import { FeedbackPanel, letterIcon } from './feedback';
import { HelpPanel, helpIcon } from './help';
import { OnlineCount } from './onlineCount';
import { WelcomeLetter } from './welcomeLetter';
import { addPanelBar } from './panelBar';
import { Wardrobe } from './wardrobe';
import { mountPanelModal } from './overlay';
import { owns } from '../shop/inventory';
import { GuestSaveModal } from './guestModal';
import { itemForEmote } from '../shop/catalog';

/**
 * Clothes colours (hue of the player colour, see fragment.glsl "player color":
 * HSV with saturation 0.4, so every colour stays soft). It paints the t-shirt,
 * skirt, hair ties and hat band; shorts are khaki (appearance.ts withOutfitParts).
 */
const COLOR_PALETTE: Array<{ label: string; hue: number }> = [
  { label: 'Đỏ', hue: 0.0 },
  { label: 'Cam', hue: 0.07 },
  { label: 'Vàng', hue: 0.13 },
  { label: 'Xanh cốm', hue: 0.22 },
  { label: 'Xanh lá', hue: 0.33 },
  { label: 'Xanh ngọc', hue: 0.45 },
  { label: 'Xanh trời', hue: 0.53 },
  { label: 'Xanh dương', hue: 0.6 },
  { label: 'Chàm', hue: 0.68 },
  { label: 'Tím', hue: 0.77 },
  { label: 'Hồng', hue: 0.87 },
  { label: 'Hồng đào', hue: 0.95 },
];

/** CSS colour of the lit band of a player colour (HSV h, 0.4, 0.8 as HSL). */
const swatchColor = (hue: number) => `hsl(${Math.round(hue * 360)}, 44%, 64%)`;

/** The loader title of the last visit (the admin config's), shown before this visit's config is in. */
const LOADER_TITLE_KEY = 'dq-loader-title';

const speakerIcon = '<svg class="sound sound2" viewBox="0 0 17 13" aria-hidden="true"><path d="M10.189 0.228 6.13 3.332H4.168c-.512 0-.938.41-.938.938v4.384c0 .165.043.321.118.457L.816 10.907a1 1 0 1 0 1.157 1.631l4.153-2.946h.021l.026.02 5.756-4.082v-.054l3.694-2.62a1 1 0 0 0-1.157-1.631l-2.537 1.8V1.08c-.017-.904-1.041-1.399-1.74-.853Z" fill="#716C66"/></svg>';
const mutedIcon = '<svg class="sound sound2" viewBox="0 0 17 13" aria-hidden="true"><path d="M6.96.228 2.9 3.332H.938A.94.94 0 0 0 0 4.27v4.384c0 .511.41.938.938.938h1.979l4.042 3.104a1 1 0 0 0 1.74-.853V1.08C8.682.177 7.659-.318 6.96.228Z" fill="#716C66"/></svg>';
const infoIcon = '<svg class="info" viewBox="0 0 4 18" aria-hidden="true"><path d="M2 6a2 2 0 0 1 2 2v6.818a2 2 0 1 1-4 0V8a2 2 0 0 1 2-2ZM4 2a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z" fill="#716C66"/></svg>';
const emoteIcon = '<svg class="emote" viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M10 0a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm-3.2 6.2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm6.4 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM5.6 12a.9.9 0 0 0-.8 1.3A5.8 5.8 0 0 0 10 16.3a5.8 5.8 0 0 0 5.2-3 .9.9 0 1 0-1.6-.8A4 4 0 0 1 10 14.5a4 4 0 0 1-3.6-2 .9.9 0 0 0-.8-.5Z" fill="#716C66"/></svg>';
const closeIcon = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m1.5 1.5 15 15m0-15-15 15" stroke="#989389" stroke-width="2" stroke-linecap="round"/></svg>';
const gearIcon = '<svg class="gear" viewBox="0 0 20 20" aria-hidden="true"><g fill="#716C66"><circle cx="10" cy="10" r="6.4"/><rect x="8.3" y="1" width="3.4" height="18" rx="1"/><rect x="8.3" y="1" width="3.4" height="18" rx="1" transform="rotate(45 10 10)"/><rect x="8.3" y="1" width="3.4" height="18" rx="1" transform="rotate(90 10 10)"/><rect x="8.3" y="1" width="3.4" height="18" rx="1" transform="rotate(135 10 10)"/></g><circle cx="10" cy="10" r="2.6" fill="#f9efdc"/></svg>';
const bookIcon = '<svg class="book" viewBox="0 0 20 20" aria-hidden="true"><path d="M2 3.2C4.6 2.4 7.3 2.6 9.2 4v13c-2-1.3-4.6-1.5-7.2-.7V3.2Zm16 0c-2.6-.8-5.3-.6-7.2.8v13c2-1.3 4.6-1.5 7.2-.7V3.2Z" fill="#716C66"/></svg>';

/** A menu entry: `icon` (HTML, may be empty) then the label. */
function menuItem(menu: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const item = document.createElement('button');
  item.type = 'button';
  item.setAttribute('role', 'menuitem');
  item.innerHTML = icon;
  item.append(label);
  menu.append(item);
  return item;
}

/** Credit for the original work; fixed, not part of the remote config. */
const ORIGINAL_CREDIT =
  'Lấy cảm hứng và phát triển tiếp từ <em>Relax Afternoon</em>, một thử nghiệm WebGL của <a href="https://vlucendo.com" rel="noreferrer" target="_blank" class="link2">Vicente Lucendo</a>. Bản gốc: <a href="https://summer-afternoon.vlucendo.com" rel="noreferrer" target="_blank" class="link2">summer-afternoon.vlucendo.com</a>' +
  '<br>Mô hình chú chó: <a href="https://sketchfab.com/3d-models/doggy-meme-dog-ps1-8f9361ab396e4c21a53bc50a57a740cd" rel="noreferrer" target="_blank" class="link2">“Doggy Meme Dog PS1”</a> của <a href="https://sketchfab.com/rukitu" rel="noreferrer" target="_blank" class="link2">rukitu</a>, ' +
  '<a href="https://sketchfab.com/3d-models/dog-puppy-72331763040e4314b154f84348fe0957" rel="noreferrer" target="_blank" class="link2">“Dog Puppy”</a> của <a href="https://sketchfab.com/kenchoo" rel="noreferrer" target="_blank" class="link2">kenchoo</a>, ' +
  '<a href="https://sketchfab.com/yarelon111" rel="noreferrer" target="_blank" class="link2">“Dog”</a> của Yarelon, ' +
  '<a href="https://sketchfab.com/jessica_magno" rel="noreferrer" target="_blank" class="link2">“Low Poly Dog”</a> của Jéssica Magno (đã đổi định dạng vật liệu), giấy phép <a href="https://creativecommons.org/licenses/by/4.0/" rel="noreferrer" target="_blank" class="link2">CC BY 4.0</a>; ' +
  '<a href="https://sketchfab.com/hamsterspit" rel="noreferrer" target="_blank" class="link2">“Dog With Bomb”</a> của hamsterspit, giấy phép <a href="https://creativecommons.org/licenses/by-nc-nd/4.0/" rel="noreferrer" target="_blank" class="link2">CC BY-NC-ND 4.0</a> (phi thương mại).';

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
  private readonly online: OnlineCount;
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
    this.loader.setAttribute('role', 'status');
    this.loader.setAttribute('aria-label', 'Đang tải');
    this.loader.innerHTML = '<h1></h1><div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>';
    // No built-in title (it flashed before the admin's one arrived): the title
    // from the last visit if any, else nothing until the config is in (applyConfig).
    const loaderTitle = this.loader.querySelector('h1') as HTMLElement;
    let cachedTitle: string | null = null;
    try {
      cachedTitle = localStorage.getItem(LOADER_TITLE_KEY);
    } catch {
      /* storage blocked: wait for the config */
    }
    if (cachedTitle) loaderTitle.innerHTML = cachedTitle.split('\n').map(escapeHtml).join('<br>');
    else loaderTitle.style.visibility = 'hidden';
    root.append(this.loader);

    // Five buttons; the rest sits in the menus of ⚙ (settings) and ? (help):
    //   ⚙ Cài đặt   → Nhân vật & tủ đồ, Cửa hàng, Âm thanh
    //   🙂 Biểu cảm (E) · 🌸 Quà mỗi ngày (red dot = a reward waiting) · 📷 Chụp ảnh
    //   ? Trợ giúp  → Hướng dẫn chơi, Giới thiệu, Góp ý
    // No chat button: Enter opens the chat, touch screens tap "Chạm để chat"
    // in the chat box (chat.ts), which also shows the actions of the place.
    this.nav = document.createElement('nav');
    const navBtn = (label: string, title: string, icon: string) =>
      `<button class="button" type="button" aria-label="${label}" title="${title}">${icon}</button>`;
    this.nav.innerHTML =
      navBtn('settings', 'Cài đặt', gearIcon) +
      navBtn('emote (E)', 'Biểu cảm (E)', emoteIcon) +
      navBtn('daily rewards', 'Quà mỗi ngày', flowerIcon) +
      navBtn('screenshot', 'Chụp ảnh màn hình', cameraIcon) +
      navBtn('help', 'Trợ giúp', helpIcon) +
      '<div class="cnt">0/0</div>';
    root.append(this.nav);
    const navButton = (label: string) => this.nav.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
    this.count = this.nav.querySelector('.cnt') as HTMLDivElement;
    // Secrets counter ("0/5") hidden on screen; finding a secret still counts and shows its modal.
    this.count.hidden = true;

    // ---- ⚙ settings menu ----
    const settingsButton = navButton('settings');
    const settingsMenu = this.navMenu(settingsButton, 'Cài đặt');
    const colorButton = menuItem(settingsMenu.menu, '<span class="menu-icon"><div class="color-square"></div></span>', 'Nhân vật & tủ đồ');
    const shopButton = menuItem(settingsMenu.menu, `<span class="menu-icon">${bagIcon}</span>`, 'Cửa hàng');
    this.soundButton = menuItem(settingsMenu.menu, '', '');
    this.soundButton.dataset.keepOpen = '';
    this.soundButton.setAttribute('role', 'menuitemcheckbox');
    this.colorSquare = colorButton.querySelector('.color-square') as HTMLDivElement;
    this.setMuted(true); // audio.ts starts muted (sound needs a user gesture)
    this.soundButton.addEventListener('click', () => events.emit('webgl_audio_mute_toggle'));

    // ---- 🙂 emote menu ----
    const emoteButton = navButton('emote (E)');
    const emoteMenu = this.navMenu(emoteButton, 'Biểu cảm');
    // Grouped (scene/emotes.ts EMOTE_GROUPS); each item plays its own slot.
    for (const group of emoteGroups()) {
      const head = document.createElement('div');
      head.className = 'menu-group';
      head.setAttribute('role', 'presentation');
      head.textContent = group.title;
      emoteMenu.menu.append(head);
      for (const e of group.emotes) {
        const item = menuItem(emoteMenu.menu, emoteKeyHtml(e), e.label);
        item.addEventListener('click', () => events.emit('webgl_character_emote', e.slot));
      }
    }
    // Picnic emotes (fishing, guitar, kite, ice cream) need their item: the menu
    // does not lock them; choosing one without the item shows a notice instead.
    this.setupNotices(root);

    // ---- ? help menu ----
    const helpButton = navButton('help');
    const helpMenu = this.navMenu(helpButton, 'Trợ giúp');
    const guideButton = menuItem(helpMenu.menu, `<span class="menu-icon">${bookIcon}</span>`, 'Hướng dẫn chơi');
    const aboutButton = menuItem(helpMenu.menu, `<span class="menu-icon">${infoIcon}</span>`, 'Giới thiệu');
    const feedbackButton = menuItem(helpMenu.menu, `<span class="menu-icon">${letterIcon}</span>`, 'Góp ý');
    aboutButton.addEventListener('click', () => this.toggleOverlay('about'));

    this.authModal = new AuthModal(root);
    // Any modal overlay (nav panels, sign-in; see overlay.ts) hides the nav, like the info modal.
    events.on('ui_overlay', (open: boolean) => this.nav.classList.toggle('visible', !open));
    // "Nhân vật & tủ đồ" opens the character panel (with the wardrobe).
    this.setupLookMenu(colorButton);

    new NameTags(root);
    this.online = new OnlineCount(root);
    this.chat = new ChatPanel(root, () => !this.overlayOpen && !this.authModal.isOpen);
    const openAuth = (mode: 'login' | 'register') => this.authModal.open(mode);
    new RewardsPanel(this.nav, navButton('daily rewards'), openAuth);
    new ShopPanel(this.nav, shopButton, openAuth);
    new ScreenshotTool(navButton('screenshot'));
    new HelpPanel(this.nav.parentElement ?? this.nav, guideButton);
    new FeedbackPanel(this.nav, feedbackButton);
    // A thank-you letter for coming by, once connected (once per visit).
    new WelcomeLetter(root);
    // Guests: "Lưu dữ liệu của bạn" modal at the first flower / item (instead of a browser prompt on close).
    new GuestSaveModal(this.nav.parentElement ?? this.nav, () => openAuth('register'), () => openAuth('login'));

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

  /**
   * A small menu popping out to the left of a nav button (emotes, settings,
   * help). One menu open at a time; it closes on a pick (unless the item has
   * `data-keep-open`, like the sound toggle), outside presses and Escape.
   */
  private readonly menus: Array<(open: boolean) => void> = [];
  private navMenu(button: HTMLButtonElement, label: string) {
    const menu = document.createElement('div');
    menu.className = 'emote-menu nav-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', label);
    this.nav.append(menu);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const setOpen = (open: boolean) => {
      if (open) this.menus.forEach((close) => close(false));
      menu.style.top = `${button.offsetTop - 4}px`;
      menu.classList.toggle('open', open);
      button.setAttribute('aria-expanded', String(open));
    };
    this.menus.push(setOpen);
    button.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
    // Bubbles after the item's own handlers (which may open a panel).
    menu.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
      if (item && item.dataset.keepOpen === undefined) setOpen(false);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!menu.contains(e.target as Node) && !button.contains(e.target as Node)) setOpen(false);
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') setOpen(false);
    });
    return { menu, setOpen };
  }

  /**
   * Character panel ("Nhân vật & tủ đồ" in the settings menu), two tabs:
   *   - Nhân vật: boy / girl presets and hair style.
   *   - Tủ đồ: every item the player has in one picture grid ordered by type
   *     (Wardrobe), then the clothes colour and a link to the shop.
   */
  private setupLookMenu(button: HTMLButtonElement) {
    let outfit: Outfit = [...DEFAULT_OUTFIT];
    const panel = document.createElement('div');
    panel.className = 'look-menu character-menu';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Nhân vật và tủ đồ');
    const body = addPanelBar(panel, 'Nhân vật', () => setOpen(false));
    // Title greets the player by display name ("Người dùng ẩn danh <id>" for guests).
    const title = panel.querySelector('.panel-bar b') as HTMLElement;
    const renderTitle = () => {
      title.textContent = `Xin chào ${displayName('local')}`;
    };
    events.on('social_names_changed', renderTitle);
    events.on('mp_connected', renderTitle);
    watchUser(renderTitle);
    renderTitle();

    const tabs = document.createElement('div');
    tabs.className = 'look-group character-tabs';
    tabs.setAttribute('role', 'tablist');
    const lookTab = document.createElement('button');
    const wardrobeTab = document.createElement('button');
    for (const tab of [lookTab, wardrobeTab]) {
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tabs.append(tab);
    }
    lookTab.textContent = 'Nhân vật';
    const content = document.createElement('div');
    content.className = 'panel-content look-grid';
    content.setAttribute('role', 'tabpanel');
    const wardrobe = new Wardrobe(() => setOpen(false));
    const wardrobePane = document.createElement('div');
    wardrobePane.className = 'panel-content wardrobe-pane';
    wardrobePane.setAttribute('role', 'tabpanel');
    body.append(this.createAccountSection(), tabs, content, wardrobePane);
    let tab: 'look' | 'wardrobe' = 'look';
    const renderTabs = () => {
      const count = wardrobe.count;
      wardrobeTab.textContent = count ? `Tủ đồ (${count})` : 'Tủ đồ';
      lookTab.setAttribute('aria-selected', String(tab === 'look'));
      wardrobeTab.setAttribute('aria-selected', String(tab === 'wardrobe'));
      content.hidden = tab !== 'look';
      wardrobePane.hidden = tab !== 'wardrobe';
    };
    const setTab = (next: typeof tab) => {
      tab = next;
      if (next === 'look') wardrobe.highlight = '';
      wardrobe.render();
      render();
      renderTabs();
    };
    lookTab.addEventListener('click', () => setTab('look'));
    wardrobeTab.addEventListener('click', () => setTab('wardrobe'));
    events.on('inventory_changed', renderTabs);
    renderTabs();

    const colorRow = this.createColorRow();
    const renderers: Array<() => void> = [];
    /**
     * `ids` (catalog item per button): items not owned are hidden. `icons`:
     * a picture per button (the label becomes its tooltip);  keeps the text.
     */
    const group = (target: HTMLElement, title: string, labels: string[], pick: (i: number) => Outfit, pressed: (i: number) => boolean, ids?: string[], icons?: string[]) => {
      const section = document.createElement('div');
      section.className = 'look-group';
      const heading = document.createElement('span');
      heading.textContent = title;
      section.append(heading);
      const buttons = labels.map((label, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        const icon = icons?.[i];
        if (icon) {
          b.className = 'look-item';
          b.innerHTML = icon;
          b.title = label;
          b.setAttribute('aria-label', label);
        } else {
          b.textContent = label;
        }
        b.addEventListener('click', () => {
          const id = ids?.[i];
          if (id && !owns(id)) return; // hidden anyway (not in the wardrobe)
          events.emit('webgl_character_outfit', pick(i));
        });
        section.append(b);
        return b;
      });
      renderers.push(() =>
        buttons.forEach((b, i) => {
          b.setAttribute('aria-pressed', String(pressed(i)));
          // Only what the player may wear: free basics + items in the wardrobe.
          // Everything else is bought in the shop (bag button).
          const id = ids?.[i];
          b.hidden = !!id && !owns(id);
          // Opened from the shop on an item already bought: point it out.
          b.classList.toggle('highlight', !!id && id === wardrobe.highlight);
        }),
      );
      target.append(section);
    };
    group(content, 'Nam / nữ', PRESETS.map((p) => p.label), (i) => PRESETS[i].apply(outfit), (i) => PRESETS[i].is(outfit), undefined, PRESET_ICONS);
    // Hair goes with the body; every other slot is in the Tủ đồ grid (Wardrobe).
    SLOTS.forEach((slot, s) => {
      if (slot.id !== 'hair') return;
      group(content, slot.label, slot.items.map((it) => it.label), (i) => {
        const next = [...outfit];
        next[s] = i;
        return sanitizeOutfit(next);
      }, (i) => outfit[s] === i, slot.items.map((it) => it.id), slot.items.map((it) => itemIcon(it.id)));
    });
    wardrobePane.append(wardrobe.root, colorRow, wardrobe.footer);
    const showModal = mountPanelModal(panel, this.nav.parentElement ?? this.nav);
    const render = () => renderers.forEach((r) => r());
    events.on('webgl_character_update_outfit', (value: Outfit) => {
      outfit = sanitizeOutfit(value);
      render();
    });
    events.on('inventory_changed', render);
    render();
    const setOpen = (open: boolean) => {
      panel.classList.toggle('open', open);
      showModal(open);
      button.setAttribute('aria-expanded', String(open));
      if (!open) wardrobe.highlight = '';
    };
    /** The shop sends owned items here (opened on an item already bought). */
    events.on('wardrobe_open', (id?: string) => {
      wardrobe.highlight = id ?? '';
      setTab('wardrobe');
      setOpen(true);
      panel.querySelector('.wardrobe-pane .highlight')?.scrollIntoView({ block: 'nearest' });
    });
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
   * Clothes colour: one swatch per palette hue + a random one (which also
   * changes the skin tone). The game remembers the pick (characters.ts).
   */
  private createColorRow(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'look-group color-group';
    const heading = document.createElement('span');
    heading.textContent = 'Màu áo';
    section.append(heading);
    const swatches = COLOR_PALETTE.map(({ label, hue }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.style.backgroundColor = swatchColor(hue);
      b.addEventListener('click', () => events.emit('webgl_character_set_color', hue));
      section.append(b);
      return b;
    });
    const random = document.createElement('button');
    random.type = 'button';
    random.className = 'swatch swatch-random';
    random.title = 'Ngẫu nhiên (cả màu da)';
    random.setAttribute('aria-label', 'Màu ngẫu nhiên');
    random.textContent = '🎲';
    random.addEventListener('click', () => events.emit('webgl_character_randomize_color'));
    section.append(random);
    events.on('webgl_character_update_color', (_css: string, hue?: number) => {
      swatches.forEach((b, i) => b.setAttribute('aria-pressed', String(hue !== undefined && Math.abs(COLOR_PALETTE[i].hue - hue) < 0.005)));
    });
    return section;
  }

  /**
   * Short notices at the top of the screen (one at a time), with an optional button:
   *   - "Bạn cần có [vật phẩm]" when an emote needs an item the player does not
   *     have (menu, keys or gamepad; engine/characters.ts emits
   *     webgl_emote_locked). The emote does not play; the button opens the shop.
   *   - Guests (no account): after signing up the relay moves the guest
   *     wallet into the account (result.sync). The warning about losing it
   *     is the GuestSaveModal (guestModal.ts).
   */
  private setupNotices(root: HTMLElement) {
    const notice = document.createElement('div');
    notice.id = 'item-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    notice.innerHTML = '<span></span><button type="button"></button>';
    const text = notice.querySelector('span') as HTMLElement;
    const button = notice.querySelector('button') as HTMLButtonElement;
    root.append(notice);
    let onButton: (() => void) | null = null;
    let timer = 0;
    const hide = () => notice.classList.remove('show');
    const show = (message: string, ms: number, action?: { label: string; run: () => void }) => {
      text.textContent = message;
      button.hidden = !action;
      button.textContent = action?.label ?? '';
      onButton = action?.run ?? null;
      notice.classList.add('show');
      window.clearTimeout(timer);
      timer = window.setTimeout(hide, ms);
    };
    button.addEventListener('click', () => {
      hide();
      onButton?.();
    });

    events.on('webgl_emote_locked', (state: number) => {
      const item = itemForEmote(state);
      if (item) show(`Bạn cần có ${item.label}`, 3500, { label: 'Cửa hàng', run: () => events.emit('shop_open', item.id) });
    });

    // Guest wallet synced (or not) after signing up / in.
    events.on('mp_wallet', (wallet: { result?: { sync?: string } } | null) => {
      const sync = wallet?.result?.sync;
      if (sync === 'adopted') show('Đã đồng bộ hoa và đồ vào tài khoản ✓', 4500);
      else if (sync === 'skipped') show('Tài khoản đã có dữ liệu: hoa và đồ ẩn danh không được gộp.', 6000);
    });
  }

  /**
   * Account card at the top of the character panel:
   *   - signed in: display name + email, "Đổi tên" (relay-verified, see
   *     setName) and "Đăng xuất" (click twice);
   *   - guest: "Người dùng ẩn danh <id>", "Đăng ký" / "Đăng nhập";
   *   - no Firebase config: only says accounts are off.
   */
  private createAccountSection(): HTMLElement {
    const section = document.createElement('div');
    section.className = 'look-group account-card';
    section.innerHTML =
      '<div class="account-info"><b class="account-name"></b><small class="account-sub"></small></div>' +
      '<div class="account-actions"></div>' +
      '<form class="account-rename" hidden><input type="text" autocomplete="nickname" aria-label="Tên hiển thị mới"><button type="submit" class="primary">Lưu</button><button type="button" data-act="cancel">Huỷ</button></form>' +
      '<small class="account-status" aria-live="polite"></small>';
    const nameEl = section.querySelector('.account-name') as HTMLElement;
    const sub = section.querySelector('.account-sub') as HTMLElement;
    const actions = section.querySelector('.account-actions') as HTMLElement;
    const form = section.querySelector('.account-rename') as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    const status = section.querySelector('.account-status') as HTMLElement;
    input.maxLength = NAME_MAX_CHARS * 2; // code points are checked on submit

    let statusTimer = 0;
    const say = (text: string, ms = 0) => {
      status.textContent = text;
      window.clearTimeout(statusTimer);
      if (ms) statusTimer = window.setTimeout(() => (status.textContent = ''), ms);
    };
    /** Name sent to the relay, waiting for its echo. */
    let pending = '';
    let pendingTimer = 0;
    /** "Đăng xuất" needs a second click within a few seconds. */
    let signOutArmed = false;
    let armTimer = 0;

    const render = () => {
      const user = currentUser();
      nameEl.textContent = displayName('local');
      if (!isLoginAvailable()) {
        sub.textContent = 'Đang chơi ẩn danh · máy chủ chưa bật tài khoản';
        actions.innerHTML = '';
        form.hidden = true;
        return;
      }
      if (user) {
        sub.textContent = user.email ?? '';
        actions.innerHTML = form.hidden
          ? `<button type="button" data-act="rename">Đổi tên</button><button type="button" data-act="signout"${signOutArmed ? ' class="danger"' : ''}>${signOutArmed ? 'Bấm lần nữa để đăng xuất' : 'Đăng xuất'}</button>`
          : '';
      } else {
        form.hidden = true;
        sub.textContent = 'Chưa đăng nhập · hoa và đồ chỉ lưu trong tab này';
        actions.innerHTML = '<button type="button" class="primary" data-act="register">Đăng ký</button><button type="button" data-act="login">Đăng nhập</button>';
      }
    };
    const closeForm = () => {
      form.hidden = true;
      render();
    };

    section.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]')?.dataset.act;
      if (!act) return;
      const user = currentUser();
      if (act === 'register' || act === 'login') {
        this.authModal.open(act);
      } else if (act === 'rename' && user) {
        say('');
        input.value = chosenName('local') || savedName(user.uid);
        form.hidden = false;
        render();
        input.focus();
        input.select();
      } else if (act === 'cancel') {
        say('');
        closeForm();
      } else if (act === 'signout') {
        if (!signOutArmed) {
          signOutArmed = true;
          window.clearTimeout(armTimer);
          armTimer = window.setTimeout(() => {
            signOutArmed = false;
            render();
          }, 3000);
          render();
          return;
        }
        signOutArmed = false;
        window.clearTimeout(armTimer);
        say('Đã đăng xuất.', 3000);
        void signOut();
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const user = currentUser();
      if (!user) return;
      const name = normalizeName(input.value);
      const bad = nameError(name);
      if (bad) {
        say(bad);
        input.focus();
        return;
      }
      if (name === chosenName('local')) {
        closeForm();
        return;
      }
      pending = name;
      say('Đang lưu…');
      setName(user, name);
      // The relay ignores renames closer than a few seconds apart: do not wait forever.
      window.clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(() => {
        if (!pending) return;
        pending = '';
        say('Chưa đổi được tên, đợi vài giây rồi thử lại nhé.');
      }, 6000);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        say('');
        closeForm();
      }
    });

    events.on('social_names_changed', () => {
      if (pending && chosenName('local') === pending) {
        pending = '';
        window.clearTimeout(pendingTimer);
        form.hidden = true;
        say('Đã đổi tên ✓', 3000);
      }
      render();
    });
    events.on('mp_connected', render);
    events.on('mp_notice', (code: number) => {
      if (code === NOTICE_BANNED) say('Tài khoản đã bị khoá.');
      else if (code === NOTICE_AUTH_FAILED) say('Máy chủ không xác thực được tài khoản.');
      // Also after sign-up / sign-in with a saved name (no rename pending).
      else if (code === NOTICE_NAME_TAKEN) say('Tên này đang có người dùng hoặc không được phép, chọn tên khác nhé.');
      else if (!pending) return;
      else if (code === NOTICE_BAD_NAME) say(`Tên không hợp lệ (${NAME_MIN_CHARS}–${NAME_MAX_CHARS} ký tự, có chữ hoặc số, không dùng từ ngữ thô tục).`);
      else if (code === NOTICE_LOGIN_UNAVAILABLE) say('Máy chủ chưa bật tài khoản (FIREBASE_PROJECT_ID).');
      else return;
      pending = '';
      window.clearTimeout(pendingTimer);
    });
    watchUser(() => {
      signOutArmed = false;
      render();
    });
    render();
    return section;
  }

  /** Apply UI texts from the remote config (safe to call repeatedly). */
  applyConfig(config: SceneConfig) {
    const { ui } = config;
    const title = this.loader.querySelector('h1');
    const fromServer = isConfigFromServer();
    // Built-in defaults (Firestore slow / offline) never replace the title
    // remembered from the admin's config, and are not remembered themselves.
    if (title && (fromServer || title.style.visibility === 'hidden')) {
      title.innerHTML = ui.loaderTitle.split('\n').map(escapeHtml).join('<br>');
      title.style.visibility = '';
    }
    if (fromServer) {
      try {
        localStorage.setItem(LOADER_TITLE_KEY, ui.loaderTitle);
      } catch {
        /* storage blocked: no title until the config next time */
      }
    }
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
    // Fade the loader out over the scene instead of cutting to it.
    const loader = this.loader;
    loader.classList.add('hidden');
    const done = () => loader.remove();
    loader.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 1200); // no transition (reduced motion, hidden tab)
    this.nav.classList.add('visible');
    this.chat.root.classList.add('visible');
    this.online.root.classList.add('visible');
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
    // speakerIcon is the crossed-out one (shown while muted).
    this.soundButton.innerHTML = `<span class="menu-icon">${muted ? speakerIcon : mutedIcon}</span>`;
    this.soundButton.append(muted ? 'Âm thanh: Tắt' : 'Âm thanh: Bật');
    this.soundButton.setAttribute('aria-checked', String(!muted));
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
