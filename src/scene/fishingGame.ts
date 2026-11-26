// Fishing mini-game for the local player on the pier (fishingPier.ts):
//
//   wait   the bobber floats; small nibbles now and then (striking then = miss)
//   bite   the bobber goes under: strike (Space / button) within the window
//   fight  hold to reel, let go to give line. Tension rises while reeling and
//          when the fish runs; too much for too long snaps the line. A fish
//          with stamina left cannot be landed; slack for too long = it escapes.
//          Fish too big for the line (tuna, sharks) almost always snap it.
//   landed the fish hangs from the rod a moment, then a new cast.
//
// Multiplayer: each stage is a network state (emotes.ts FISH_*_STATE), so
// every client shows others' bites, fights, catches and snapped lines too.
// The rod pose follows the stage by steering the clip phase
// (animationOffset) of the local player and of remote anglers on the pier;
// fishing.ts reads fishingViews for the bobber, line and caught fish. The
// species and weight only travel in the catch announcement (chat).

import { Color, type Object3D } from 'three';
import { events } from '../core/events';
import { ticker } from '../core/ticker';
import type { CharacterLocal, Characters } from '../engine/characters';
import type { AudioController } from '../engine/audio';

/** Fight sound: loops from the moment a fish is hooked until the fight ends, louder as it pulls harder. */
const REEL_URL = '/assets/audio/fishcat.mp3';
const REEL_VOLUME = [0.35, 0.85] as const; // at no tension, at the snapping point
import { FISHING_STATES, FISH_BITE_STATE, FISH_FIGHT_STATE, FISH_LANDED_STATE, FISH_PERIOD, FISH_SNAP_STATE, FISH_STATE, HOLD_FISH_COUNT, HOLD_FISH_STATE, isHoldFish } from './emotes';
import { onFishingPier } from './fishingPier';
import { ANNOUNCE_PREFIX } from '../components/announce';

interface Species {
  name: string;
  /** Relative chance. */
  chance: number;
  kg: [number, number];
  color: string;
  /** Seconds to strike after the bite. */
  window: number;
  /** Stamina multiplier (fighters > 1). */
  fight: number;
  /** Pull strength multiplier, kg for kg (lực kéo): fast hunters > 1. */
  pull: number;
  /** Seconds before it bites after the cast (thời gian chờ): big rare fish take longer. */
  wait: [number, number];
  /** Length multiplier of its runs (thời gian mỗi lần vùng): short and sharp < 1, long steady > 1. */
  run: number;
  /** Not a fish: no fight (not held up either). */
  junk?: boolean;
}

/**
 * The catch table. The index is also the network state of "holding it up"
 * (emotes.ts HOLD_FISH_STATE + index): append new species at the end only and
 * keep HOLD_FISH_COUNT (and the relay's FISH_STAGE_STATES) in step.
 * Balance (simulated, letting go when the line gets tight): up to ~cá hồng
 * anyone lands it; cá mú … cá thu need some line given; cá cam, cá đuối,
 * cá bớp, cá ngừ snap often; a shark always does.
 */
const SPECIES: Species[] = [
  { name: 'Chiếc dép tổ ong', chance: 3, kg: [0.2, 0.35], color: '#e8c43a', window: 1.6, fight: 0, pull: 0.3, wait: [3, 8], run: 0.5, junk: true },
  { name: 'Chai nhựa', chance: 2, kg: [0.05, 0.1], color: '#9fd3e0', window: 1.6, fight: 0, pull: 0.3, wait: [3, 8], run: 0.5, junk: true },
  { name: 'Cá cơm', chance: 18, kg: [0.02, 0.06], color: '#c9d6de', window: 1.4, fight: 0.8, pull: 0.8, wait: [2, 5], run: 0.5 },
  { name: 'Cá trích', chance: 14, kg: [0.05, 0.2], color: '#b7c9d6', window: 1.3, fight: 0.9, pull: 0.9, wait: [2, 6], run: 0.6 },
  { name: 'Cá nục', chance: 14, kg: [0.1, 0.4], color: '#6f8fa6', window: 1.2, fight: 1, pull: 1, wait: [3, 7], run: 0.8 },
  { name: 'Cá bạc má', chance: 11, kg: [0.2, 0.6], color: '#9fb3c2', window: 1.1, fight: 1, pull: 1, wait: [3, 7], run: 0.8 },
  { name: 'Cá chỉ vàng', chance: 9, kg: [0.05, 0.25], color: '#e8d36a', window: 1.2, fight: 0.9, pull: 0.9, wait: [3, 7], run: 0.6 },
  { name: 'Mực ống', chance: 7, kg: [0.2, 1], color: '#e6b8c8', window: 1, fight: 0.9, pull: 0.8, wait: [4, 9], run: 1.2 },
  { name: 'Cá dìa', chance: 7, kg: [0.2, 1], color: '#8c9a6a', window: 1, fight: 1, pull: 1.1, wait: [4, 9], run: 0.9 },
  { name: 'Cá đối', chance: 8, kg: [0.3, 1.5], color: '#a8a49a', window: 1, fight: 1, pull: 1, wait: [4, 9], run: 1 },
  { name: 'Cá tráp', chance: 6, kg: [0.3, 2], color: '#c8c0b0', window: 0.95, fight: 1.1, pull: 1.1, wait: [4, 10], run: 1 },
  { name: 'Cá hồng', chance: 6, kg: [0.5, 3], color: '#e0574a', window: 0.95, fight: 1.1, pull: 1.1, wait: [5, 10], run: 1 },
  { name: 'Cá mú', chance: 5, kg: [1, 6], color: '#8a6a3f', window: 0.9, fight: 1.1, pull: 1.2, wait: [5, 11], run: 1.1 },
  { name: 'Cá nhồng', chance: 4, kg: [1, 6], color: '#a4b8c0', window: 0.7, fight: 1.2, pull: 1.35, wait: [5, 11], run: 0.7 },
  { name: 'Cá chẽm', chance: 4, kg: [1, 8], color: '#9aa59a', window: 0.85, fight: 1.3, pull: 1.2, wait: [6, 12], run: 1.2 },
  { name: 'Cá thu', chance: 4, kg: [2, 9], color: '#4f7aa0', window: 0.8, fight: 1.3, pull: 1.1, wait: [6, 12], run: 1.1 },
  { name: 'Cá cam', chance: 3, kg: [2, 12], color: '#d9b45a', window: 0.75, fight: 1.4, pull: 1.25, wait: [7, 13], run: 1.3 },
  { name: 'Cá đuối', chance: 2, kg: [2, 15], color: '#7d6e5e', window: 0.9, fight: 1.5, pull: 1.1, wait: [7, 14], run: 1.6 },
  { name: 'Cá bớp', chance: 2, kg: [3, 15], color: '#5a5f66', window: 0.75, fight: 1.5, pull: 1.3, wait: [8, 14], run: 1.4 },
  { name: 'Cá ngừ', chance: 2, kg: [5, 20], color: '#2f4d73', window: 0.75, fight: 1.4, pull: 1.1, wait: [8, 15], run: 1.3 },
  { name: 'Cá mập', chance: 1, kg: [25, 60], color: '#7f8c96', window: 0.7, fight: 1.5, pull: 1.2, wait: [9, 16], run: 1.5 },
];
if (SPECIES.length !== HOLD_FISH_COUNT) console.warn('[fishing] SPECIES and HOLD_FISH_COUNT differ: held fish will show the wrong species');

/** How fishing.ts draws an angler's gear on the pier. */
export interface FishView {
  /** 0 = floating, 1 = pulled under. */
  dip: number;
  /** Sideways offset of the bobber (m) and how far it was reeled in (0..1). */
  side: number;
  near: number;
  /** Line + bobber gone (just snapped). */
  lineHidden: boolean;
  /** The rod broke: only its butt is left in the hand. */
  broken: boolean;
  fishColor: Color;
  fishScale: number;
  /** Rod trembling (0..1): a nibble, a bite, a running fish. */
  shake: number;
  /** Rod bent toward the line (0 = straight, ~0.9 = about to snap). */
  bend: number;
}

/** Anglers on the pier (local and remote) → their gear view; others use the plain loop. */
export const fishingViews = new Map<Object3D, FishView>();

/** The local player's catch while holding it up (exact color / size); others: the species' look. */
export const heldFish = new Map<Object3D, { color: Color; scale: number }>();

const fishScaleOf = (kg: number) => Math.min(3, 0.55 + Math.cbrt(kg) * 0.55);
/** How a held fish of each species looks to others (no exact weight: the middle of its range). */
const HELD_LOOKS = SPECIES.map((s) => ({ color: new Color(s.color), scale: fishScaleOf((s.kg[0] + s.kg[1]) / 2) }));
export function heldFishLook(index: number): { color: Color; scale: number } {
  return HELD_LOOKS[index] ?? HELD_LOOKS[2];
}

const newView = (): FishView => ({ dip: 0, side: 0, near: 0, lineHidden: false, broken: false, fishColor: new Color('#e8913a'), fishScale: 1.2, shake: 0, bend: 0 });

/**
 * Pose an angler seen from outside (a remote player, the fishing NPC) for
 * fishing stage `a`, `t` seconds into it: the clip phase (rod pose) and the
 * gear view (bobber under on a bite, rod trembling and bending in a fight,
 * the fish up on a catch, no line after a snap). `clock` drives the motion,
 * `seed` keeps two anglers out of step.
 */
export function poseAngler(obj: CharacterLocal, v: FishView, a: number, t: number, clock: number, seed: number) {
  let phase = ((clock / FISH_PERIOD + seed) % 1) * 0.5;
  v.dip = 0;
  v.side = 0;
  v.near = 0;
  v.lineHidden = a === FISH_SNAP_STATE;
  v.broken = false;
  v.shake = 0;
  v.bend = 0;
  if (a === FISH_BITE_STATE) {
    v.dip = 1;
    phase = 0.45;
    v.shake = 1;
    v.bend = 0.3;
  } else if (a === FISH_FIGHT_STATE) {
    // The real tension is not known: the rod bends and trembles in slow surges.
    const run = 0.5 + 0.5 * Math.sin(clock * 0.9 + seed);
    phase = 0.578 + 0.012 * Math.sin(clock * 20) * (0.4 + 0.5 * run);
    v.bend = 0.3 + 0.4 * run;
    v.shake = 0.15 + 0.35 * run;
    v.dip = 0.6 + 0.4 * run;
    v.near = Math.min(0.8, t * 0.04);
    v.side = Math.sin(clock * 1.7 + seed) * 0.6 * (0.4 + 0.6 * run) * (1 - v.near);
  } else if (a === FISH_LANDED_STATE) {
    phase = Math.min(0.72, 0.578 + (t / 0.5) * 0.142);
  }
  obj.animationOffset = phase * FISH_PERIOD - ticker.time;
}

export { newView as newFishView, SPECIES as FISH_SPECIES, kgText };
export type { Species as FishSpecies };

/** A remote angler: its stage and when it began (this client's clock). */
interface Remote {
  view: FishView;
  state: number;
  since: number;
  seed: number;
}

/**
 * Fishing news for everyone in the room: through the chat relay, shown by
 * every client (ours too, echoed back) as a notice line in the chat panel
 * (components/announce.ts), no bubble. Offline: a note for ourselves only.
 */
function announceToAll(news: string) {
  events.emit('mp_send_chat', ANNOUNCE_PREFIX + news, (sent: boolean) => {
    if (!sent) events.emit('game_hint', `${ANNOUNCE_PREFIX}${news}`);
  });
}

type Stage = 'wait' | 'bite' | 'fight' | 'landed' | 'pause';

/** Pull (as a share of what the line holds) per kg of fish. */
const forceOf = (kg: number) => 0.08 + kg / 11;
/** Extra tension while reeling. */
const REEL_LOAD = 0.5;
/** Over the limit this long (s) = snap. */
const SNAP_AFTER = 0.45;
/** Slack this long (s) = the fish escapes. */
const ESCAPE_AFTER = 5;
/**
 * When the line snaps the rod may break too (gãy cần): then it is gone from
 * the wallet (the relay) and a new one must be bought in the shop. Likelier on
 * a fish too strong for the line.
 */
const ROD_ITEM = 'picnic.fishing';
const BREAK_CHANCE = 0.08;
const BREAK_CHANCE_BIG = 0.4;
/** Landing needs the fish tired: reeled in at most this far before. */
const NEAR_CAP = 0.85;
const BEST_KEY = 'dq-fish-best';

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const kgText = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : `${kg.toFixed(1).replace('.', ',')} kg`);

function pickSpecies(): Species {
  let r = Math.random() * SPECIES.reduce((n, s) => n + s.chance, 0);
  for (const s of SPECIES) if ((r -= s.chance) < 0) return s;
  return SPECIES[2]; // cá cơm
}

function loadBest(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(BEST_KEY) || '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export class FishingGame {
  private _active = false;
  private _stage: Stage = 'wait';
  /** Seconds in the current stage / until the next event. */
  private _t = 0;
  private _until = 0;
  private _nibbleAt = 0;
  private _nibble = 0;
  private _species: Species = SPECIES[1];
  private _kg = 0;
  private _stamina = 0;
  private _staminaMax = 1;
  private _tension = 0;
  private _near = 0;
  private _over = 0;
  private _slack = 0;
  private _running = false;
  private _runUntil = 0;
  private _holding = false;
  private _pressed = false;
  private _clock = 0;
  private _last = performance.now();
  /** Stage to go back to after a pause (message shown). */
  private _snapped = false;
  /** The rod broke on the last snap: fishing ends after the pause. */
  private _broken = false;
  /** The local angler's gear view, and remote anglers on the pier. */
  private _view = newView();
  private _remotes = new Map<Object3D, Remote>();

  /**
   * No text on screen: the player reads the bobber and the rod. Touch screens
   * get one plain round button (strike / hold to reel), keyboards use Space.
   */
  private _button: HTMLButtonElement;
  /** The fish's pull (line tension) while fighting: a bar at the bottom of the screen. */
  private _pullBar: HTMLDivElement;
  private _pullFill: HTMLDivElement;
  private _pullShown = false;

  /** The fight sound while it plays (or is loading). */
  private _reel: { setVolume(v: number): void; stop(): void } | null = null;
  private _reelLoading = false;

  constructor(
    private _characters: Characters,
    private _audio?: AudioController,
  ) {
    this._button = document.createElement('button');
    this._button.type = 'button';
    this._button.className = 'fishing-button';
    this._button.setAttribute('aria-label', 'Câu cá');
    this._button.textContent = '🎣';
    const down = (e: PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      this._button.setPointerCapture?.(e.pointerId);
      this._press();
    };
    const up = () => (this._holding = false);
    this._button.addEventListener('pointerdown', down);
    this._button.addEventListener('pointerup', up);
    this._button.addEventListener('pointercancel', up);
    this._button.addEventListener('lostpointercapture', up);
    document.body.append(this._button);

    this._pullBar = document.createElement('div');
    this._pullBar.className = 'fish-pull';
    this._pullBar.setAttribute('role', 'meter');
    this._pullBar.setAttribute('aria-label', 'Sức kéo của cá');
    this._pullBar.setAttribute('aria-valuemin', '0');
    this._pullBar.setAttribute('aria-valuemax', '100');
    this._pullBar.innerHTML = '<span aria-hidden="true">🐟</span><div class="fish-pull-track"><div class="fish-pull-fill"></div></div>';
    this._pullFill = this._pullBar.querySelector('.fish-pull-fill')!;
    document.body.append(this._pullBar);

    // Space strikes / reels while fishing on the pier (instead of jumping):
    // caught on window in the capture phase, before the game's key handler.
    window.addEventListener('keydown', this._onKey, true);
    window.addEventListener('keyup', this._onKey, true);
    window.addEventListener('blur', up);
  }

  private _onKey = (e: KeyboardEvent) => {
    if (!this._active || e.code !== 'Space') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'keyup') this._holding = false;
    else if (!e.repeat) this._press();
  };

  private _press() {
    this._pressed = true;
    this._holding = true;
  }

  private _cast() {
    this._stage = 'wait';
    this._t = 0;
    // What will bite is decided now: big rare fish keep you waiting longer.
    this._species = pickSpecies();
    this._until = rand(...this._species.wait);
    this._nibbleAt = rand(1, Math.max(1.2, this._until - 0.5));
    this._snapped = false;
  }

  /** Back to waiting after `seconds`; `announce`: news for everyone (lost a giant). */
  private _pause(seconds: number, announce?: string) {
    this._stage = 'pause';
    this._t = 0;
    this._until = seconds;
    if (announce) announceToAll(announce);
  }

  private _hook() {
    this._stage = 'fight';
    this._t = 0;
    const s = this._species;
    const r = Math.random();
    this._kg = s.kg[0] + (s.kg[1] - s.kg[0]) * r * r; // small ones more often
    this._staminaMax = s.junk ? 0 : (1.5 + this._kg * 1.6) * s.fight;
    this._stamina = this._staminaMax;
    this._tension = 0.2;
    this._near = 0.1;
    this._over = 0;
    this._slack = 0;
    this._running = false;
    this._runUntil = rand(0.3, 1);
    this._startReel();
  }

  private _land() {
    const s = this._species;
    const kg = this._kg;
    const best = loadBest();
    const record = !s.junk && kg > (best[s.name] ?? 0);
    if (record) {
      best[s.name] = kg;
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify(best));
      } catch {
        /* private mode: no record kept */
      }
    }
    this._view.fishColor.set(s.color);
    this._view.fishScale = s.junk ? 1.1 : Math.min(3, 0.55 + Math.cbrt(kg) * 0.55);
    this._stage = 'landed';
    this._t = 0;
    this._until = 2.8;
    // Every fish: a notice line in everyone's chat panel. Junk: only our own.
    if (s.junk) events.emit('game_hint', `😅 Câu được… ${s.name.toLocaleLowerCase('vi')}!`);
    else announceToAll(`Câu được ${s.name} ${kgText(kg)}!${record ? ' Kỷ lục mới!' : ''}`);
  }

  /**
   * The pull bar (bottom of the screen) while fighting a fish: how hard the
   * line is pulled (the fish + our reeling), green → yellow → red, shaking
   * close to snapping. Hidden otherwise.
   */
  private _updatePullBar() {
    const show = this._active && this._stage === 'fight' && !this._species.junk;
    if (show !== this._pullShown) {
      this._pullShown = show;
      this._pullBar.classList.toggle('open', show);
    }
    if (!show) return;
    const v = Math.max(0, Math.min(1, this._tension));
    this._pullFill.style.width = `${(v * 100).toFixed(1)}%`;
    const level = this._tension > 0.9 ? 'high' : this._tension > 0.65 ? 'mid' : 'low';
    if (this._pullBar.dataset.level !== level) this._pullBar.dataset.level = level;
    this._pullBar.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  /** The fight sound, looping (once audio has started; nothing if the file is missing). */
  private _startReel() {
    if (this._reel || this._reelLoading || !this._audio) return;
    this._reelLoading = true;
    void this._audio.loopSound(REEL_URL).then((loop) => {
      this._reelLoading = false;
      if (!loop) return;
      // The fight may be over already (the first time the file loads).
      if (!this._active || this._stage !== 'fight') return loop.stop();
      loop.setVolume(REEL_VOLUME[0]);
      this._reel = loop;
    });
  }

  private _stopReel() {
    this._reel?.stop();
    this._reel = null;
  }

  /** Take the catch in hand: the "holding up a fish" state of its species (fishing stops). */
  private _holdCatch(local: CharacterLocal) {
    heldFish.set(local, { color: this._view.fishColor.clone(), scale: this._view.fishScale });
    local.userData.a = HOLD_FISH_STATE + Math.max(0, SPECIES.indexOf(this._species));
  }

  /** Per frame. */
  update() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    this._clock += dt;
    this._updateRemotes();
    const local = this._characters.local;
    // The exact look of our catch only while we hold it (others use the species' look).
    if (!isHoldFish(local.userData.a)) heldFish.delete(local);
    const fishing = FISHING_STATES.includes(local.userData.a);
    const active = fishing && onFishingPier(local.position);
    // Walking with the rod is fine on the pier; stepping off it ends fishing.
    if (this._active && fishing && !active) local.userData.a = 0;
    if (active !== this._active) {
      this._active = active;
      this._button.classList.toggle('open', active);
      if (!active) this._updatePullBar();
      this._holding = false;
      if (active) {
        fishingViews.set(local, this._view);
        this._cast();
      } else fishingViews.delete(local);
    }
    // The fight sound lasts as long as the fight (catch, snap, escape, stop fishing).
    if (this._reel && (!active || this._stage !== 'fight')) this._stopReel();
    else if (this._reel) this._reel.setVolume(REEL_VOLUME[0] + (REEL_VOLUME[1] - REEL_VOLUME[0]) * Math.min(1, this._tension));
    this._pressed &&= active;
    if (!active) return;
    this._t += dt;
    const pressed = this._pressed;
    this._pressed = false;
    let phase = 0; // clip phase for the rod pose
    let dip = 0;
    let side = 0;
    let shake = 0;
    let bend = 0;

    switch (this._stage) {
      case 'wait': {
        // A nibble: the bobber twitches (striking now scares the fish).
        if (this._nibbleAt && this._t > this._nibbleAt) {
          this._nibble = 0.35;
          this._nibbleAt = Math.random() < 0.5 ? this._t + rand(0.8, 2) : 0;
        }
        this._nibble = Math.max(0, this._nibble - dt);
        dip = this._nibble > 0 ? 0.35 * Math.sin((this._nibble / 0.35) * Math.PI) : 0;
        shake = this._nibble > 0 ? 0.3 : 0; // the rod tip twitches too
        phase = ((this._clock / FISH_PERIOD) % 1) * 0.5;
        if (pressed) {
          this._pause(1.8); // struck on a nibble: the fish is gone
        } else if (this._t > this._until) {
          this._stage = 'bite';
          this._t = 0;
          this._until = this._species.window;
        }
        break;
      }
      case 'bite': {
        // The bobber goes under, the rod shakes and dips toward the water.
        dip = 1;
        phase = 0.45;
        shake = 1;
        bend = 0.3;
        if (pressed) this._hook();
        else if (this._t > this._until) this._pause(1.8); // too late: bait eaten
        break;
      }
      case 'fight':
        ({ phase, dip, side, shake, bend } = this._fight(dt));
        break;
      case 'landed': {
        phase = Math.min(0.72, 0.578 + (this._t / 0.5) * 0.142);
        if (this._t > this._until) {
          // A fish: off the hook and into the hand, to walk around and show
          // it off (fishing stops; 6 casts again). Junk: straight back in.
          if (this._species.junk) this._cast();
          else return this._holdCatch(local);
        }
        break;
      }
      case 'pause': {
        phase = ((this._clock / FISH_PERIOD) % 1) * 0.5;
        if (this._broken) {
          // A broken rod: no new cast; fishing stops and the shop is offered.
          if (this._t > this._until) {
            this._broken = false;
            this._snapped = false;
            local.userData.a = 0;
            events.emit('game_hint', '💥 Gãy cần rồi! Vào cửa hàng mua cần câu mới để câu tiếp nhé.');
            events.emit('webgl_emote_locked', FISH_STATE); // "Bạn cần có Cần câu" + the shop button
            return;
          }
          break;
        }
        if (this._t > 1.5) this._snapped = false;
        if (this._t > this._until) this._cast();
        break;
      }
    }

    const view = this._view;
    view.dip = dip;
    view.side = side;
    view.near = this._stage === 'fight' ? this._near : 0;
    view.lineHidden = this._snapped;
    view.broken = this._broken;
    view.shake = shake;
    view.bend = bend;
    // Steer the local clip: mixer time = ticker.time + animationOffset.
    local.animationOffset = phase * FISH_PERIOD - ticker.time;
    // The stage others see (moving resets it to 0 and ends the game).
    local.userData.a =
      this._stage === 'bite'
        ? FISH_BITE_STATE
        : this._stage === 'fight'
          ? FISH_FIGHT_STATE
          : this._stage === 'landed'
            ? FISH_LANDED_STATE
            : this._snapped
              ? FISH_SNAP_STATE
              : FISH_STATE;
    this._button.classList.toggle('held', this._holding);
    this._updatePullBar();
  }

  /**
   * Remote anglers on the pier: steer their clip phase and gear by the stage
   * they send (bobber under on a bite, rod shaking in a fight, the fish up on
   * a catch, no line after a snap). Anglers elsewhere keep the plain loop.
   */
  private _updateRemotes() {
    const seen = new Set<Object3D>();
    this._characters.forEachCharacter((id, obj) => {
      if (id === 'local') return;
      const a = (obj.userData as { a?: number }).a ?? 0;
      if (!FISHING_STATES.includes(a) || !onFishingPier(obj.position)) return;
      seen.add(obj);
      let r = this._remotes.get(obj);
      if (!r) {
        r = { view: newView(), state: -1, since: 0, seed: Math.random() * 10 };
        this._remotes.set(obj, r);
        fishingViews.set(obj, r.view);
      }
      if (r.state !== a) {
        r.state = a;
        r.since = this._clock;
      }
      poseAngler(obj as CharacterLocal, r.view, a, this._clock - r.since, this._clock, r.seed);
    });
    for (const obj of this._remotes.keys()) {
      if (seen.has(obj)) continue;
      this._remotes.delete(obj);
      fishingViews.delete(obj);
    }
  }

  private _fight(dt: number) {
    const s = this._species;
    const holding = this._holding;
    const tired = this._stamina <= 0;
    // The fish rests, then runs (not once it is exhausted).
    this._runUntil -= dt;
    if (this._runUntil <= 0) {
      this._running = !this._running && !tired;
      this._runUntil = this._running ? rand(0.6, 1.2) * s.run + Math.min(1.5, this._kg * 0.08) : rand(0.8, 2.2);
    }
    if (tired) this._running = false;
    const fresh = this._staminaMax ? 0.3 + (0.7 * this._stamina) / this._staminaMax : 0;
    const pull = s.junk ? 0.05 : forceOf(this._kg) * s.pull * (this._running ? 1 : 0.3) * fresh;
    const target = pull + (holding ? REEL_LOAD : 0);
    this._tension += (target - this._tension) * Math.min(1, dt * 4);

    // Stamina: drains fast against a reeling angler, slowly on its own runs.
    if (holding) this._stamina -= dt * (0.4 + 0.6 * this._tension);
    else if (this._running) this._stamina -= dt * 0.25;
    else this._stamina = Math.min(this._staminaMax, this._stamina + dt * 0.15);
    this._stamina = Math.max(0, this._stamina);

    // Line in / out.
    if (holding) this._near += (dt * 0.16 / (1 + this._kg * 0.06)) * (this._running ? 0.25 : 1);
    else if (this._running) this._near -= dt * 0.08;
    this._near = Math.max(0, Math.min(this._stamina > 0 ? NEAR_CAP : 1, this._near));

    this._over = this._tension > 1 ? this._over + dt : Math.max(0, this._over - dt * 0.5);
    this._slack = holding ? 0 : this._slack + dt;

    if (this._over > SNAP_AFTER) {
      this._snapped = true;
      // Its runs alone exceed what the line holds (heavy and / or strong).
      const big = forceOf(this._kg) * s.pull > 1;
      if (Math.random() < (big ? BREAK_CHANCE_BIG : BREAK_CHANCE)) {
        // The rod breaks too: gone from the wallet, a new one from the shop.
        this._broken = true;
        events.emit('mp_item_broke', ROD_ITEM);
        this._pause(2.5, `Gãy cần vì ${s.name} quá khỏe (~${kgText(this._kg)})!`);
      } else {
        this._pause(2.5, big ? `Đứt dây! ${s.name} quá to (~${kgText(this._kg)}).` : undefined);
      }
    } else if (this._slack > ESCAPE_AFTER && !s.junk) {
      this._pause(2); // too much slack: escaped
    } else if (this._near >= 1) {
      this._land();
    }
    const wiggle = this._running ? 1 : 0.4;
    return {
      phase: 0.578 + 0.012 * Math.sin(this._clock * 20) * this._tension,
      dip: 0.6 + 0.4 * wiggle,
      side: Math.sin(this._clock * 1.7) * 0.6 * wiggle * (1 - this._near),
      // What the player reads: the rod bends with the tension (near the
      // snapping point it is almost doubled over) and trembles when the fish runs.
      bend: Math.min(0.9, this._tension * 0.8),
      shake: this._running ? 0.5 : this._stamina <= 0 ? 0 : 0.15,
    };
  }
}
