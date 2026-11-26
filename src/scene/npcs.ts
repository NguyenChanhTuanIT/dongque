// Client-side NPCs: every client runs the same little scenes (deterministic
// spots, time-driven), so all players see them alike without any network
// traffic. Each group is toggled live from the admin panel
// (config.features.npcs).
//
//   seaCouple   two kids sitting on the beach watching the sea, the boy holding the girl by the waist
//   kiteFlyers  two kids strolling on the beach with kites, laughing now and then
//   guitarist   a kid playing guitar and singing at the far end of the road
//   fisher      a kid fishing at the end of the pier: nibbles, bites, fights,
//               catches (the fish floats up as text) and snapped lines, on the
//               shared clock so everyone sees the same catch at the same time
//   henFeeder   a kid strolling along the front fence of the first coop,
//               stopping to throw grains (the hens come running)
//   waterCarrier a kid with a shoulder pole and two buckets, from the well to
//               the coop's trough and back
//
// Optional sounds (drop the files in public/assets/audio/, they are picked up
// automatically; nothing plays while they are missing):
//   npc-laugh.mp3   one-shot laughter of the kite flyers (louder when close)
//   guitarsong1.mp3 looping guitar / song of the guitarist (louder when close)

import { CanvasTexture, Raycaster, Sprite, SpriteMaterial, Vector3, type Mesh, type Object3D } from 'three';
import { gsap } from 'gsap';
import { clock } from '../engine/clock';
import type { AudioController } from '../engine/audio';
import type { CharacterLocal, Characters } from '../engine/characters';
import type { SceneConfig } from '../config/schema';
import { CARRY_STATE, FEED_STATE, NET_STATE, FISH_BITE_STATE, FISH_FIGHT_STATE, FISH_LANDED_STATE, FISH_SNAP_STATE, FISH_STATE, GUITAR_STATE, KITE_STATE, NPC_STATES } from './emotes';
import { COOPS, WELL, YARD, coopPoint, npcFeeders } from './chickenCoops';
import { MEADOWS } from './butterflies';
import { CATCH_LINES, NpcTalk, SNAP_LINES, type Speaker } from './npcTalk';

/** NPC id → who speaks in the small talk (npcTalk.ts). */
const SPEAKERS: Record<string, Speaker> = {
  'couple-boy': 'coupleBoy',
  'couple-girl': 'coupleGirl',
  'kite-girl': 'kiteGirl',
  'kite-boy': 'kiteBoy',
  guitarist: 'guitarist',
  fisher: 'fisher',
  'hen-feeder': 'henFeeder',
  'water-carrier': 'waterCarrier',
  'butterfly-girl': 'butterflyGirl',
  'butterfly-boy': 'butterflyBoy',
};
import { FISH_SPECIES, fishingViews, kgText, newFishView, poseAngler, type FishView } from './fishingGame';

type Group = keyof SceneConfig['features']['npcs'];

const LAUGH_URL = '/assets/audio/npc-laugh.mp3';
const GUITAR_URL = '/assets/audio/guitarsong1.mp3';
const LAUGH_RANGE = 35;
const GUITAR_RANGE = 45;
const GUITAR_VOLUME = 1; // peak volume of the guitar song, right next to the guitarist (max 1)
/** Volume by distance: quadratic, so it stays soft far away and swells as you walk up. */
const guitarVolume = (d: number) => GUITAR_VOLUME * Math.max(0, 1 - d / GUITAR_RANGE) ** 2;
const UP = new Vector3(0, 1, 0);

/** Outfit = item index per slot [hat, hair, top, bottom, shoes, glasses]; seed = skin tone + hue. */
const LOOKS = {
  coupleBoy: { outfit: [1, 0, 0, 0, 0, 0], seed: 0.62 },
  coupleGirl: { outfit: [0, 3, 0, 1, 1, 0], seed: 1.93 },
  kiteGirl: { outfit: [1, 1, 0, 1, 0, 0], seed: 2.14 },
  kiteBoy: { outfit: [0, 0, 0, 0, 1, 1], seed: 0.36 },
  guitarist: { outfit: [1, 0, 0, 0, 0, 1], seed: 3.08 },
  fisher: { outfit: [1, 0, 1, 2, 1, 0], seed: 1.41 },
  henFeeder: { outfit: [0, 1, 2, 1, 0, 0], seed: 2.47 },
  waterCarrier: { outfit: [1, 3, 0, 0, 1, 0], seed: 0.88 },
  butterflyGirl: { outfit: [0, 1, 2, 1, 0, 0], seed: 2.86 },
  butterflyBoy: { outfit: [2, 0, 1, 0, 2, 0], seed: 0.17 },
};

/** Spots, found by probing the map: the coast runs along x ≈ 80–82 (sea toward +x). */
const SPOT = {
  couple: { x: 77, z: 0 },
  kites: { cx: 73.5, cz: 22, rx: 3, rz: 8 },
  guitarist: { x: 19.5, z: -2, lookAt: { x: 15.5, z: -57 } }, // faces the spawn, up the road
  // Far end of the pier platform (fishingPier.ts: deck x 83 … 87.5, z -21.2 … -14.8), facing the sea.
  fisher: { x: 86.9, z: -16.2 },
};

const yawToward = (dx: number, dz: number) => Math.atan2(dx, dz);

function textTexture(text: string, color: string, font: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(255, 250, 238, 0.95)';
  ctx.strokeText(text, 128, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 64);
  return new CanvasTexture(canvas);
}

/** Deterministic hash of two integers → [0, 1) (the same on every client). */
function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/**
 * The fisher's round n (FISHER_CYCLE s on the shared clock): wait (a nibble
 * near the end), bite, fight, then a catch or a snapped line, then wait again.
 */
const FISHER_CYCLE = 28;
function fisherRound(n: number) {
  const wait = 4 + 6 * hash01(n, 1);
  const bite = 0.7;
  const fight = 5 + 8 * hash01(n, 2);
  const caught = hash01(n, 3) < 0.75;
  // What bit: by the species' chances; a catch is never too big for the line.
  const pool = FISH_SPECIES.filter((s) => !caught || s.kg[1] <= 9);
  let r = hash01(n, 4) * pool.reduce((sum, s) => sum + s.chance, 0);
  const species = pool.find((s) => (r -= s.chance) < 0) ?? pool[0];
  const k = hash01(n, 5);
  const kg = species.kg[0] + (species.kg[1] - species.kg[0]) * k * k;
  return { wait, bite, fight, caught, outcome: caught ? 3 : 2.5, species, kg };
}

interface Fisher {
  npc: CharacterLocal;
  view: FishView;
  /** Last stage shown (a new one pops the catch / snap text once). */
  state: number;
  round: number;
}

/**
 * A daily routine on the shared clock: walk to each stop in turn, stay there
 * in a pose, facing a point. Same position / pose on every client at any time.
 */
interface Stop {
  at: Vector3;
  /** Seconds to walk here from the previous stop, then to stay. */
  walk: number;
  stay: number;
  /** Pose while staying (and while walking: walkState). */
  state: number;
  face: { x: number; z: number };
}
interface Routine {
  npc: CharacterLocal;
  stops: Stop[];
  walkState: number;
  cycle: number;
  yaw: number;
}

function routineAt(r: Routine, time: number) {
  let u = ((time % r.cycle) + r.cycle) % r.cycle;
  for (let k = 0; k < r.stops.length; k++) {
    const stop = r.stops[k];
    const prev = r.stops[(k + r.stops.length - 1) % r.stops.length].at;
    if (u < stop.walk) {
      const f = u / stop.walk;
      const x = prev.x + (stop.at.x - prev.x) * f;
      const z = prev.z + (stop.at.z - prev.z) * f;
      const dx = stop.at.x - prev.x;
      const dz = stop.at.z - prev.z;
      return { x, z, speed: Math.hypot(dx, dz) / stop.walk, yaw: yawToward(dx, dz), state: r.walkState };
    }
    u -= stop.walk;
    if (u < stop.stay || k === r.stops.length - 1) {
      return { x: stop.at.x, z: stop.at.z, speed: 0, yaw: yawToward(stop.face.x - stop.at.x, stop.face.z - stop.at.z), state: stop.state };
    }
    u -= stop.stay;
  }
  const last = r.stops[r.stops.length - 1];
  return { x: last.at.x, z: last.at.z, speed: 0, yaw: r.yaw, state: last.state };
}

/**
 * A kid running after butterflies: around a wavy loop over the butterfly
 * meadow, CHASE_RUN s running then CHASE_STOP s sweeping the net on the spot,
 * on the shared clock (same place on every client).
 */
interface Chaser {
  npc: CharacterLocal;
  /** Start angle on the loop and offset in the run / stop schedule (s). */
  start: number;
  schedule: number;
  yaw: number;
}
const CHASE_RUN = 6.5;
const CHASE_STOP = 3;
const CHASE_SPEED = 1.6; // m/s
const CHASE_RX = 3.2;
const CHASE_RZ = 4.3;

function chaseAt(c: Chaser, time: number) {
  const m = MEADOWS[0];
  const cycle = CHASE_RUN + CHASE_STOP;
  const t = time + c.schedule;
  const n = Math.floor(t / cycle);
  const into = t - n * cycle;
  const running = into < CHASE_RUN;
  // Distance run so far (wrapped every 10 000 rounds: one jump every ~26 h).
  const s = (n % 10000) * CHASE_RUN * CHASE_SPEED + CHASE_SPEED * Math.min(into, CHASE_RUN);
  const radius = (CHASE_RX + CHASE_RZ) / 2;
  const a = c.start + s / radius;
  // A loop with a wobble (three bumps per round) so the run is not a plain ellipse.
  const x = m.x + CHASE_RX * Math.cos(a) + 0.8 * Math.sin(3 * a);
  const z = m.z + CHASE_RZ * Math.sin(a);
  const dx = -CHASE_RX * Math.sin(a) + 2.4 * Math.cos(3 * a);
  const dz = CHASE_RZ * Math.cos(a);
  return { x, z, yaw: Math.atan2(dx, dz), speed: running ? CHASE_SPEED : 0 };
}

/**
 * Kite flyers: a KITE_CYCLE-second cycle, strolling KITE_WALK s (speeding up
 * and slowing down over KITE_RAMP s) then flying the kite on the spot. Distance
 * walked at time t, as a pure function of the shared clock.
 */
const KITE_CYCLE = 12;
const KITE_WALK = 7;
const KITE_RAMP = 0.8;
const KITE_SPEED = 1.1; // m/s
const LAUGH_SLOT = 8;
function kiteWalk(t: number) {
  const n = Math.floor(t / KITE_CYCLE);
  const into = t - n * KITE_CYCLE;
  const v = KITE_SPEED;
  const r = KITE_RAMP;
  const perCycle = v * (KITE_WALK - r);
  let d: number;
  let speed: number;
  if (into >= KITE_WALK) [d, speed] = [perCycle, 0];
  else if (into < r) [d, speed] = [(v * into * into) / (2 * r), (v * into) / r];
  else if (into <= KITE_WALK - r) [d, speed] = [v * (into - r / 2), v];
  else {
    const left = KITE_WALK - into;
    [d, speed] = [perCycle - (v * left * left) / (2 * r), (v * left) / r];
  }
  // Wrapped every 10 000 cycles (one small jump every ~33 h).
  return { distance: (n % 10000) * perCycle + d, speed };
}

interface KiteWalker {
  npc: CharacterLocal;
  phase: number; // offset on the ellipse
  u: number;
  yaw: number;
  speed: number;
  schedule: number; // offset in the walk / stop cycle
}

export class NpcManager {
  private _enabled: Record<Group, boolean> = {
    seaCouple: false,
    kiteFlyers: false,
    guitarist: false,
    fisher: false,
    henFeeder: false,
    waterCarrier: false,
    butterflyKids: false,
  };
  private _active = new Map<Group, string[]>();
  private _walkers: KiteWalker[] = [];
  private _fisher: Fisher | null = null;
  /** Hen feeder and water carrier. */
  private _routines = new Map<Group, Routine>();
  /** The two butterfly chasers. */
  private _chasers: Chaser[] = [];
  private _guitarist: CharacterLocal | null = null;
  private _guitarLoop: { setVolume(v: number): void; stop(): void } | null = null;
  private _guitarLoopPending = false;
  private _rc = new Raycaster();
  private _textures = new Map<string, CanvasTexture>();
  /** Last laughter slot seen (-1: none yet; the first one is skipped). */
  private _laughSlot = -1;
  private _nextNote = 0;
  private _time = 0;
  /** The NPCs' small talk (speech bubbles). */
  private _talk = new NpcTalk();

  constructor(
    private _scene: Object3D,
    private _characters: Characters,
    private _audio: AudioController | undefined,
  ) {
    (this._rc as any).firstHitOnly = true;
  }

  /** Apply the admin toggles (safe to call repeatedly). */
  configure(npcs: SceneConfig['features']['npcs']) {
    for (const group of Object.keys(this._enabled) as Group[]) this._enabled[group] = npcs[group];
  }

  private _collider(): Mesh | null {
    return ((this._characters as any)._collisionPhysics?.collider as Mesh) ?? null;
  }

  /** Ground height under (x, z), from the walk collider (BVH accelerated). */
  private _ground(x: number, z: number): number {
    const collider = this._collider();
    if (!collider) return 0;
    this._rc.set(new Vector3(x, 60, z), new Vector3(0, -1, 0));
    this._rc.far = 120;
    return this._rc.intersectObject(collider, false)[0]?.point.y ?? 0;
  }

  private _spawn(id: string, look: { outfit: number[]; seed: number }, x: number, z: number, yaw: number, state: number) {
    const npc = this._characters.addNpc(id, { p: [x, this._ground(x, z), z], r: [Math.PI / 2, 0], a: state, seed: look.seed });
    npc.userData.a = state;
    npc.userData.seed = look.seed;
    npc.userData.outfit = [...look.outfit];
    npc.quaternion.setFromAxisAngle(UP, yaw);
    npc.velocityHorizontal = 0;
    if (SPEAKERS[id]) this._talk.set(SPEAKERS[id], npc);
    return npc;
  }

  private _show(group: Group) {
    const ids: string[] = [];
    if (group === 'seaCouple') {
      const { x, z } = SPOT.couple;
      const yaw = yawToward(1, 0); // facing the sea (+x)
      // the girl sits on the boy's right side (his right = world +z here); he
      // holds her by the waist, she just sits and watches the sea
      const right = new Vector3(-1, 0, 0).applyAxisAngle(UP, yaw);
      this._spawn('couple-boy', LOOKS.coupleBoy, x, z, yaw, NPC_STATES.sitHoldWaist);
      this._spawn('couple-girl', LOOKS.coupleGirl, x + right.x * 0.42, z + right.z * 0.42, yaw, NPC_STATES.sitRelaxed);
      ids.push('couple-boy', 'couple-girl');
    } else if (group === 'kiteFlyers') {
      const { cx, cz, rx, rz } = SPOT.kites;
      this._walkers = [
        { id: 'kite-girl', look: LOOKS.kiteGirl, phase: 0, schedule: 0 },
        { id: 'kite-boy', look: LOOKS.kiteBoy, phase: Math.PI * 0.9, schedule: 5.5 },
      ].map(({ id, look, phase, schedule }) => {
        const npc = this._spawn(id, look, cx + rx * Math.cos(phase), cz + rz * Math.sin(phase), 0, KITE_STATE);
        ids.push(id);
        return { npc, phase, u: phase, yaw: 0, speed: 0, schedule };
      });
    } else if (group === 'fisher') {
      const { x, z } = SPOT.fisher;
      const npc = this._spawn('fisher', LOOKS.fisher, x, z, yawToward(1, 0), FISH_STATE); // facing the sea (+x)
      const view = newFishView();
      fishingViews.set(npc, view);
      this._fisher = { npc, view, state: -1, round: -1 };
      ids.push('fisher');
    } else if (group === 'henFeeder') {
      // Along the front fence of the first coop: throw grains at two spots
      // (8 s each), stroll between them, rest a moment watching the hens.
      const c = COOPS[0];
      const yard = { x: c.x, z: c.z };
      const a = coopPoint(0, -1.3, YARD.z + 0.6);
      const b = coopPoint(0, 1.3, YARD.z + 0.6);
      const stops: Stop[] = [
        { at: a, walk: 3, stay: 8, state: FEED_STATE, face: yard },
        { at: b, walk: 3, stay: 8, state: FEED_STATE, face: yard },
        { at: a.clone().lerp(b, 0.5), walk: 1.5, stay: 3.5, state: 0, face: yard },
      ];
      const npc = this._spawn('hen-feeder', LOOKS.henFeeder, a.x, a.z, 0, FEED_STATE);
      npcFeeders.add(npc);
      this._routines.set(group, { npc, stops, walkState: 0, cycle: stops.reduce((s, k) => s + k.walk + k.stay, 0), yaw: 0 });
      ids.push('hen-feeder');
    } else if (group === 'waterCarrier') {
      // Well → the trough on the coop's side → back, buckets on the pole.
      const well = new Vector3(WELL.x + WELL.r + 0.65, 0, WELL.z);
      const trough = coopPoint(0, YARD.troughX, YARD.troughZ);
      const drop = coopPoint(0, YARD.x + 0.7, YARD.troughZ);
      const stops: Stop[] = [
        { at: drop, walk: 12, stay: 4, state: CARRY_STATE, face: { x: trough.x, z: trough.z } },
        { at: well, walk: 12, stay: 4, state: CARRY_STATE, face: { x: WELL.x, z: WELL.z } },
      ];
      const npc = this._spawn('water-carrier', LOOKS.waterCarrier, well.x, well.z, 0, CARRY_STATE);
      this._routines.set(group, { npc, stops, walkState: CARRY_STATE, cycle: stops.reduce((s, k) => s + k.walk + k.stay, 0), yaw: 0 });
      ids.push('water-carrier');
    } else if (group === 'butterflyKids') {
      // Half a loop apart, out of step: one runs while the other sweeps the net.
      this._chasers = [
        { id: 'butterfly-girl', look: LOOKS.butterflyGirl, start: 0, schedule: 0 },
        { id: 'butterfly-boy', look: LOOKS.butterflyBoy, start: Math.PI, schedule: 4.7 },
      ].map(({ id, look, start, schedule }) => {
        const c: Chaser = { npc: null as unknown as CharacterLocal, start, schedule, yaw: 0 };
        const at = chaseAt(c, this._characters.sharedTime());
        c.npc = this._spawn(id, look, at.x, at.z, at.yaw, NET_STATE);
        c.yaw = at.yaw;
        ids.push(id);
        return c;
      });
    } else {
      const { x, z, lookAt } = SPOT.guitarist;
      this._guitarist = this._spawn('guitarist', LOOKS.guitarist, x, z, yawToward(lookAt.x - x, lookAt.z - z), GUITAR_STATE);
      ids.push('guitarist');
    }
    this._active.set(group, ids);
  }

  private _hide(group: Group) {
    for (const id of this._active.get(group) ?? []) {
      this._characters.removeNpc(id);
      if (SPEAKERS[id]) this._talk.set(SPEAKERS[id], null);
    }
    this._active.delete(group);
    if (group === 'kiteFlyers') this._walkers = [];
    if (group === 'butterflyKids') this._chasers = [];
    if (group === 'fisher' && this._fisher) {
      fishingViews.delete(this._fisher.npc);
      this._fisher = null;
    }
    const routine = this._routines.get(group);
    if (routine) {
      npcFeeders.delete(routine.npc);
      this._routines.delete(group);
    }
    if (group === 'guitarist') {
      this._guitarist = null;
      this._guitarLoop?.stop();
      this._guitarLoop = null;
    }
  }

  /** Per frame, after the characters updated. */
  update() {
    if (!this._collider()) return; // wait for the walk collider (ground heights)
    for (const group of Object.keys(this._enabled) as Group[]) {
      if (this._enabled[group] && !this._active.has(group)) this._show(group);
      else if (!this._enabled[group] && this._active.has(group)) this._hide(group);
    }
    const dt = Math.min(0.1, clock.delta / 1000);
    this._time += dt;
    const player = (this._characters as any)._localObject as CharacterLocal;
    this._updateKites(dt, player);
    this._updateGuitarist(player);
    this._updateFisher(player);
    this._updateRoutines(dt);
    this._updateChasers(dt);
    this._talk.update(this._characters.sharedTime(), player.position);
  }

  /** The butterfly chasers: on their loop, turning smoothly (also while sweeping). */
  private _updateChasers(dt: number) {
    if (!this._chasers.length) return;
    const now = this._characters.sharedTime();
    for (const c of this._chasers) {
      const at = chaseAt(c, now);
      if (at.speed > 0) {
        let turn = at.yaw - c.yaw;
        turn = Math.atan2(Math.sin(turn), Math.cos(turn));
        c.yaw += turn * Math.min(1, dt * 8);
      }
      c.npc.position.set(at.x, this._ground(at.x, at.z), at.z);
      c.npc.quaternion.setFromAxisAngle(UP, c.yaw);
      c.npc.velocityHorizontal = at.speed / 60; // the engine measures speed per 60 fps frame
      c.npc.userData.a = NET_STATE;
    }
  }

  /** Hen feeder, water carrier: where the shared clock puts them, turning smoothly. */
  private _updateRoutines(dt: number) {
    if (!this._routines.size) return;
    const now = this._characters.sharedTime();
    for (const r of this._routines.values()) {
      const at = routineAt(r, now);
      let turn = at.yaw - r.yaw;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      r.yaw += turn * Math.min(1, dt * 6);
      r.npc.position.set(at.x, this._ground(at.x, at.z), at.z);
      r.npc.quaternion.setFromAxisAngle(UP, r.yaw);
      r.npc.velocityHorizontal = at.speed / 60; // the engine measures speed per 60 fps frame
      r.npc.userData.a = at.state;
    }
  }

  /**
   * The fisher plays the same stages as a player (fishingGame.ts states),
   * scheduled on the shared clock: every client shows the same nibble, bite,
   * fight and catch at the same moment. Only the stage shows (no tension):
   * the rod bends and trembles in surges like a remote angler's.
   */
  private _updateFisher(player: CharacterLocal) {
    const f = this._fisher;
    if (!f) return;
    const now = this._characters.sharedTime();
    const n = Math.floor(now / FISHER_CYCLE);
    const u = now - n * FISHER_CYCLE;
    const r = fisherRound(n);
    const biteAt = r.wait;
    const fightAt = biteAt + r.bite;
    const endAt = fightAt + r.fight;
    let state = FISH_STATE;
    let since = 0;
    if (u >= biteAt && u < fightAt) [state, since] = [FISH_BITE_STATE, biteAt];
    else if (u >= fightAt && u < endAt) [state, since] = [FISH_FIGHT_STATE, fightAt];
    else if (u >= endAt && u < endAt + r.outcome) [state, since] = [r.caught ? FISH_LANDED_STATE : FISH_SNAP_STATE, endAt];
    f.npc.userData.a = state;
    poseAngler(f.npc, f.view, state, u - since, now, 0.37);
    // A nibble or two before the bite: the bobber twitches, the rod tip too.
    if (state === FISH_STATE && u < biteAt) {
      const before = biteAt - u;
      const nibble = before > 1.6 && before < 2 ? Math.sin(((2 - before) / 0.4) * Math.PI) : 0;
      f.view.dip = 0.35 * nibble;
      f.view.shake = 0.3 * nibble;
    }
    if (state === FISH_LANDED_STATE) {
      f.view.fishColor.set(r.species.color);
      f.view.fishScale = r.species.junk ? 1.1 : Math.min(3, 0.55 + Math.cbrt(r.kg) * 0.55);
    }
    // The outcome floats up once (for players close enough to read it).
    if (state !== f.state || n !== f.round) {
      const close = f.npc.position.distanceTo(player.position) < 45;
      if (close && state === FISH_LANDED_STATE) {
        const text = r.species.junk ? `😅 ${r.species.name}` : `🐟 ${r.species.name} ${kgText(r.kg)}`;
        this._float(f.npc.position, text, '#2f5d8a', 'bold 30px sans-serif', 2, 0.6, 0, false);
      } else if (close && state === FISH_SNAP_STATE) {
        this._float(f.npc.position, 'đứt dây!', '#c0563b', 'bold 44px sans-serif', 2, 0.5);
      }
      // And says something about it (a bubble; the same line on every client).
      if (f.state !== -1 && state === FISH_LANDED_STATE && !r.species.junk) this._talk.say('fisher', this._talk.pick(CATCH_LINES, n));
      else if (f.state !== -1 && state === FISH_SNAP_STATE) this._talk.say('fisher', this._talk.pick(SNAP_LINES, n));
      f.state = state;
      f.round = n;
    }
  }

  private _updateKites(dt: number, player: CharacterLocal) {
    if (!this._walkers.length) return;
    void dt;
    const { cx, cz, rx, rz } = SPOT.kites;
    const radius = Math.sqrt((rx * rx + rz * rz) / 2);
    // Shared clock: every client shows them at the same spot on the beach.
    const now = this._characters.sharedTime();
    for (const w of this._walkers) {
      const { distance, speed } = kiteWalk(now + w.schedule);
      w.speed = speed;
      w.u = w.phase + distance / radius;
      const x = cx + rx * Math.cos(w.u);
      const z = cz + rz * Math.sin(w.u);
      if (w.speed > 0.05) w.yaw = yawToward(-rx * Math.sin(w.u), rz * Math.cos(w.u));
      w.npc.position.set(x, this._ground(x, z), z);
      w.npc.quaternion.setFromAxisAngle(UP, w.yaw);
      w.npc.velocityHorizontal = w.speed / 60; // the engine measures speed per 60 fps frame
    }
    // Laughter: in some LAUGH_SLOT-second slots one of them laughs ("ha ha!" +
    // optional sound), picked by the shared clock (the same one on every client).
    const slot = Math.floor(now / LAUGH_SLOT);
    if (slot !== this._laughSlot) {
      const first = this._laughSlot < 0;
      this._laughSlot = slot;
      if (first || hash01(slot, 31) > 0.7) return;
      const w = this._walkers[hash01(slot, 32) < 0.5 ? 0 : 1] ?? this._walkers[0];
      const d = w.npc.position.distanceTo(player.position);
      if (d < 60) this._float(w.npc.position, 'ha ha!', '#c0563b', 'bold 64px sans-serif', 1.75, 0.55);
      if (d < LAUGH_RANGE) void this._audio?.playOnce(LAUGH_URL, 0.7 * (1 - d / LAUGH_RANGE));
    }
  }

  private _updateGuitarist(player: CharacterLocal) {
    const g = this._guitarist;
    if (!g) return;
    const d = g.position.distanceTo(player.position);
    if (d < 70 && this._time >= this._nextNote) {
      this._nextNote = this._time + 0.7 + Math.random() * 0.5;
      const note = Math.random() < 0.5 ? '♪' : '♫';
      this._float(g.position, note, '#5b4636', 'bold 96px serif', 1.6, 0.42, (Math.random() - 0.5) * 0.6);
    }
    // optional song: a loop whose volume follows the distance
    if (!this._guitarLoop && !this._guitarLoopPending && this._audio) {
      this._guitarLoopPending = true;
      void this._audio.loopSound(GUITAR_URL).then((loop) => {
        this._guitarLoopPending = false;
        if (!this._guitarist) loop?.stop();
        else this._guitarLoop = loop;
      });
    }
    this._guitarLoop?.setVolume(guitarVolume(d));
  }

  /**
   * A floating text sprite above a character (notes, laughter, a catch).
   * `cache` = false for one-off texts (a catch's weight): the texture is
   * dropped afterwards instead of kept for reuse.
   */
  private _float(at: Vector3, text: string, color: string, font: string, height: number, size: number, drift = 0, cache = true) {
    const key = `${text}|${color}|${font}`;
    let texture = cache ? this._textures.get(key) : undefined;
    if (!texture) {
      texture = textTexture(text, color, font);
      if (cache) this._textures.set(key, texture);
    }
    const oneOff = cache ? null : texture;
    const material = new SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new Sprite(material);
    sprite.position.copy(at).add(new Vector3(drift, height, 0));
    sprite.scale.set(size * 2, size, 1);
    sprite.renderOrder = 10;
    this._scene.add(sprite);
    gsap.fromTo(sprite.scale, { x: 0.01, y: 0.01 }, { x: size * 2, y: size, duration: 0.3, ease: 'back.out(2)' });
    gsap.to(sprite.position, { y: sprite.position.y + 0.9, x: sprite.position.x + drift * 0.5, duration: 2, ease: 'sine.out' });
    gsap.to(material, {
      opacity: 0,
      delay: 1.2,
      duration: 0.8,
      onComplete: () => {
        this._scene.remove(sprite);
        material.dispose();
        oneOff?.dispose();
      },
    });
  }
}
