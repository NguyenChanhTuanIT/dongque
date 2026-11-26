// Screenshot button (nav): captures the next frame of the 3D scene with the
// texts on screen drawn over it (speech bubbles, the chat lines showing; no
// buttons or panels), flashes like a camera, then the picture flies from full screen into a
// small card in the top-left corner (the free corner: nav top right, chat
// bottom left) with a download button. The card hides by itself after a
// while (not while hovered); a new shot replaces it.

import { engine } from '../engine/globals';
import { getConfig } from '../config/store';

export const cameraIcon =
  '<svg class="camera" viewBox="0 0 22 18" aria-hidden="true"><path fill-rule="evenodd" d="M7.6 1.2A1.6 1.6 0 0 1 9 .4h4a1.6 1.6 0 0 1 1.4.8l.9 1.6h3.2A2.5 2.5 0 0 1 21 5.3v9.8a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 1 15.1V5.3a2.5 2.5 0 0 1 2.5-2.5h3.2l.9-1.6ZM11 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0 2.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z" fill="#716C66"/></svg>';

const downloadIcon =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v9m0 0L4.5 7M8 10.5 11.5 7M2 12.5v1.5h12v-1.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const closeIcon =
  '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m3 3 12 12m0-12L3 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

/** The card hides after this long (ms) unless hovered. */
const SHOW_MS = 12000;

/** "mot-goc-que-2026-11-26-17-05-09.png" */
function fileName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `mot-goc-que-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.png`;
}

// ---- the on-screen texts, drawn onto the picture ----
// The 3D frame has no HTML UI: the speech bubbles over the characters and the
// chat lines showing right now (a catch, a message) are redrawn on it from
// their DOM boxes (position, colors, font, padding, radius, shadow), so the
// picture keeps what was being said. Buttons and panels stay out.

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Words of an element with their colors (a chat line's author in its own color). */
function coloredWords(el: HTMLElement, color: string): Array<{ word: string; color: string }> {
  const out: Array<{ word: string; color: string }> = [];
  const add = (text: string, c: string) => {
    for (const word of text.split(/(\s+)/)) if (word) out.push({ word, color: c });
  };
  el.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) add(node.textContent ?? '', color);
    else if (node instanceof HTMLElement) add(node.textContent ?? '', getComputedStyle(node).color);
  });
  return out;
}

/** Draw one DOM text box (CSS pixels; the context is already scaled). */
function drawTextBox(ctx: CanvasRenderingContext2D, el: HTMLElement, alpha: number, tail: boolean) {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return;
  const cs = getComputedStyle(el);
  const opacity = parseFloat(cs.opacity || '1') * alpha;
  if (opacity < 0.05) return;
  ctx.save();
  ctx.globalAlpha = opacity;
  const radius = parseFloat(cs.borderTopLeftRadius) || 0;
  // Hard shadow ("2px 2px #716c66").
  const shadow = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s+(-?[\d.]+)px\s+(-?[\d.]+)px/i.exec(cs.boxShadow) ?? /(-?[\d.]+)px\s+(-?[\d.]+)px.*?(rgba?\([^)]*\)|#[0-9a-f]{3,8})/i.exec(cs.boxShadow);
  if (shadow) {
    const [color, dx, dy] = shadow[1].startsWith('#') || shadow[1].startsWith('rgb') ? [shadow[1], +shadow[2], +shadow[3]] : [shadow[3], +shadow[1], +shadow[2]];
    ctx.fillStyle = color;
    roundRect(ctx, r.left + dx, r.top + dy, r.width, r.height, radius);
    ctx.fill();
  }
  ctx.fillStyle = cs.backgroundColor;
  roundRect(ctx, r.left, r.top, r.width, r.height, radius);
  ctx.fill();
  if (tail) {
    // The little pointer under a speech bubble.
    ctx.beginPath();
    ctx.moveTo(r.left + r.width / 2 - 6, r.bottom - 0.5);
    ctx.lineTo(r.left + r.width / 2 + 6, r.bottom - 0.5);
    ctx.lineTo(r.left + r.width / 2, r.bottom + 6);
    ctx.closePath();
    ctx.fill();
  }
  // Text, wrapped to the content box like the page does.
  const fontSize = parseFloat(cs.fontSize) || 16;
  const lineHeight = parseFloat(cs.lineHeight) || fontSize * 1.25;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  const width = r.width - padL - padR + 1;
  ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  ctx.textBaseline = 'middle';
  const lines: Array<Array<{ word: string; color: string }>> = [[]];
  let used = 0;
  for (const w of coloredWords(el, cs.color)) {
    const ww = ctx.measureText(w.word).width;
    if (used + ww > width && used > 0 && w.word.trim()) {
      lines.push([]);
      used = 0;
    }
    if (!used && !w.word.trim()) continue; // no leading space on a new line
    lines[lines.length - 1].push(w);
    used += ww;
  }
  lines.forEach((line, k) => {
    const lineWidth = line.reduce((s, w) => s + ctx.measureText(w.word).width, 0);
    let x = cs.textAlign === 'center' ? r.left + padL + (width - lineWidth) / 2 : r.left + padL;
    const y = r.top + padT + k * lineHeight + lineHeight / 2;
    for (const w of line) {
      ctx.fillStyle = w.color;
      ctx.fillText(w.word, x, y);
      x += ctx.measureText(w.word).width;
    }
  });
  ctx.restore();
}

/** The chat lines showing and the speech bubbles, at their place on the screen. */
function withScreenTexts(frame: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = frame.getContext('2d');
  if (!ctx) return frame;
  ctx.save();
  ctx.scale(frame.width / window.innerWidth, frame.height / window.innerHeight);
  const chat = document.getElementById('chat');
  if (chat?.classList.contains('visible')) {
    chat.querySelectorAll<HTMLElement>('.chat-log li').forEach((li) => drawTextBox(ctx, li, 1, false));
  }
  document.querySelectorAll<HTMLElement>('#nametags .nametag.talking').forEach((tag) => {
    if (tag.style.display === 'none') return;
    const bubble = tag.querySelector<HTMLElement>('.bubble');
    if (bubble) drawTextBox(ctx, bubble, parseFloat(tag.style.opacity || '1'), true);
  });
  ctx.restore();
  return frame;
}

/** The frame plus a small caption (the game's name) in the bottom-right corner. */
function withCaption(frame: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = frame.getContext('2d');
  if (!ctx) return frame;
  const title = getConfig().ui.aboutTitle.trim();
  if (!title) return frame;
  const size = Math.max(14, Math.round(frame.height * 0.022));
  ctx.font = `600 ${size}px sans-serif`;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(60, 50, 40, 0.55)';
  ctx.shadowBlur = size * 0.4;
  ctx.fillStyle = 'rgba(255, 250, 238, 0.92)';
  ctx.fillText(title, frame.width - size, frame.height - size * 0.8);
  return frame;
}

export class ScreenshotTool {
  private _card: HTMLDivElement;
  private _img: HTMLImageElement;
  private _download: HTMLAnchorElement;
  private _flash: HTMLDivElement;
  private _url = '';
  private _hideTimer = 0;
  private _busy = false;

  constructor(button: HTMLButtonElement) {
    button.addEventListener('click', () => void this.shoot());

    this._flash = document.createElement('div');
    this._flash.className = 'shot-flash';
    document.body.append(this._flash);

    this._card = document.createElement('div');
    this._card.className = 'shot-card';
    this._card.setAttribute('role', 'dialog');
    this._card.setAttribute('aria-label', 'Ảnh vừa chụp');
    this._card.innerHTML = `
      <a class="shot-open" target="_blank" rel="noopener" title="Xem ảnh lớn"><img alt="Ảnh chụp màn hình" /></a>
      <div class="shot-actions">
        <a class="shot-download" role="button">${downloadIcon}<span>Tải xuống</span></a>
        <button type="button" class="shot-close" aria-label="Đóng">${closeIcon}</button>
      </div>`;
    this._img = this._card.querySelector('img')!;
    this._download = this._card.querySelector('.shot-download')!;
    this._card.querySelector('.shot-close')!.addEventListener('click', () => this._hide());
    // Keep it while the pointer is on it; count again when it leaves.
    this._card.addEventListener('pointerenter', () => window.clearTimeout(this._hideTimer));
    this._card.addEventListener('pointerleave', () => this._scheduleHide());
    // Don't let clicks on the card reach the game (camera drag, etc.).
    this._card.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.body.append(this._card);
  }

  async shoot() {
    if (this._busy) return;
    this._busy = true;
    try {
      // The scene, then what was being said on screen, then the caption.
      const frame = withCaption(withScreenTexts(await engine.captureNextFrame()));
      const blob = await new Promise<Blob | null>((resolve) => frame.toBlob(resolve, 'image/png'));
      if (!blob) return;
      this._flashNow();
      if (this._url) URL.revokeObjectURL(this._url);
      this._url = URL.createObjectURL(blob);
      this._img.src = this._url;
      (this._card.querySelector('.shot-open') as HTMLAnchorElement).href = this._url;
      this._download.href = this._url;
      this._download.download = fileName();
      await this._img.decode().catch(() => undefined);
      this._showCard();
    } finally {
      this._busy = false;
    }
  }

  private _flashNow() {
    this._flash.classList.remove('on');
    void this._flash.offsetWidth; // restart the animation
    this._flash.classList.add('on');
  }

  /** The picture flies from full screen down into the card, tilting a little. */
  private _showCard() {
    window.clearTimeout(this._hideTimer);
    const card = this._card;
    card.classList.add('visible');
    this._scheduleHide();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const box = card.getBoundingClientRect();
    const scale = Math.max(window.innerWidth / box.width, window.innerHeight / box.height) * 0.92;
    const dx = window.innerWidth / 2 - (box.left + box.width / 2);
    const dy = window.innerHeight / 2 - (box.top + box.height / 2);
    card.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, opacity: 0.2 },
        { transform: `translate(${dx}px, ${dy}px) scale(${scale * 0.96})`, opacity: 1, offset: 0.25 },
        { transform: 'translate(0, 0) scale(1) rotate(-2deg)', offset: 0.85 },
        { transform: 'translate(0, 0) scale(1) rotate(-2deg)' },
      ],
      { duration: 900, easing: 'cubic-bezier(0.5, 0, 0.1, 1)' },
    );
  }

  private _scheduleHide() {
    window.clearTimeout(this._hideTimer);
    this._hideTimer = window.setTimeout(() => this._hide(), SHOW_MS);
  }

  private _hide() {
    window.clearTimeout(this._hideTimer);
    this._card.classList.remove('visible');
  }
}
