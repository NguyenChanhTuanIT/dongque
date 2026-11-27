// Emotes that only work inside an area (around a chicken coop, on the
// fishing pier): anywhere in the area the key plays the emote as usual
// (optionally turning the player toward a point first); outside it nothing
// happens. Nothing floats over the scene: the chat box shows a how-to once per
// player (the first time they step into the area) and, while they stand in the
// area, the action with its key as a button (tap on touch screens).

import type { Vector3 } from 'three';
import { events } from '../core/events';
import type { Characters } from '../engine/characters';
import { EMOTES } from './emotes';

export interface AreaActivityOptions {
  /** Network animation state played in the area. */
  state: number;
  /** Whether a (feet) position is inside the area. */
  inArea: (p: Vector3) => boolean;
  /** World point to turn toward when starting, or null to keep the heading. */
  faceTarget?: (p: Vector3) => { x: number; z: number } | null;
  /** Other states that also count as "playing it" (e.g. the fishing mini-game stages). */
  stages?: readonly number[];
  /** One-time how-to in the chat: storage key and text (first line = the place, e.g. "🎣 Cầu câu cá"). */
  tipId: string;
  tip: string;
}

const TIPS_KEY = 'dq-tips-seen';

function tipsSeen(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(TIPS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export class AreaActivity {
  /** Shown this session (also when storage is unavailable). */
  private _tipShown: boolean;
  private _actionSource: string;
  private _actionHtml = '';

  constructor(private _characters: Characters, private _o: AreaActivityOptions) {
    this._tipShown = tipsSeen().includes(_o.tipId);
    this._actionSource = `area:${_o.tipId}`;
    _characters.emoteInterceptors.push(this._onEmote);
  }

  private _showTip() {
    if (this._tipShown) return;
    this._tipShown = true;
    events.emit('game_tip', this._o.tip);
    try {
      localStorage.setItem(TIPS_KEY, JSON.stringify([...tipsSeen(), this._o.tipId]));
    } catch {
      /* private mode: shown again next visit */
    }
  }

  private _onEmote = (state: number): boolean => {
    if (state !== this._o.state) return false;
    const local = this._characters.local;
    // The key again during a stage: stop (the usual toggle would restart it).
    if (this._o.stages?.includes(local.userData.a) && local.userData.a !== state) {
      local.userData.a = 0;
      return true;
    }
    // Stopping, or airborne (the usual toggle ignores it): nothing to check.
    if (local.userData.a === state || local.userData.a === 1) return false;
    if (!this._o.inArea(local.position)) {
      this._showTip(); // first time only: says where and how
      return true;
    }
    const target = this._o.faceTarget?.(local.position);
    if (target && this._characters.emoteAllowed(state)) this._characters.faceTowards(target.x, target.z);
    return false; // the usual path: item check, then play
  };

  /** Per frame: the how-to the first time the player is in the area, and the action in the chat box. */
  update() {
    const local = this._characters.local;
    const inArea = this._o.inArea(local.position);
    if (!this._tipShown && inArea) this._showTip();

    let html = '';
    const slot = EMOTES.findIndex((e) => e.state === this._o.state);
    const a = local.userData.a;
    if (inArea && slot >= 0 && a !== 1) {
      const emote = EMOTES[slot];
      const playing = a === this._o.state || !!this._o.stages?.includes(a);
      const label = playing ? `Thôi ${emote.label.toLocaleLowerCase('vi')}` : emote.label;
      html =
        `<span>${this._o.tip.split('\n')[0]}</span>` +
        `<button type="button" data-slot="${slot + 1}"><kbd>${emote.key}</kbd>${label}</button>`;
    }
    if (html === this._actionHtml) return;
    this._actionHtml = html;
    events.emit('chat_action', this._actionSource, html);
  }
}
