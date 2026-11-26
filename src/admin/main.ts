// Admin panel: sign in with Firebase Auth (email/password), edit the scene
// config, save it to Firestore `config/scene`. Only uids listed in the
// `admins` collection can write (enforced by firestore.rules, checked here
// only to show a helpful message).
//
// Layout: a sidebar menu (overview, user management, one entry per config
// section, raw JSON) and a content area for the selected page. The page is kept in the URL hash
// (#/<id>) so a reload stays on the same page.

import './admin.css';
import type { User } from 'firebase/auth';
import { DEFAULT_CONFIG, mergeWithDefaults, type SceneConfig } from '../config/schema';
import {
  ADMINS_COLLECTION,
  CONFIG_COLLECTION,
  CONFIG_DOC,
  firebaseOptions,
  getFirebaseApp,
  isFirebaseConfigured,
} from '../config/firebase';
import { SECTIONS, type Field, type Section } from './fields';
import { icon, type IconName } from './icons';
import { el } from './dom';
import { createAdminApi, serverBase } from './api';
import { createUserPages } from './users';

const root = document.getElementById('admin')!;
const APP_TITLE = 'SummerTime Admin';

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce((o, k) => (o[k] ??= {}), obj);
  target[last] = value;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Menu entries

interface Route {
  id: string;
  group: string;
  icon: IconName;
  title: string;
  navLabel: string;
  description?: string;
  section?: Section;
}

const ROUTES: Route[] = [
  {
    id: 'overview',
    group: '',
    icon: 'home',
    title: 'Tổng quan',
    navLabel: 'Tổng quan',
    description: 'Tình trạng server multiplayer và cấu hình hiện tại.',
  },
  {
    id: 'users',
    group: 'Người dùng',
    icon: 'users',
    title: 'Tài khoản người chơi',
    navLabel: 'Tài khoản',
    description: 'Hồ sơ được tạo khi người chơi đăng nhập vào game. Khoá tài khoản, cấp hoặc thu quyền admin.',
  },
  {
    id: 'online',
    group: 'Người dùng',
    icon: 'activity',
    title: 'Người chơi đang online',
    navLabel: 'Đang online',
    description: 'Các kết nối hiện tại trên server multiplayer, theo phòng.',
  },
  ...SECTIONS.map((s): Route => ({
    id: s.id,
    group: s.group,
    icon: s.icon,
    title: s.title,
    navLabel: s.navLabel ?? s.title,
    description: s.description,
    section: s,
  })),
  {
    id: 'json',
    group: 'Hệ thống',
    icon: 'code',
    title: 'Dữ liệu JSON',
    navLabel: 'Dữ liệu JSON',
    description: 'Bản nháp cấu hình hiện tại (gồm cả thay đổi chưa lưu) dưới dạng JSON.',
  },
];

// ---------------------------------------------------------------------------

if (!isFirebaseConfigured()) {
  root.append(
    el('main', { className: 'card narrow' }, [
      el('h1', { textContent: 'Chưa cấu hình Firebase' }),
      el('p', { textContent: 'Tạo file .env ở thư mục gốc dự án (xem .env.example), điền các giá trị VITE_FIREBASE_* rồi khởi động lại npm run dev.' }),
    ]),
  );
} else {
  void boot();
}

async function boot() {
  const app = await getFirebaseApp();
  const { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } = await import('firebase/auth');
  const fs = await import('firebase/firestore');
  const { getFirestore, doc, getDoc, setDoc, serverTimestamp } = fs;
  const auth = getAuth(app);
  const db = getFirestore(app);
  const configRef = doc(db, CONFIG_COLLECTION, CONFIG_DOC);

  // Listeners and timers of the signed-in view are tied to this controller so
  // signing out (or switching account) removes them.
  let session: AbortController | null = null;

  onAuthStateChanged(auth, (user) => {
    session?.abort();
    session = new AbortController();
    root.replaceChildren();
    document.title = APP_TITLE;
    if (user) void renderEditor(user, session.signal);
    else renderLogin();
  });

  function renderLogin() {
    const email = el('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'admin@example.com' });
    const password = el('input', { type: 'password', required: true, autocomplete: 'current-password' });
    const error = el('p', { className: 'error' });
    const submit = el('button', { type: 'submit', className: 'primary', textContent: 'Đăng nhập' });
    const form = el('form', { className: 'card narrow' }, [
      el('div', { className: 'brand' }, [
        el('div', { className: 'brand-mark', textContent: 'S' }),
        el('div', {}, [el('h1', { textContent: APP_TITLE }), el('p', { className: 'muted', textContent: `Project: ${firebaseOptions.projectId}` })]),
      ]),
      el('label', {}, ['Email', email]),
      el('label', {}, ['Mật khẩu', password]),
      error,
      submit,
    ]);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await signInWithEmailAndPassword(auth, email.value.trim(), password.value);
      } catch (err: any) {
        error.textContent = `Đăng nhập thất bại: ${err?.code ?? err}`;
        submit.disabled = false;
      }
    });
    root.append(form);
  }

  async function renderEditor(user: User, signal: AbortSignal) {
    let isAdmin = false;
    try {
      isAdmin = (await getDoc(doc(db, ADMINS_COLLECTION, user.uid))).exists();
    } catch {
      isAdmin = false;
    }
    if (signal.aborted) return;

    // --- State --------------------------------------------------------------
    let draft: SceneConfig = structuredClone(DEFAULT_CONFIG);
    /** Last config read from / written to the server; null if none exists. */
    let saved: SceneConfig | null = null;
    let savedJson = '';
    let meta: { updatedAt?: Date; updatedBy?: string } = {};
    let online: { players: number; rooms: Record<string, number> } | 'error' | null = null;
    let current: Route = ROUTES[0];
    /** Aborted whenever another page is shown (stops that page's timers). */
    let pageCtrl = new AbortController();
    signal.addEventListener('abort', () => pageCtrl.abort());

    const api = createAdminApi(
      () => serverBase(draft.features.multiplayerUrl || import.meta.env.VITE_MULTIPLAYER_URL || ''),
      () => user.getIdToken(),
    );
    const userPages = createUserPages({ db, fs, me: user, isAdmin, api });

    // --- Sidebar ------------------------------------------------------------
    const navLinks = new Map<string, HTMLAnchorElement>();
    const nav = el('nav', { className: 'nav', ariaLabel: 'Menu quản trị' });
    let lastGroup: string | undefined;
    for (const r of ROUTES) {
      if (r.group !== lastGroup) {
        lastGroup = r.group;
        if (r.group) nav.append(el('div', { className: 'nav-group-title', textContent: r.group }));
      }
      const link = el('a', { href: `#/${r.id}`, className: 'nav-item' }, [
        icon(r.icon),
        el('span', { className: 'nav-label', textContent: r.navLabel }),
        el('span', { className: 'dot', title: 'Có thay đổi chưa lưu' }),
      ]);
      navLinks.set(r.id, link);
      nav.append(link);
    }

    const logoutBtn = el('button', { type: 'button', className: 'ghost icon-btn', title: 'Đăng xuất', ariaLabel: 'Đăng xuất' }, [icon('logout')]);
    const account = user.email ?? user.uid;
    const sidebar = el('aside', { className: 'sidebar' }, [
      el('div', { className: 'brand' }, [
        el('div', { className: 'brand-mark', textContent: 'S' }),
        el('div', {}, [el('strong', { textContent: 'SummerTime' }), el('small', { className: 'muted', textContent: `Admin · ${firebaseOptions.projectId}` })]),
      ]),
      nav,
      el('div', { className: 'sidebar-footer' }, [
        el('a', { href: '/', target: '_blank', rel: 'noopener', className: 'nav-item' }, [icon('external'), el('span', { className: 'nav-label', textContent: 'Mở game' })]),
        el('div', { className: 'account' }, [
          el('div', { className: 'avatar', textContent: account.charAt(0).toUpperCase() }),
          el('div', { className: 'account-info' }, [
            el('span', { className: 'account-name', textContent: account, title: account }),
            el('small', { className: 'muted', textContent: isAdmin ? 'Quản trị viên' : 'Chỉ xem' }),
          ]),
          logoutBtn,
        ]),
      ]),
    ]);

    // --- Top bar ------------------------------------------------------------
    const menuBtn = el('button', { type: 'button', className: 'ghost icon-btn menu-btn', title: 'Menu', ariaLabel: 'Mở menu' }, [icon('menu')]);
    const crumb = el('div', { className: 'crumb' });
    const status = el('span', { className: 'status' });
    const onlinePill = el('span', { className: 'pill' });
    const resetSectionBtn = el('button', { type: 'button', textContent: 'Về mặc định', title: 'Đưa các trường của mục này về giá trị mặc định' });
    const reloadBtn = el('button', { type: 'button', textContent: 'Tải lại' });
    const saveBtn = el('button', { type: 'button', className: 'primary', textContent: 'Lưu', disabled: !isAdmin, title: 'Lưu (Ctrl/⌘ + S)' });
    const topbar = el('header', { className: 'topbar' }, [
      menuBtn,
      el('div', { className: 'topbar-title' }, [crumb, status]),
      el('div', { className: 'actions' }, [onlinePill, resetSectionBtn, reloadBtn, saveBtn]),
    ]);

    // --- Content ------------------------------------------------------------
    const page = el('div', { className: 'page' });
    const content = el('main', { className: 'content' });
    if (!isAdmin) {
      content.append(
        el('div', { className: 'banner' }, [
          el('strong', { textContent: 'Tài khoản này chưa có quyền ghi. ' }),
          'Trong Firestore Console, tạo document ',
          el('code', { textContent: `${ADMINS_COLLECTION}/${user.uid}` }),
          ' (nội dung tuỳ ý), rồi tải lại trang này.',
        ]),
      );
    }
    content.append(page);

    const backdrop = el('div', { className: 'backdrop' });
    const layout = el('div', { className: 'layout' }, [sidebar, backdrop, el('div', { className: 'main' }, [topbar, content])]);
    root.append(layout);

    // --- Status / dirty tracking -------------------------------------------
    const setStatus = (text: string, kind: '' | 'ok' | 'warn' | 'error' = '') => {
      status.textContent = text;
      status.dataset.kind = kind;
    };
    const isDirty = () => JSON.stringify(draft) !== savedJson;
    const sectionDirty = (s: Section) => {
      const base = saved;
      return base !== null && s.fields.some((f) => !same(getPath(draft, f.path), getPath(base, f.path)));
    };
    const updateDirty = () => {
      const dirty = isDirty();
      setStatus(dirty ? 'Có thay đổi chưa lưu' : 'Đã đồng bộ', dirty ? 'warn' : 'ok');
      for (const r of ROUTES) {
        if (r.section) navLinks.get(r.id)!.classList.toggle('dirty', sectionDirty(r.section));
      }
    };

    // --- Pages ----------------------------------------------------------------
    const renderPage = () => {
      const r = current;
      for (const [id, link] of navLinks) {
        if (id === r.id) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
      crumb.replaceChildren(
        ...(r.group ? [el('span', { className: 'muted', textContent: r.group }), icon('chevron')] : []),
        el('strong', { textContent: r.navLabel }),
      );
      document.title = `${r.title} · ${APP_TITLE}`;
      resetSectionBtn.hidden = !r.section;
      reloadBtn.hidden = r.id === 'users' || r.id === 'online';
      pageCtrl.abort();
      pageCtrl = new AbortController();

      const header = el('div', { className: 'page-header' }, [el('h2', { textContent: r.title })]);
      if (r.description) header.append(el('p', { className: 'muted', textContent: r.description }));

      let body: Node[];
      if (r.section) body = renderSection(r.section);
      else if (r.id === 'users') body = userPages.renderUsersPage(pageCtrl.signal);
      else if (r.id === 'online') body = userPages.renderOnlinePage(pageCtrl.signal);
      else if (r.id === 'json') body = renderJson();
      else body = renderOverview();
      page.replaceChildren(header, ...body);
      updateDirty();
    };

    const renderSection = (section: Section): Node[] => {
      const grid = el('div', { className: 'grid' });
      for (const field of section.fields) grid.append(renderField(field));
      return [
        el('p', { className: 'legend muted' }, [
          el('span', { className: 'badge live', textContent: 'realtime' }),
          ' áp dụng ngay cho người đang chơi · ',
          el('span', { className: 'badge reload', textContent: 'tải lại' }),
          ' người chơi thấy sau khi tải lại trang',
        ]),
        el('div', { className: 'card' }, [grid]),
      ];
    };

    const renderField = (field: Field): HTMLElement => {
      const value = getPath(draft, field.path);
      const commit = (v: unknown) => {
        setPath(draft, field.path, v);
        updateDirty();
      };
      const num = (input: HTMLInputElement, fallback: number) => {
        const v = parseFloat(input.value);
        return Number.isFinite(v) ? v : fallback;
      };
      const numberInput = (v: number, onChange: (input: HTMLInputElement) => void) => {
        const input = el('input', { type: 'number', value: String(v) });
        if (field.step !== undefined) input.step = String(field.step);
        if (field.min !== undefined) input.min = String(field.min);
        if (field.max !== undefined) input.max = String(field.max);
        input.addEventListener('input', () => onChange(input));
        return input;
      };

      let control: HTMLElement;
      switch (field.kind) {
        case 'text': {
          const input = el('input', { type: 'text', value: String(value ?? '') });
          input.addEventListener('input', () => commit(input.value));
          control = input;
          break;
        }
        case 'multiline': {
          const input = el('textarea', { rows: 3, value: String(value ?? '') });
          input.addEventListener('input', () => commit(input.value));
          control = input;
          break;
        }
        case 'paragraphs': {
          const input = el('textarea', { rows: 4, value: (value as string[]).join('\n') });
          input.addEventListener('input', () =>
            commit(input.value.split('\n').map((l) => l.trim()).filter(Boolean)),
          );
          control = input;
          break;
        }
        case 'number': {
          control = numberInput(value as number, (input) => commit(num(input, value as number)));
          break;
        }
        case 'color': {
          const picker = el('input', { type: 'color', value: String(value) });
          const hex = el('input', { type: 'text', value: String(value), className: 'hex', maxLength: 7 });
          picker.addEventListener('input', () => {
            hex.value = picker.value;
            commit(picker.value);
          });
          hex.addEventListener('input', () => {
            if (/^#[0-9a-f]{6}$/i.test(hex.value)) {
              picker.value = hex.value;
              commit(hex.value.toLowerCase());
            }
          });
          control = el('div', { className: 'row' }, [picker, hex]);
          break;
        }
        case 'bool': {
          const input = el('input', { type: 'checkbox', checked: Boolean(value) });
          input.addEventListener('change', () => commit(input.checked));
          control = input;
          break;
        }
        case 'shopItem': {
          const item = value as { price: number; enabled: boolean };
          const price = el('input', { type: 'number', value: String(item.price), min: '0', step: '1', ariaLabel: `Giá ${field.label}` });
          price.addEventListener('input', () => {
            const v = Math.round(num(price, NaN));
            if (Number.isFinite(v) && v >= 0) commit({ ...(getPath(draft, field.path) as object), price: v });
          });
          const enabled = el('input', { type: 'checkbox', checked: item.enabled });
          enabled.addEventListener('change', () => commit({ ...(getPath(draft, field.path) as object), enabled: enabled.checked }));
          control = el('div', { className: 'row shop-item' }, [
            price,
            el('span', { className: 'muted', textContent: 'hoa' }),
            el('label', { className: 'shop-enabled' }, [enabled, 'Đang bán']),
          ]);
          break;
        }
        case 'vec3': {
          const vec = value as number[];
          const inputs = vec.map((v, i) =>
            numberInput(v, (input) => {
              const next = [...(getPath(draft, field.path) as number[])];
              next[i] = num(input, next[i]);
              commit(next);
            }),
          );
          control = el('div', { className: 'row vec3' }, inputs);
          break;
        }
      }

      const badge = el('span', {
        className: `badge ${field.reload ? 'reload' : 'live'}`,
        textContent: field.reload ? 'tải lại' : 'realtime',
      });
      const label = el('div', { className: 'field-label' }, [el('span', { textContent: field.icon ? `${field.icon} ${field.label}` : field.label }), badge]);
      const wrap = el('div', { className: `field ${field.kind}` }, [label, control]);
      if (field.hint) wrap.append(el('small', { className: 'muted', textContent: field.hint }));
      return wrap;
    };

    // Overview: stat tiles, section list, rooms and quick actions.
    let onlineTile: HTMLElement | null = null;
    let roomsCard: HTMLElement | null = null;

    const stat = (label: string, value: string, hint: string, kind = '') =>
      el('div', { className: 'card stat' }, [
        el('span', { className: 'stat-label', textContent: label }),
        el('strong', { className: 'stat-value', textContent: value }),
        el('small', { className: `stat-hint ${kind}`, textContent: hint }),
      ]);

    const makeOnlineTile = () => {
      if (online === null) return stat('Người chơi online', '…', 'Đang kết nối server multiplayer');
      if (online === 'error') return stat('Người chơi online', '—', 'Không kết nối được server multiplayer', 'error');
      const rooms = Object.keys(online.rooms).length;
      return stat('Người chơi online', String(online.players), `${rooms} phòng đang hoạt động`, 'ok');
    };

    const makeRoomsCard = () => {
      const card = el('section', { className: 'card' }, [el('h3', { textContent: 'Phòng đang hoạt động' })]);
      const rooms = online && online !== 'error' ? Object.entries(online.rooms) : [];
      if (rooms.length === 0) {
        card.append(el('p', { className: 'muted', textContent: online === 'error' ? 'Không lấy được dữ liệu.' : 'Không có phòng nào.' }));
      } else {
        card.append(
          el('ul', { className: 'rooms' }, rooms.map(([room, n]) =>
            el('li', {}, [el('span', { textContent: room }), el('strong', { textContent: String(n) })]),
          )),
        );
      }
      return card;
    };

    const renderOverview = (): Node[] => {
      const dirtySections = SECTIONS.filter(sectionDirty);
      const configTile = saved === null
        ? stat('Cấu hình', 'Chưa có', 'Server chưa có config, đang dùng mặc định', 'warn')
        : isDirty()
          ? stat('Cấu hình', 'Chưa lưu', `${dirtySections.length} mục có thay đổi`, 'warn')
          : stat('Cấu hình', 'Đã đồng bộ', 'Khớp với dữ liệu trên server', 'ok');
      const updatedTile = stat(
        'Cập nhật lần cuối',
        meta.updatedAt ? meta.updatedAt.toLocaleDateString('vi-VN') : '—',
        meta.updatedAt
          ? `${meta.updatedAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}${meta.updatedBy ? ` · ${meta.updatedBy}` : ''}`
          : 'Chưa có thông tin',
      );
      const roleTile = stat('Quyền', isAdmin ? 'Quản trị viên' : 'Chỉ xem', isAdmin ? 'Được phép lưu cấu hình' : 'Chưa có trong collection admins', isAdmin ? 'ok' : 'warn');
      onlineTile = makeOnlineTile();
      roomsCard = makeRoomsCard();

      const sectionList = el('section', { className: 'card' }, [
        el('h3', { textContent: 'Mục cấu hình' }),
        el('div', { className: 'section-list' }, SECTIONS.map((s) =>
          el('a', { href: `#/${s.id}`, className: 'section-row' }, [
            icon(s.icon),
            el('span', { className: 'section-row-title' }, [
              el('span', { textContent: s.title }),
              el('small', { className: 'muted', textContent: `${s.group} · ${s.fields.length} trường` }),
            ]),
            ...(sectionDirty(s) ? [el('span', { className: 'badge reload', textContent: 'chưa lưu' })] : []),
            icon('chevron'),
          ]),
        )),
      ]);

      const resetAllBtn = el('button', { type: 'button', className: 'danger', textContent: 'Khôi phục toàn bộ mặc định' });
      resetAllBtn.addEventListener('click', () => {
        if (!confirm('Đưa mọi trường về giá trị mặc định? (Chưa lưu lên server cho tới khi bấm Lưu.)')) return;
        draft = structuredClone(DEFAULT_CONFIG);
        renderPage();
      });
      const reloadAllBtn = el('button', { type: 'button', textContent: 'Tải lại từ server' });
      reloadAllBtn.addEventListener('click', () => void load());
      const actionsCard = el('section', { className: 'card' }, [
        el('h3', { textContent: 'Thao tác nhanh' }),
        el('div', { className: 'stack' }, [
          el('a', { href: '/', target: '_blank', rel: 'noopener', className: 'button' }, ['Mở game ', icon('external')]),
          reloadAllBtn,
          resetAllBtn,
        ]),
      ]);

      return [
        el('div', { className: 'stats' }, [onlineTile, configTile, updatedTile, roleTile]),
        el('div', { className: 'overview-grid' }, [sectionList, el('div', { className: 'stack' }, [roomsCard, actionsCard])]),
      ];
    };

    const renderJson = (): Node[] => {
      const json = JSON.stringify(draft, null, 2);
      const copyBtn = el('button', { type: 'button', textContent: 'Sao chép' });
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(json);
          copyBtn.textContent = 'Đã sao chép';
        } catch {
          copyBtn.textContent = 'Không sao chép được';
        }
        window.setTimeout(() => (copyBtn.textContent = 'Sao chép'), 1500);
      });
      const downloadBtn = el('button', { type: 'button', textContent: 'Tải xuống .json' });
      downloadBtn.addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        el('a', { href: url, download: 'summertime-config.json' }).click();
        URL.revokeObjectURL(url);
      });
      return [
        el('div', { className: 'toolbar' }, [copyBtn, downloadBtn]),
        el('pre', { className: 'card code', textContent: json }),
      ];
    };

    // --- Routing ---------------------------------------------------------------
    const routeFromHash = () => ROUTES.find((r) => location.hash === `#/${r.id}`) ?? ROUTES[0];
    const closeMenu = () => layout.classList.remove('nav-open');
    window.addEventListener(
      'hashchange',
      () => {
        current = routeFromHash();
        closeMenu();
        renderPage();
        window.scrollTo(0, 0);
      },
      { signal },
    );
    menuBtn.addEventListener('click', () => layout.classList.toggle('nav-open'));
    backdrop.addEventListener('click', closeMenu);

    // --- Data ---------------------------------------------------------------------
    const load = async () => {
      setStatus('Đang tải…');
      try {
        const snap = await getDoc(configRef);
        const data = snap.exists() ? snap.data() : undefined;
        draft = mergeWithDefaults(DEFAULT_CONFIG, data);
        saved = data ? structuredClone(draft) : null;
        savedJson = data ? JSON.stringify(draft) : '';
        meta = { updatedAt: data?.updatedAt?.toDate?.(), updatedBy: data?.updatedBy };
        renderPage();
        if (!data) setStatus('Chưa có config trên server: đang hiển thị mặc định', 'warn');
      } catch (err: any) {
        renderPage();
        setStatus(`Lỗi tải: ${err?.code ?? err}`, 'error');
      }
    };

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      setStatus('Đang lưu…');
      try {
        await setDoc(configRef, {
          ...draft,
          updatedAt: serverTimestamp(),
          updatedBy: account,
        });
        saved = structuredClone(draft);
        savedJson = JSON.stringify(draft);
        meta = { updatedAt: new Date(), updatedBy: account };
        if (current.id === 'overview') renderPage();
        else updateDirty();
        setStatus('Đã lưu', 'ok');
      } catch (err: any) {
        setStatus(`Lỗi lưu: ${err?.code ?? err}`, 'error');
      } finally {
        saveBtn.disabled = !isAdmin;
      }
    });
    reloadBtn.addEventListener('click', () => {
      if (isDirty() && savedJson && !confirm('Bỏ các thay đổi chưa lưu và tải lại từ server?')) return;
      void load();
    });
    resetSectionBtn.addEventListener('click', () => {
      const section = current.section;
      if (!section || !confirm(`Đưa các trường của "${section.title}" về mặc định? (Chưa lưu lên server cho tới khi bấm Lưu.)`)) return;
      for (const f of section.fields) setPath(draft, f.path, structuredClone(getPath(DEFAULT_CONFIG, f.path)));
      renderPage();
    });
    logoutBtn.addEventListener('click', () => void signOut(auth));

    window.addEventListener(
      'keydown',
      (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (!saveBtn.disabled) saveBtn.click();
        } else if (e.key === 'Escape') {
          closeMenu();
        }
      },
      { signal },
    );
    window.addEventListener(
      'beforeunload',
      (e) => {
        if (isDirty() && savedJson) e.preventDefault();
      },
      { signal },
    );

    current = routeFromHash();
    await load();
    if (signal.aborted) return;

    // --- Live player count from the multiplayer server's /health endpoint -----
    const showOnline = () => {
      onlinePill.dataset.kind = online === 'error' ? 'error' : online ? 'ok' : '';
      onlinePill.textContent =
        online === 'error' ? 'Mất kết nối server' : online ? `${online.players} đang online` : 'Online: …';
      onlinePill.title = online === 'error' ? 'Không kết nối được server multiplayer' : 'Số người chơi đang online';
      if (onlineTile?.isConnected) {
        const next = makeOnlineTile();
        onlineTile.replaceWith(next);
        onlineTile = next;
      }
      if (roomsCard?.isConnected) {
        const next = makeRoomsCard();
        roomsCard.replaceWith(next);
        roomsCard = next;
      }
    };
    const refreshOnline = async () => {
      try {
        online = await api.health(signal);
      } catch {
        if (signal.aborted) return;
        online = 'error';
      }
      showOnline();
    };
    showOnline();
    void refreshOnline();
    const timer = window.setInterval(refreshOnline, 5000);
    signal.addEventListener('abort', () => window.clearInterval(timer));
  }
}
