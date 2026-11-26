// Emotes that only work inside an area (around a chicken coop, on the
// fishing pier): anywhere in the area the key plays the emote as usual
// (optionally turning the player toward a point first); outside it nothing
// happens. No on-screen prompts: a how-to popup (like a found secret) shows
// once per player, the first time they step into the area.

import type { Vector3 } from 'three';
import { events } from '../core/events';
import type { Characters } from '../engine/characters';

export interface AreaActivityOptions {
  /** Network animation state played in the area. */
  state: number;
  /** Whether a (feet) position is inside the area. */
  inArea: (p: Vector3) => boolean;
  /** World point to turn toward when starting, or null to keep the heading. */
  faceTarget?: (p: Vector3) => { x: number; z: number } | null;
  /** Other states that also count as "playing it" (e.g. the fishing mini-game stages). */
  stages?: readonly number[];
  /** One-time how-to popup: storage key and text. */
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

  constructor(private _characters: Characters, private _o: AreaActivityOptions) {
    this._tipShown = tipsSeen().includes(_o.tipId);
    _characters.emoteInterceptors.push(this._onEmote);
  }

  private _showTip() {
    if (this._tipShown) return;
    this._tipShown = true;
    events.emit('webgl_show_tip', this._o.tip);
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

  /** Per frame: the how-to the first time the player is in the area. */
  update() {
    if (!this._tipShown && this._o.inArea(this._characters.local.position)) this._showTip();
  }
}
