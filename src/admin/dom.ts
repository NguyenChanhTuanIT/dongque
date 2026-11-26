// Small DOM helpers shared by the admin pages.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// --- Dialog ---------------------------------------------------------------------

export interface DialogOptions {
  title: string;
  message?: string;
  confirmLabel: string;
  danger?: boolean;
  /** Adds a text field; its value is what the promise resolves to. */
  input?: { label: string; placeholder?: string; maxLength?: number; value?: string };
}

/** Modal confirm (optionally with a text field). Resolves to the text ('' without a field), or null if cancelled. */
export function askDialog(options: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const field = options.input
      ? el('input', { type: 'text', placeholder: options.input.placeholder ?? '', maxLength: options.input.maxLength ?? 200, value: options.input.value ?? '' })
      : null;
    const cancel = el('button', { type: 'button', textContent: 'Huỷ' });
    const confirm = el('button', { type: 'submit', className: options.danger ? 'danger-solid' : 'primary', textContent: options.confirmLabel });
    const form = el('form', { method: 'dialog' }, [
      el('h3', { textContent: options.title }),
      ...(options.message ? [el('p', { className: 'muted', textContent: options.message })] : []),
      ...(field && options.input ? [el('label', {}, [options.input.label, field])] : []),
      el('div', { className: 'dialog-actions' }, [cancel, confirm]),
    ]);
    const dialog = el('dialog', { className: 'dialog' }, [form]);
    let result: string | null = null;
    form.addEventListener('submit', () => {
      result = field ? field.value : '';
    });
    cancel.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(result);
    });
    document.body.append(dialog);
    dialog.showModal();
    (field ?? confirm).focus();
  });
}

// --- Toast ----------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

/** Short message in the bottom corner. */
export function toast(text: string, kind: '' | 'ok' | 'warn' | 'error' = '') {
  if (!toastHost?.isConnected) {
    toastHost = el('div', { className: 'toasts', ariaLive: 'polite' });
    document.body.append(toastHost);
  }
  const item = el('div', { className: `toast ${kind}`, textContent: text });
  toastHost.append(item);
  window.setTimeout(() => item.remove(), kind === 'error' || kind === 'warn' ? 7000 : 4000);
}

// --- Time -----------------------------------------------------------------------

const dateFormat = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
const relative = new Intl.RelativeTimeFormat('vi', { numeric: 'auto' });

export const formatDate = (d?: Date) => (d ? dateFormat.format(d) : '—');
export const formatDateTime = (d?: Date) => (d ? dateTimeFormat.format(d) : '');

/** "5 phút trước", "hôm qua", … */
export function timeAgo(d?: Date): string {
  if (!d) return '—';
  const s = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return 'vừa xong';
  if (abs < 3600) return relative.format(Math.round(s / 60), 'minute');
  if (abs < 86400) return relative.format(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 30) return relative.format(Math.round(s / 86400), 'day');
  return formatDate(d);
}

/** Elapsed time as "3 giờ 12 phút" / "45 giây". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} giây`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút`;
  const h = Math.floor(m / 60);
  return `${h} giờ ${m % 60} phút`;
}
