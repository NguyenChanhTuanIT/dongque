// "Góp ý" page of the admin panel: product feedback sent from the game
// (src/components/feedback.ts → server/feedback.mjs), read through the relay's
// admin API. Admins filter / search, mark each one new → read → done, keep a
// private note and delete spam. Senders that were signed in are shown with
// their profile name and email from Firestore `users/{uid}`.

import type { Firestore } from 'firebase/firestore';
import { USERS_COLLECTION } from '../config/firebase';
import { apiErrorMessage, type AdminApi, type FeedbackItem, type FeedbackStatus } from './api';
import { askDialog, el, formatDateTime, timeAgo, toast } from './dom';
import { icon } from './icons';

type FirestoreModule = typeof import('firebase/firestore');

export interface FeedbackPageDeps {
  db: Firestore;
  fs: FirestoreModule;
  isAdmin: boolean;
  api: AdminApi;
}

type Filter = 'all' | FeedbackStatus;

const STATUS_LABEL: Record<FeedbackStatus, string> = { new: 'Mới', read: 'Đã đọc', done: 'Đã xử lý' };
const STATUS_BADGE: Record<FeedbackStatus, string> = { new: 'accent', read: '', done: 'live' };
/** Feedback cards drawn at once (the rest behind "Xem thêm"). */
const PAGE_SIZE = 50;

/** "Chrome · Windows" from a user agent (rough, for context only). */
function device(ua: string): string {
  if (!ua) return '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt khác';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} · ${os}` : browser;
}

export function createFeedbackPage(deps: FeedbackPageDeps) {
  const { db, fs, api } = deps;

  let items: FeedbackItem[] | null = null;
  let loadError = '';
  /** uid → profile (null = no profile / not readable). */
  const profiles = new Map<string, { name: string; email: string } | null>();

  async function load(signal: AbortSignal) {
    try {
      items = await api.feedback(signal);
      loadError = '';
    } catch (err) {
      if (signal.aborted) return;
      loadError = apiErrorMessage(err);
    }
    // Names of the senders we have not looked up yet.
    const missing = [...new Set((items ?? []).map((f) => f.uid).filter((uid) => uid && !profiles.has(uid)))];
    await Promise.all(
      missing.map(async (uid) => {
        try {
          const snap = await fs.getDoc(fs.doc(db, USERS_COLLECTION, uid));
          const data = snap.data();
          profiles.set(uid, data ? { name: String(data.name ?? ''), email: String(data.email ?? '') } : null);
        } catch {
          profiles.set(uid, null);
        }
      }),
    );
  }

  function render(signal: AbortSignal): Node[] {
    if (!deps.isAdmin) return [el('div', { className: 'card' }, [el('p', { className: 'empty muted', textContent: 'Cần quyền admin để xem góp ý.' })])];

    let filter: Filter = 'new';
    let shownCount = PAGE_SIZE;
    const search = el('input', { type: 'search', placeholder: 'Tìm trong nội dung, tên, email, ghi chú', className: 'search' });
    const filters = el('div', { className: 'segmented', role: 'group', ariaLabel: 'Lọc góp ý' });
    const refreshBtn = el('button', { type: 'button', textContent: 'Làm mới' });
    const stats = el('div', { className: 'stats' });
    const list = el('div', { className: 'feedback-list' }, [el('div', { className: 'card' }, [el('p', { className: 'empty muted', textContent: 'Đang tải…' })])]);
    const footer = el('p', { className: 'muted table-footer' });

    const stat = (label: string, value: number) =>
      el('div', { className: 'card stat' }, [
        el('span', { className: 'stat-label', textContent: label }),
        el('strong', { className: 'stat-value', textContent: String(value) }),
      ]);

    const sender = (f: FeedbackItem) => {
      if (!f.uid) return { title: 'Khách (chưa đăng nhập)', subtitle: '', muted: true };
      const p = profiles.get(f.uid);
      return { title: p?.name || p?.email || 'Người chơi đã đăng nhập', subtitle: p?.email || f.uid, muted: !p?.name };
    };

    async function setStatus(f: FeedbackItem, status: FeedbackStatus) {
      if (f.status === status) return;
      try {
        Object.assign(f, await api.updateFeedback(f.id, { status }));
        draw();
      } catch (err) {
        toast(apiErrorMessage(err), 'error');
      }
    }

    async function editNote(f: FeedbackItem) {
      const note = await askDialog({
        title: 'Ghi chú nội bộ',
        message: 'Chỉ admin thấy ghi chú này (ví dụ: đã tạo task, sẽ làm ở bản sau…).',
        input: { label: 'Ghi chú (để trống để xoá)', maxLength: 500, value: f.note },
        confirmLabel: 'Lưu ghi chú',
      });
      if (note === null) return;
      try {
        Object.assign(f, await api.updateFeedback(f.id, { note: note.trim() }));
        toast(note.trim() ? 'Đã lưu ghi chú.' : 'Đã xoá ghi chú.', 'ok');
        draw();
      } catch (err) {
        toast(apiErrorMessage(err), 'error');
      }
    }

    async function remove(f: FeedbackItem) {
      const ok = await askDialog({
        title: 'Xoá góp ý này?',
        message: 'Góp ý bị xoá vĩnh viễn (dùng cho spam / nội dung không phù hợp).',
        confirmLabel: 'Xoá',
        danger: true,
      });
      if (ok === null) return;
      try {
        await api.deleteFeedback(f.id);
        items = (items ?? []).filter((x) => x.id !== f.id);
        toast('Đã xoá góp ý.', 'ok');
        draw();
      } catch (err) {
        toast(apiErrorMessage(err), 'error');
      }
    }

    const card = (f: FeedbackItem) => {
      const who = sender(f);
      const statusGroup = el('div', { className: 'segmented', role: 'group', ariaLabel: 'Trạng thái' },
        (Object.keys(STATUS_LABEL) as FeedbackStatus[]).map((s) => {
          const b = el('button', { type: 'button', className: s === f.status ? 'active' : '', textContent: STATUS_LABEL[s] });
          b.setAttribute('aria-pressed', String(s === f.status));
          b.addEventListener('click', () => void setStatus(f, s));
          return b;
        }),
      );
      const noteBtn = el('button', { type: 'button', className: 'btn-sm', textContent: f.note ? 'Sửa ghi chú' : 'Ghi chú' });
      noteBtn.addEventListener('click', () => void editNote(f));
      const deleteBtn = el('button', { type: 'button', className: 'btn-sm danger', textContent: 'Xoá' });
      deleteBtn.addEventListener('click', () => void remove(f));
      const copyBtn = el('button', { type: 'button', className: 'btn-sm', textContent: 'Sao chép' });
      copyBtn.addEventListener('click', () => {
        void navigator.clipboard.writeText(f.text).then(
          () => toast('Đã sao chép nội dung.', 'ok'),
          () => toast('Không sao chép được.', 'error'),
        );
      });

      const meta = [timeAgo(new Date(f.at)), device(f.ua)].filter(Boolean).join(' · ');
      return el('article', { className: `card feedback-card status-${f.status}` }, [
        el('header', { className: 'feedback-head' }, [
          el('div', { className: 'user-cell' }, [
            el('div', { className: 'avatar', textContent: (who.muted ? '?' : who.title).charAt(0).toUpperCase() }),
            el('div', { className: 'user-cell-text' }, [
              el('span', { className: who.muted ? 'muted' : '', textContent: who.title }),
              ...(who.subtitle ? [el('small', { className: 'muted', textContent: who.subtitle })] : []),
            ]),
          ]),
          el('div', { className: 'badges' }, [
            el('span', { className: `badge ${STATUS_BADGE[f.status]}`, textContent: STATUS_LABEL[f.status] }),
            el('small', { className: 'muted', textContent: meta, title: `${formatDateTime(new Date(f.at))}\n${f.ua}` }),
          ]),
        ]),
        el('p', { className: 'feedback-text', textContent: f.text }),
        ...(f.note ? [el('p', { className: 'feedback-note' }, [el('strong', { textContent: 'Ghi chú: ' }), f.note])] : []),
        el('footer', { className: 'feedback-actions' }, [statusGroup, el('span', { className: 'spacer' }), copyBtn, noteBtn, deleteBtn]),
      ]);
    };

    const draw = () => {
      if (signal.aborted) return;
      if (!items) {
        stats.replaceChildren();
        list.replaceChildren(el('div', { className: 'card' }, [el('p', { className: `empty ${loadError ? 'error' : 'muted'}`, textContent: loadError || 'Đang tải…' })]));
        return;
      }
      const all = items;
      const todayKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      const counts: Record<Filter, number> = {
        all: all.length,
        new: all.filter((f) => f.status === 'new').length,
        read: all.filter((f) => f.status === 'read').length,
        done: all.filter((f) => f.status === 'done').length,
      };
      stats.replaceChildren(
        stat('Tổng góp ý', counts.all),
        stat('Chưa đọc', counts.new),
        stat('Hôm nay', all.filter((f) => f.day === todayKey).length),
        stat('Đã xử lý', counts.done),
      );
      const labels: Record<Filter, string> = { new: 'Mới', read: 'Đã đọc', done: 'Đã xử lý', all: 'Tất cả' };
      filters.replaceChildren(
        ...(Object.keys(labels) as Filter[]).map((f) => {
          const b = el('button', { type: 'button', className: f === filter ? 'active' : '' }, [labels[f], el('span', { className: 'count', textContent: String(counts[f]) })]);
          b.setAttribute('aria-pressed', String(f === filter));
          b.addEventListener('click', () => {
            filter = f;
            shownCount = PAGE_SIZE;
            draw();
          });
          return b;
        }),
      );

      const q = search.value.trim().toLowerCase();
      const shown = all.filter((f) => {
        if (filter !== 'all' && f.status !== filter) return false;
        if (!q) return true;
        const p = f.uid ? profiles.get(f.uid) : null;
        return [f.text, f.note, f.uid, p?.name ?? '', p?.email ?? ''].some((s) => s.toLowerCase().includes(q));
      });
      if (shown.length === 0) {
        list.replaceChildren(el('div', { className: 'card' }, [el('p', { className: 'empty muted', textContent: all.length ? 'Không có góp ý nào khớp bộ lọc.' : 'Chưa có góp ý nào.' })]));
      } else {
        const nodes: Node[] = shown.slice(0, shownCount).map(card);
        if (shown.length > shownCount) {
          const more = el('button', { type: 'button', className: 'feedback-more', textContent: `Xem thêm (${shown.length - shownCount})` });
          more.addEventListener('click', () => {
            shownCount += PAGE_SIZE;
            draw();
          });
          nodes.push(more);
        }
        list.replaceChildren(...nodes);
      }
      footer.textContent = `Hiển thị ${Math.min(shown.length, shownCount)}/${shown.length} góp ý` + (loadError ? ` · ${loadError}` : '');
    };

    const refresh = async () => {
      refreshBtn.disabled = true;
      await load(signal);
      refreshBtn.disabled = false;
      draw();
    };

    search.addEventListener('input', () => {
      shownCount = PAGE_SIZE;
      draw();
    });
    refreshBtn.addEventListener('click', () => void refresh());
    if (items) draw();
    void refresh();

    return [
      stats,
      el('div', { className: 'toolbar' }, [el('div', { className: 'search-wrap' }, [icon('search'), search]), filters, el('span', { className: 'spacer' }), refreshBtn]),
      list,
      footer,
    ];
  }

  return { render };
}
