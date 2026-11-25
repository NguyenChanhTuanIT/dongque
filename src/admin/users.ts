// User management pages of the admin panel:
//   • Tài khoản   – player profiles from Firestore `users/{uid}` (written by the
//                   game on sign-in), with ban/unban and admin grant/revoke.
//   • Đang online – live connections from the relay (server/admin-api.mjs),
//                   with kick and ban.
// Banning writes `users/{uid}.banned` (the game refuses to sign the account in,
// the relay refuses its name) and tells the relay to disconnect it right away.

import type { User } from 'firebase/auth';
import type { Firestore } from 'firebase/firestore';
import { ADMINS_COLLECTION, USERS_COLLECTION } from '../config/firebase';
import { apiErrorMessage, type AdminApi, type LivePlayer } from './api';
import { askDialog, duration, el, formatDate, formatDateTime, timeAgo, toast } from './dom';
import { icon } from './icons';

type FirestoreModule = typeof import('firebase/firestore');

export interface UserPagesDeps {
  db: Firestore;
  fs: FirestoreModule;
  me: User;
  isAdmin: boolean;
  api: AdminApi;
}

interface UserRow {
  uid: string;
  email: string;
  name: string;
  createdAt?: Date;
  lastLoginAt?: Date;
  banned: boolean;
  banReason: string;
  bannedBy: string;
  bannedAt?: Date;
  admin: boolean;
  /** false for admins that never signed in to the game (no users/{uid} doc). */
  hasProfile: boolean;
}

type Filter = 'all' | 'online' | 'banned' | 'admin';

/** Upper bound of profiles loaded at once (most recent sign-ins first). */
const MAX_USERS = 1000;
const LIVE_REFRESH_MS = 5000;

const toDate = (v: any): Date | undefined => (v && typeof v.toDate === 'function' ? v.toDate() : undefined);

function firestoreError(err: any): string {
  if (err?.code === 'permission-denied') return 'Không có quyền. Đã deploy firestore.rules mới chưa?';
  if (err?.code === 'failed-precondition') return 'Firestore cần thêm index cho truy vấn này.';
  return `Lỗi Firestore: ${err?.code ?? err}`;
}

export function createUserPages(deps: UserPagesDeps) {
  const { db, fs, me, api } = deps;
  const myLabel = me.email ?? me.uid;

  let rows: Map<string, UserRow> | null = null;
  let rowsError = '';
  let live: LivePlayer[] | null = null;
  let liveError = '';
  let liveAt = 0;

  // --- Data -------------------------------------------------------------------

  async function loadUsers() {
    try {
      const [usersSnap, adminsSnap] = await Promise.all([
        fs.getDocs(fs.query(fs.collection(db, USERS_COLLECTION), fs.orderBy('lastLoginAt', 'desc'), fs.limit(MAX_USERS))),
        fs.getDocs(fs.collection(db, ADMINS_COLLECTION)),
      ]);
      const admins = new Set(adminsSnap.docs.map((d) => d.id));
      const next = new Map<string, UserRow>();
      for (const d of usersSnap.docs) {
        const data = d.data();
        next.set(d.id, {
          uid: d.id,
          email: String(data.email ?? ''),
          name: String(data.name ?? ''),
          createdAt: toDate(data.createdAt),
          lastLoginAt: toDate(data.lastLoginAt),
          banned: data.banned === true,
          banReason: String(data.banReason ?? ''),
          bannedBy: String(data.bannedBy ?? ''),
          bannedAt: toDate(data.bannedAt),
          admin: admins.has(d.id),
          hasProfile: true,
        });
      }
      for (const uid of admins) {
        if (next.has(uid)) continue;
        next.set(uid, {
          uid,
          email: uid === me.uid ? (me.email ?? '') : '',
          name: '',
          banned: false,
          banReason: '',
          bannedBy: '',
          admin: true,
          hasProfile: false,
        });
      }
      rows = next;
      rowsError = '';
    } catch (err) {
      rowsError = firestoreError(err);
    }
  }

  async function loadLive(signal?: AbortSignal) {
    try {
      live = await api.players(signal);
      liveError = '';
      liveAt = Date.now();
    } catch (err) {
      if (signal?.aborted) return;
      live = null;
      liveError = apiErrorMessage(err);
    }
  }

  /** uid → rooms the account is connected to. */
  const onlineRooms = () => {
    const map = new Map<string, string[]>();
    for (const p of live ?? []) if (p.uid) map.set(p.uid, [...(map.get(p.uid) ?? []), p.room]);
    return map;
  };

  const rowLabel = (row: Pick<UserRow, 'name' | 'email' | 'uid'>) => row.name || row.email || row.uid;

  // --- Actions ------------------------------------------------------------------

  async function setBanned(row: UserRow, banned: boolean): Promise<boolean> {
    const label = rowLabel(row);
    const answer = await askDialog(
      banned
        ? {
            title: `Khoá tài khoản ${label}?`,
            message: 'Người chơi bị ngắt khỏi server, bị đăng xuất khỏi game và không đăng nhập lại được cho tới khi mở khoá.',
            input: { label: 'Lý do (tuỳ chọn, người chơi không thấy)', maxLength: 200 },
            confirmLabel: 'Khoá tài khoản',
            danger: true,
          }
        : { title: `Mở khoá tài khoản ${label}?`, message: 'Người chơi có thể đăng nhập và đặt tên lại như bình thường.', confirmLabel: 'Mở khoá' },
    );
    if (answer === null) return false;
    const reason = banned ? answer.trim() : '';
    try {
      await fs.updateDoc(fs.doc(db, USERS_COLLECTION, row.uid), {
        banned,
        banReason: reason,
        bannedAt: fs.serverTimestamp(),
        bannedBy: myLabel,
      });
    } catch (err) {
      toast(firestoreError(err), 'error');
      return false;
    }
    Object.assign(row, { banned, banReason: reason, bannedAt: new Date(), bannedBy: myLabel });
    try {
      const kicked = await api.ban(row.uid, banned);
      toast(
        banned ? `Đã khoá ${label}${kicked ? ` và ngắt ${kicked} kết nối` : ''}.` : `Đã mở khoá ${label}.`,
        'ok',
      );
    } catch (err) {
      toast(
        `Đã ${banned ? 'khoá' : 'mở khoá'} ${label} trong Firestore, nhưng chưa báo được server: ${apiErrorMessage(err)}` +
          (banned ? ' Người chơi sẽ bị chặn khi kết nối lại.' : ''),
        'warn',
      );
    }
    return true;
  }

  async function setAdmin(row: UserRow, admin: boolean): Promise<boolean> {
    const label = rowLabel(row);
    const answer = await askDialog(
      admin
        ? {
            title: `Cấp quyền admin cho ${label}?`,
            message: 'Tài khoản này sẽ sửa được cấu hình game, khoá người chơi và cấp/thu quyền admin của người khác.',
            confirmLabel: 'Cấp quyền',
          }
        : { title: `Thu quyền admin của ${label}?`, confirmLabel: 'Thu quyền', danger: true },
    );
    if (answer === null) return false;
    try {
      const ref = fs.doc(db, ADMINS_COLLECTION, row.uid);
      if (admin) await fs.setDoc(ref, { grantedBy: myLabel, grantedAt: fs.serverTimestamp() });
      else await fs.deleteDoc(ref);
    } catch (err) {
      toast(firestoreError(err), 'error');
      return false;
    }
    row.admin = admin;
    toast(admin ? `${label} giờ là admin.` : `Đã thu quyền admin của ${label}.`, 'ok');
    return true;
  }

  async function kick(target: { id?: number; uid?: string }, label: string): Promise<boolean> {
    const answer = await askDialog({
      title: `Kick ${label}?`,
      message: 'Người chơi bị ngắt khỏi server và phải tải lại trang để vào lại.',
      confirmLabel: 'Kick',
      danger: true,
    });
    if (answer === null) return false;
    try {
      const kicked = await api.kick(target);
      toast(kicked ? `Đã kick ${label}.` : `${label} không còn online.`, kicked ? 'ok' : 'warn');
    } catch (err) {
      toast(apiErrorMessage(err), 'error');
      return false;
    }
    return true;
  }

  // --- Shared bits ----------------------------------------------------------------

  const small = (text: string, className = 'muted') => el('small', { className, textContent: text });
  const badge = (text: string, kind: string, title = '') => el('span', { className: `badge ${kind}`, textContent: text, title });
  const button = (text: string, onClick: () => void, opts: { danger?: boolean; disabled?: boolean; title?: string } = {}) => {
    const b = el('button', {
      type: 'button',
      className: `btn-sm${opts.danger ? ' danger' : ''}`,
      textContent: text,
      disabled: opts.disabled ?? false,
      title: opts.title ?? '',
    });
    b.addEventListener('click', onClick);
    return b;
  };
  const userCell = (title: string, subtitle: string, muted = false) =>
    el('div', { className: 'user-cell' }, [
      el('div', { className: 'avatar', textContent: ((muted ? subtitle : title) || '?').charAt(0).toUpperCase() }),
      el('div', { className: 'user-cell-text' }, [
        el('span', { className: muted ? 'muted' : '', textContent: title }),
        ...(subtitle ? [small(subtitle)] : []),
      ]),
    ]);
  const table = (head: string[], body: HTMLTableRowElement[]) =>
    el('table', { className: 'table' }, [
      el('thead', {}, [el('tr', {}, head.map((h) => el('th', { textContent: h })))]),
      el('tbody', {}, body),
    ]);
  const td = (children: Array<Node | string>, className = '') => el('td', { className }, children);
  const empty = (text: string) => el('p', { className: 'empty muted', textContent: text });
  const needAdmin = () => [
    el('div', { className: 'card' }, [empty('Cần quyền admin để quản lý người dùng.')]),
  ];

  // --- Page: accounts -----------------------------------------------------------

  function renderUsersPage(signal: AbortSignal): Node[] {
    if (!deps.isAdmin) return needAdmin();

    let filter: Filter = 'all';
    const search = el('input', { type: 'search', placeholder: 'Tìm theo tên, email hoặc UID', className: 'search' });
    const filters = el('div', { className: 'segmented', role: 'group', ariaLabel: 'Lọc người dùng' });
    const refreshBtn = el('button', { type: 'button', textContent: 'Làm mới' });
    const tableCard = el('div', { className: 'card table-card' }, [empty('Đang tải…')]);
    const footer = el('p', { className: 'muted table-footer' });

    const draw = () => {
      if (signal.aborted) return;
      if (rowsError) {
        tableCard.replaceChildren(el('p', { className: 'empty error', textContent: rowsError }));
        return;
      }
      if (!rows) return;
      const all = [...rows.values()];
      const online = onlineRooms();
      const counts: Record<Filter, number> = {
        all: all.length,
        online: all.filter((r) => online.has(r.uid)).length,
        banned: all.filter((r) => r.banned).length,
        admin: all.filter((r) => r.admin).length,
      };
      const labels: Record<Filter, string> = { all: 'Tất cả', online: 'Đang online', banned: 'Bị khoá', admin: 'Admin' };
      filters.replaceChildren(
        ...(Object.keys(labels) as Filter[]).map((f) => {
          const b = el('button', { type: 'button', className: f === filter ? 'active' : '' }, [
            labels[f],
            el('span', { className: 'count', textContent: String(counts[f]) }),
          ]);
          b.setAttribute('aria-pressed', String(f === filter));
          b.addEventListener('click', () => {
            filter = f;
            draw();
          });
          return b;
        }),
      );

      const q = search.value.trim().toLowerCase();
      const shown = all.filter((r) => {
        if (filter === 'online' && !online.has(r.uid)) return false;
        if (filter === 'banned' && !r.banned) return false;
        if (filter === 'admin' && !r.admin) return false;
        return !q || r.name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q) || r.uid.toLowerCase().includes(q);
      });

      if (shown.length === 0) {
        tableCard.replaceChildren(empty(all.length === 0
          ? 'Chưa có hồ sơ nào. Hồ sơ được tạo khi người chơi đăng nhập vào game.'
          : 'Không có người dùng nào khớp bộ lọc.'));
      } else {
        tableCard.replaceChildren(table(
          ['Người dùng', 'Trạng thái', 'Tham gia', 'Đăng nhập cuối', ''],
          shown.map((r) => {
            const isMe = r.uid === me.uid;
            const rooms = online.get(r.uid);
            const status = el('div', { className: 'badges' }, [
              ...(rooms ? [badge(`Online · ${[...new Set(rooms)].join(', ')}`, 'live')] : []),
              ...(r.banned ? [badge('Bị khoá', 'danger', r.bannedAt ? `${formatDateTime(r.bannedAt)} · ${r.bannedBy}` : '')] : []),
              ...(r.admin ? [badge('Admin', 'accent')] : []),
              ...(!rooms && !r.banned && !r.admin ? [small('Hoạt động')] : []),
            ]);
            if (r.banned && r.banReason) status.append(small(`Lý do: ${r.banReason}`, 'muted reason'));
            const actions = el('div', { className: 'row-actions' }, [
              ...(rooms ? [button('Kick', () => void kick({ uid: r.uid }, rowLabel(r)).then((ok) => { if (ok) void refresh(); }))] : []),
              button(r.banned ? 'Mở khoá' : 'Khoá', () => void setBanned(r, !r.banned).then((ok) => { if (ok) draw(); }), {
                danger: !r.banned,
                disabled: isMe || !r.hasProfile,
                title: isMe ? 'Không thể tự khoá mình' : !r.hasProfile ? 'Tài khoản chưa từng đăng nhập game' : '',
              }),
              button(r.admin ? 'Thu quyền admin' : 'Cấp admin', () => void setAdmin(r, !r.admin).then((ok) => { if (ok) draw(); }), {
                disabled: isMe,
                title: isMe ? 'Không thể tự thu quyền của mình' : '',
              }),
            ]);
            const row = el('tr', {}, [
              td([userCell(r.name || 'Chưa đặt tên', r.email || r.uid, !r.name)]),
              td([status]),
              td([r.hasProfile ? formatDate(r.createdAt) : '—'], 'nowrap'),
              td([el('span', { textContent: timeAgo(r.lastLoginAt), title: formatDateTime(r.lastLoginAt) })], 'nowrap'),
              td([actions], 'actions-cell'),
            ]);
            row.title = `UID: ${r.uid}`;
            if (r.banned) row.classList.add('is-banned');
            return row;
          }),
        ));
      }
      footer.textContent =
        `Hiển thị ${shown.length}/${all.length} tài khoản` +
        (all.length >= MAX_USERS ? ` (chỉ tải ${MAX_USERS} tài khoản đăng nhập gần nhất)` : '') +
        (liveError ? ` · Trạng thái online: ${liveError}` : '');
    };

    const refresh = async () => {
      refreshBtn.disabled = true;
      await Promise.all([loadUsers(), loadLive(signal)]);
      refreshBtn.disabled = false;
      draw();
    };

    search.addEventListener('input', draw);
    refreshBtn.addEventListener('click', () => void refresh());
    if (rows) draw();
    void refresh();

    return [
      el('div', { className: 'toolbar' }, [
        el('div', { className: 'search-wrap' }, [icon('search'), search]),
        filters,
        el('span', { className: 'spacer' }),
        refreshBtn,
      ]),
      tableCard,
      footer,
    ];
  }

  // --- Page: online players -----------------------------------------------------

  function renderOnlinePage(signal: AbortSignal): Node[] {
    if (!deps.isAdmin) return needAdmin();

    let room = '';
    const roomSelect = el('select', { ariaLabel: 'Phòng' });
    const updated = el('span', { className: 'muted small' });
    const refreshBtn = el('button', { type: 'button', textContent: 'Làm mới' });
    const stats = el('div', { className: 'stats' });
    const tableCard = el('div', { className: 'card table-card' }, [empty('Đang tải…')]);

    const stat = (label: string, value: string) =>
      el('div', { className: 'card stat' }, [
        el('span', { className: 'stat-label', textContent: label }),
        el('strong', { className: 'stat-value', textContent: value }),
      ]);

    const draw = () => {
      if (signal.aborted) return;
      updated.textContent = liveAt ? `Cập nhật ${new Date(liveAt).toLocaleTimeString('vi-VN')} · tự làm mới mỗi 5 giây` : '';
      if (!live) {
        stats.replaceChildren();
        tableCard.replaceChildren(el('p', { className: 'empty error', textContent: liveError || 'Đang tải…' }));
        return;
      }
      const players = live;
      const byRoom = new Map<string, number>();
      for (const p of players) byRoom.set(p.room, (byRoom.get(p.room) ?? 0) + 1);
      if (room && !byRoom.has(room)) room = '';
      roomSelect.replaceChildren(
        el('option', { value: '', textContent: `Tất cả phòng (${players.length})` }),
        ...[...byRoom].sort().map(([name, n]) => el('option', { value: name, textContent: `${name} (${n})` })),
      );
      roomSelect.value = room;

      const accounts = players.filter((p) => p.uid).length;
      stats.replaceChildren(
        stat('Đang online', String(players.length)),
        stat('Phòng', String(byRoom.size)),
        stat('Có tài khoản', String(accounts)),
        stat('Khách', String(players.length - accounts)),
      );

      const shown = players.filter((p) => !room || p.room === room).sort((a, b) => a.connectedAt - b.connectedAt);
      if (shown.length === 0) {
        tableCard.replaceChildren(empty(players.length ? 'Không có ai trong phòng này.' : 'Không có ai đang online.'));
        return;
      }
      const now = Date.now();
      tableCard.replaceChildren(table(
        ['Người chơi', 'Tài khoản', 'Phòng', 'Online', 'Vị trí (x, z)', ''],
        shown.map((p) => {
          const account = p.uid ? rows?.get(p.uid) : undefined;
          const label = p.name || `Khách #${p.id}`;
          const actions = el('div', { className: 'row-actions' }, [
            button('Kick', () => void kick({ id: p.id }, label).then((ok) => { if (ok) void refresh(); })),
            ...(account?.hasProfile && !account.banned && p.uid !== me.uid
              ? [button('Khoá', () => void setBanned(account, true).then((ok) => { if (ok) void refresh(); }), { danger: true })]
              : []),
          ]);
          return el('tr', {}, [
            td([userCell(label, `#${p.id}`)]),
            td(p.uid
              ? [el('div', { className: 'user-cell-text' }, [
                  el('span', { textContent: account?.email || 'Đã đăng nhập' }),
                  ...(account?.banned ? [badge('Bị khoá', 'danger')] : []),
                  small(p.uid),
                ])]
              : [small('Khách')]),
            td([p.room]),
            td([duration(now - p.connectedAt)], 'nowrap'),
            td([`${p.x}, ${p.z}`], 'nowrap mono'),
            td([actions], 'actions-cell'),
          ]);
        }),
      ));
    };

    const refresh = async () => {
      refreshBtn.disabled = true;
      await Promise.all([loadLive(signal), rows ? Promise.resolve() : loadUsers()]);
      refreshBtn.disabled = false;
      draw();
    };

    roomSelect.addEventListener('change', () => {
      room = roomSelect.value;
      draw();
    });
    refreshBtn.addEventListener('click', () => void refresh());
    if (live) draw();
    void refresh();
    const timer = window.setInterval(() => void refresh(), LIVE_REFRESH_MS);
    signal.addEventListener('abort', () => window.clearInterval(timer));

    return [
      stats,
      el('div', { className: 'toolbar' }, [roomSelect, updated, el('span', { className: 'spacer' }), refreshBtn]),
      tableCard,
    ];
  }

  return { renderUsersPage, renderOnlinePage };
}
