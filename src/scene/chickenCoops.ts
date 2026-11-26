// Chicken coops (chuồng gà): a hen house on stilts with a low fenced yard in
// front, a flock pecking around. "Cho gà ăn" (G) only works standing at the
// fence (anywhere around the front and sides of the yard) — see spots.ts. The hens are
// client-side only: every client sees them run to wherever grains land.
//
// Spots were found by probing the walk collider (flat ground over ~9×9 m,
// no tree, bush or rock within ~5.5 m), like the benches. The coop's boxes
// join the walk collider (coopColliderBoxes → benchCollider).

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Mesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Object3D,
} from 'three';
import { mergeBufferGeometries as mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Characters } from '../engine/characters';
import { FEED_STATE } from './emotes';
import { AreaActivity } from './spots';

export interface CoopSpot {
  x: number;
  /** Ground height under the coop. */
  y: number;
  z: number;
  /** Direction from the hen house toward the yard front: (sin yaw, cos yaw). */
  yaw: number;
}

/** Coop spots (world space): the origin is the yard center. */
export const COOPS: CoopSpot[] = [
  // Big flat meadow east of the western grove (bench at (-22.8, 2.4) north of it).
  { x: -19, y: 0.01, z: -10, yaw: Math.PI / 2 },
  // Flat field far west, south of the bench at (-49, -20).
  { x: -53, y: 1.52, z: -15, yaw: Math.PI / 2 },
];

// Coop shape (coop space: +x along the front fence, +z toward the front, y up).
/** Yard: x in ±YARD_X, z in ±YARD_Z. */
const YARD_X = 2.6;
const YARD_Z = 1.8;
const FENCE_H = 0.45;
/** Posts and boards reach below the ground so slopes never show a gap. */
const SINK = 0.15;
/** Hen house behind the yard. */
const HOUSE_W = 2.4;
const HOUSE_D = 1.3;
const HOUSE_Z = -YARD_Z - HOUSE_D / 2 - 0.08;
const FLOOR_Y = 0.4;
const WALL_H = 0.85;
/** Gap in the back fence for the ramp. */
const RAMP_HALF = 0.35;
/** Feeding works anywhere this far around the yard (front and sides). */
const AROUND = 2;
/** Hens notice someone feeding this close to the yard center. */
const NOTICE = 6.5;
const HENS_PER_COOP = 10;

const UP = new Vector3(0, 1, 0);

/** Hens are only simulated / uploaded while the player is this close to a coop. */
const HEN_RANGE = 70;

/** Coop axes, computed once (COOPS is fixed): no allocation per frame. */
const FRAMES = new Map(
  COOPS.map((c) => [c, { forward: new Vector3(Math.sin(c.yaw), 0, Math.cos(c.yaw)), along: new Vector3(Math.cos(c.yaw), 0, -Math.sin(c.yaw)) }]),
);
function frame(c: CoopSpot) {
  return FRAMES.get(c)!;
}

/** Coop-space point → world. */
function toWorld(c: CoopSpot, x: number, y: number, z: number, out = new Vector3()): Vector3 {
  const { forward, along } = frame(c);
  return out.set(c.x, c.y, c.z).addScaledVector(along, x).addScaledVector(UP, y).addScaledVector(forward, z);
}

/** World position → coop space (x along the fence, z toward the front). */
function toCoop(c: CoopSpot, p: Vector3) {
  const { forward, along } = frame(c);
  const dx = p.x - c.x;
  const dz = p.z - c.z;
  return { x: dx * along.x + dz * along.z, z: dx * forward.x + dz * forward.z, y: p.y - c.y };
}

/** The coop whose surroundings (front and sides of the yard, outside the fence) hold `p`. */
function coopAround(p: Vector3): CoopSpot | null {
  for (const c of COOPS) {
    const l = toCoop(c, p);
    if (Math.abs(l.y) < 1.2 && Math.abs(l.x) < YARD_X + AROUND && l.z > -YARD_Z && l.z < YARD_Z + AROUND) return c;
  }
  return null;
}

// ---- geometry ----

/** A box (coop space) with a flat vertex color, optionally tilted about x. */
function box(w: number, h: number, d: number, x: number, y: number, z: number, color: string, tiltX = 0): BufferGeometry {
  const g = new BoxGeometry(w, h, d).toNonIndexed();
  if (tiltX) g.rotateX(tiltX);
  g.translate(x, y, z);
  return paint(g, color);
}

export function paint(g: BufferGeometry, color: string): BufferGeometry {
  const c = new Color(color);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new Float32BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g.index ? g.toNonIndexed() : g;
}

const POST = '#7d5a3a';
const RAIL = '#a77d51';
const WALL = '#b88d5e';
const PLANK = '#9a7048';
const ROOF = '#c9a45c';
const DOOR = '#3f2d1e';

/** One coop (fence + hen house + ramp + troughs), in coop space. */
function coopGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const post = (x: number, z: number) => parts.push(box(0.07, FENCE_H + SINK + 0.05, 0.07, x, (FENCE_H + 0.05 - SINK) / 2, z, POST));
  const fence = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const n = Math.max(1, Math.round(len / 0.7));
    for (let k = 0; k <= n; k++) post(x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n);
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0);
    for (const y of [0.17, 0.37]) {
      parts.push(box(alongX ? len : 0.035, 0.05, alongX ? 0.035 : len, (x0 + x1) / 2, y, (z0 + z1) / 2, RAIL));
    }
  };
  fence(-YARD_X, YARD_Z, YARD_X, YARD_Z);
  fence(-YARD_X, -YARD_Z, -YARD_X, YARD_Z);
  fence(YARD_X, -YARD_Z, YARD_X, YARD_Z);
  fence(-YARD_X, -YARD_Z, -RAMP_HALF, -YARD_Z);
  fence(RAMP_HALF, -YARD_Z, YARD_X, -YARD_Z);

  // Hen house on six stilts.
  for (const sx of [-1, 0, 1]) for (const sz of [-1, 1]) {
    parts.push(box(0.09, FLOOR_Y + SINK, 0.09, sx * (HOUSE_W / 2 - 0.07), (FLOOR_Y - SINK) / 2, HOUSE_Z + sz * (HOUSE_D / 2 - 0.07), POST));
  }
  parts.push(box(HOUSE_W, 0.06, HOUSE_D, 0, FLOOR_Y + 0.03, HOUSE_Z, PLANK));
  parts.push(box(HOUSE_W - 0.04, WALL_H, HOUSE_D - 0.04, 0, FLOOR_Y + WALL_H / 2, HOUSE_Z, WALL));
  // Plank lines on the front wall, the dark door and two little windows.
  const front = HOUSE_Z + HOUSE_D / 2 - 0.01;
  for (let k = 1; k < 4; k++) parts.push(box(HOUSE_W - 0.04, 0.02, 0.02, 0, FLOOR_Y + (k * WALL_H) / 4, front, PLANK));
  parts.push(box(0.38, 0.48, 0.03, 0, FLOOR_Y + 0.25, front + 0.01, DOOR));
  for (const sx of [-1, 1]) parts.push(box(0.26, 0.2, 0.03, sx * 0.75, FLOOR_Y + 0.55, front + 0.01, DOOR));
  // Gable roof: two slanted thatch panels, ridge along x.
  const pitch = 0.62;
  const half = HOUSE_D / 2 + 0.18;
  const panel = half / Math.cos(pitch);
  const eave = FLOOR_Y + WALL_H;
  for (const s of [-1, 1]) {
    // ridge at eave + tan·(D/2); the panel center is half a panel drop below it
    parts.push(box(HOUSE_W + 0.35, 0.08, panel, 0, eave + Math.tan(pitch) * (HOUSE_D / 2 - half / 2), HOUSE_Z + (s * half) / 2, ROOF, s * pitch));
  }
  // Gable ends (a narrower box) so the roof is closed.
  const rise = Math.tan(pitch) * (HOUSE_D / 2);
  parts.push(box(HOUSE_W - 0.04, rise * 0.55, HOUSE_D * 0.45, 0, eave + rise * 0.28, HOUSE_Z, WALL));
  // Ramp from the door down into the yard, with little steps.
  const run = 0.85;
  parts.push(box(0.42, 0.035, Math.hypot(FLOOR_Y, run), 0, FLOOR_Y / 2, front + run / 2, PLANK, Math.atan2(FLOOR_Y, run)));
  for (let k = 1; k <= 3; k++) {
    const f = k / 4;
    parts.push(box(0.42, 0.025, 0.025, 0, FLOOR_Y * (1 - f) + 0.03, front + run * f, POST));
  }
  // Water troughs in the back corners.
  for (const sx of [-1, 1]) {
    parts.push(box(0.55, 0.1, 0.18, sx * (YARD_X - 0.5), 0.05, -YARD_Z + 0.35, '#8d8a84'));
    parts.push(box(0.49, 0.02, 0.12, sx * (YARD_X - 0.5), 0.1, -YARD_Z + 0.35, '#6a9bc4'));
  }
  return mergeGeometries(parts)!;
}

/** One hen (feet at the origin, beak toward +z). */
function henGeometry(body: string, wing: string): BufferGeometry {
  const sphere = (r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, color: string) => {
    const g = new SphereGeometry(r, 10, 7).toNonIndexed();
    g.scale(sx, sy, sz);
    g.translate(x, y, z);
    return paint(g, color);
  };
  const cone = (r: number, h: number, x: number, y: number, z: number, rotX: number, color: string) => {
    const g = new ConeGeometry(r, h, 6).toNonIndexed();
    g.rotateX(rotX);
    g.translate(x, y, z);
    return paint(g, color);
  };
  const parts = [
    sphere(0.1, 0.95, 0.85, 1.2, 0, 0.17, 0, body),
    sphere(0.06, 0.4, 0.8, 1.2, 0.085, 0.18, -0.01, wing),
    sphere(0.06, 0.4, 0.8, 1.2, -0.085, 0.18, -0.01, wing),
    cone(0.06, 0.13, 0, 0.25, -0.12, -0.9, wing), // tail, up and back
    sphere(0.055, 1, 1, 1, 0, 0.29, 0.1, body),
    cone(0.018, 0.05, 0, 0.285, 0.17, Math.PI / 2, '#e8b33c'), // beak
    box(0.016, 0.04, 0.06, 0, 0.345, 0.1, '#d6403a'), // comb
    sphere(0.014, 1, 1.4, 1, 0, 0.255, 0.145, '#d6403a'), // wattle
    box(0.014, 0.1, 0.014, 0.035, 0.05, 0, '#e29a3a'),
    box(0.014, 0.1, 0.014, -0.035, 0.05, 0, '#e29a3a'),
  ];
  return mergeGeometries(parts)!;
}

/** Solid boxes (world space) for the walk collider: hen house and fence. */
export function coopColliderBoxes(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const m = new Matrix4();
  const q = new Quaternion();
  const one = new Vector3(1, 1, 1);
  const add = (c: CoopSpot, w: number, h: number, d: number, x: number, z: number) => {
    const g = new BoxGeometry(w, h + SINK, d);
    g.translate(x, (h - SINK) / 2, z);
    g.applyMatrix4(m.compose(new Vector3(c.x, c.y, c.z), q.setFromAxisAngle(UP, c.yaw), one));
    out.push(g);
  };
  for (const c of COOPS) {
    add(c, HOUSE_W + 0.1, FLOOR_Y + WALL_H + 0.45, HOUSE_D + 0.1, 0, HOUSE_Z);
    add(c, 2 * YARD_X + 0.1, FENCE_H, 0.1, 0, YARD_Z);
    add(c, 0.1, FENCE_H, 2 * YARD_Z, -YARD_X, 0);
    add(c, 0.1, FENCE_H, 2 * YARD_Z, YARD_X, 0);
    add(c, 2 * YARD_X + 0.1, FENCE_H, 0.1, 0, -YARD_Z);
  }
  // The well.
  const well = new BoxGeometry(2 * WELL.r + 0.1, 0.9, 2 * WELL.r + 0.1);
  well.translate(WELL.x, WELL.y + 0.3, WELL.z);
  out.push(well);
  return out;
}

// ---- farm helpers for the NPCs (npcs.ts) ----

/** The well the water carrier draws from (open meadow west of the first coop). */
export const WELL = { x: -32.3, y: 0.17, z: -14.5, r: 0.55 };

/** Coop-space point of coop `i` → world (x along the front fence, z toward the front). */
export function coopPoint(i: number, x: number, z: number): Vector3 {
  return toWorld(COOPS[i], x, 0, z);
}
/** Yard half sizes (coop space), for NPC spots around the fence. */
export const YARD = { x: YARD_X, z: YARD_Z, troughZ: -YARD_Z + 0.35, troughX: YARD_X - 0.5 };

/** NPCs feeding the hens (characters.forEachCharacter skips NPCs). */
export const npcFeeders = new Set<Object3D>();

function wellGeometry(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const ring = new CylinderGeometry(WELL.r, WELL.r + 0.05, 0.75, 16, 1, true).toNonIndexed();
  ring.translate(0, 0.25, 0);
  parts.push(paint(ring, '#9c9890'));
  const rim = new CylinderGeometry(WELL.r + 0.06, WELL.r + 0.06, 0.08, 16).toNonIndexed();
  rim.translate(0, 0.64, 0);
  parts.push(paint(rim, '#b7b2a8'));
  const inner = new CylinderGeometry(WELL.r - 0.06, WELL.r - 0.06, 0.7, 16, 1, true).toNonIndexed();
  inner.scale(-1, 1, 1); // faces inward
  inner.translate(0, 0.28, 0);
  parts.push(paint(inner, '#6f6b64'));
  const water = new CylinderGeometry(WELL.r - 0.06, WELL.r - 0.06, 0.02, 16).toNonIndexed();
  water.translate(0, 0.2, 0);
  parts.push(paint(water, '#3f6e8c'));
  // Two posts, a crossbar with a rope and a bucket, a small tiled roof.
  for (const s of [-1, 1]) parts.push(box(0.08, 1.5, 0.08, s * (WELL.r + 0.05), 0.75, 0, POST));
  parts.push(box(2 * WELL.r + 0.25, 0.06, 0.06, 0, 1.3, 0, POST));
  parts.push(box(0.015, 0.55, 0.015, 0, 1.0, 0, '#d8c79a'));
  const bucket = new CylinderGeometry(0.09, 0.07, 0.14, 10).toNonIndexed();
  bucket.translate(0, 0.68, 0);
  parts.push(paint(bucket, '#7d5a3a'));
  for (const s of [-1, 1]) parts.push(box(2 * WELL.r + 0.45, 0.05, 0.5, 0, 1.6, s * 0.2, '#9c4a35', s * 0.55));
  return mergeGeometries(parts)!;
}

// ---- hens ----

// Every client shows the same flock: the wandering is a pure function of the
// room's shared clock (Characters.sharedTime) and the hen's index, and the
// rush to the grains follows the feeders' synced position / heading / state.

interface Hen {
  id: number;
  coop: number;
  /** Coop-space position and heading (0 = facing +z), following the plan below. */
  x: number;
  z: number;
  heading: number;
  phase: number;
  /** Where this hen likes to hang around (coop space). */
  homeX: number;
  homeZ: number;
  /** Which feeder this hen runs to, and its offset there (so they crowd, not stack). */
  pick: number;
  ox: number;
  oz: number;
}

/** Deterministic hash of two integers → [0, 1). */
function hash(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Wander plan: one move per segment, walking the first part, then pecking or looking around. */
const SEG = 5;
const WALK = 0.5;
/** Targets stay this close to the hen's home (moves ≤ 2 m in 2.5 s, slower than the 1.2 m/s catch-up). */
const ROAM = 0.7;
const HEN_X = YARD_X - 0.15;
const HEN_Z_MIN = -YARD_Z + 0.2;
const HEN_Z_MAX = YARD_Z - 0.15;
const clampX = (v: number) => Math.max(-HEN_X, Math.min(HEN_X, v));
const clampZ = (v: number) => Math.max(HEN_Z_MIN, Math.min(HEN_Z_MAX, v));

function planTarget(hen: Hen, n: number) {
  return {
    x: clampX(hen.homeX + (hash(hen.id * 4 + 1, n) * 2 - 1) * ROAM),
    z: clampZ(hen.homeZ + (hash(hen.id * 4 + 2, n) * 2 - 1) * ROAM),
  };
}

/** Where the plan puts `hen` at shared time `t`. */
function planAt(hen: Hen, t: number) {
  const s = t / SEG + hen.phase;
  const n = Math.floor(s);
  const f = s - n;
  const a = planTarget(hen, n - 1);
  const b = planTarget(hen, n);
  const k = Math.min(1, f / WALK);
  const w = k * k * (3 - 2 * k);
  return {
    x: a.x + (b.x - a.x) * w,
    z: a.z + (b.z - a.z) * w,
    heading: Math.atan2(b.x - a.x, b.z - a.z),
    pecking: f >= WALK && hash(hen.id * 4 + 3, n) < 0.7,
  };
}

/** The coops, the hens, and G at the fence. */
export class ChickenCoops {
  readonly group = new Group();
  private _feeding: AreaActivity;
  private _hens: Hen[] = [];
  private _henMeshes: InstancedMesh[] = [];
  private _last = performance.now();
  private _m = new Matrix4();
  private _q = new Quaternion();
  private _q2 = new Quaternion();
  private _p = new Vector3();
  private _v = new Vector3();
  private _one = new Vector3(1, 1, 1);
  private _xAxis = new Vector3(1, 0, 0);
  private _counters: number[] = [];
  /** Player out of HEN_RANGE: hens not simulated. */
  private _parked = false;

  constructor(private _characters: Characters) {
    this.group.name = 'chicken coops';
    const coops = new InstancedMesh(coopGeometry(), new MeshLambertMaterial({ vertexColors: true }), COOPS.length);
    COOPS.forEach((c, i) => coops.setMatrixAt(i, this._m.compose(new Vector3(c.x, c.y, c.z), this._q.setFromAxisAngle(UP, c.yaw), this._one)));
    coops.instanceMatrix.needsUpdate = true;
    const well = new Mesh(wellGeometry(), new MeshLambertMaterial({ vertexColors: true }));
    well.position.set(WELL.x, WELL.y, WELL.z);
    well.castShadow = true;
    well.receiveShadow = true;
    this.group.add(well);
    const henMaterial = new MeshLambertMaterial({ vertexColors: true });
    const looks = [henGeometry('#f4efe4', '#e2dccd'), henGeometry('#b8693a', '#8e4a26'), henGeometry('#3b3330', '#2a2421')];
    const total = COOPS.length * HENS_PER_COOP;
    this._henMeshes = looks.map((g) => new InstancedMesh(g, henMaterial, Math.ceil(total / looks.length)));
    this._counters = this._henMeshes.map(() => 0);
    for (const mesh of [coops, ...this._henMeshes]) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false; // instances span the map; only a few
      this.group.add(mesh);
    }
    const now = _characters.sharedTime();
    COOPS.forEach((_, coop) => {
      for (let k = 0; k < HENS_PER_COOP; k++) {
        const id = coop * HENS_PER_COOP + k;
        const a = (k / HENS_PER_COOP) * Math.PI * 2;
        const r = k % 2 ? 0.3 : 0.18;
        const hen: Hen = {
          id,
          coop,
          x: 0,
          z: 0,
          heading: 0,
          phase: hash(id, 7),
          homeX: -HEN_X + 2 * HEN_X * hash(id, 11),
          homeZ: HEN_Z_MIN + (HEN_Z_MAX - HEN_Z_MIN) * hash(id, 13),
          pick: k,
          ox: Math.cos(a) * r,
          oz: Math.sin(a) * r,
        };
        const plan = planAt(hen, now);
        hen.x = plan.x;
        hen.z = plan.z;
        hen.heading = plan.heading;
        this._hens.push(hen);
      }
    });

    this._feeding = new AreaActivity(_characters, {
      state: FEED_STATE,
      inArea: (p) => coopAround(p) !== null,
      // Turn toward the yard center so the grains land inside.
      faceTarget: (p) => {
        const c = coopAround(p);
        return c && { x: c.x, z: c.z };
      },
      tipId: 'coop',
      tip:
        '🐔 Chuồng gà\n' +
        'Chuồng gà nằm trên bãi cỏ phía tây. Đứng quanh hàng rào rồi bấm G để vãi thóc, gà sẽ chạy tới ăn.\n' +
        'Cần có Lúa (mua trong cửa hàng). Di chuyển để thôi cho ăn.',
    });
  }

  /** Where grains land (coop space), per coop, for everyone feeding there (reused arrays). */
  private _feed: Array<Array<{ x: number; z: number }>> = COOPS.map(() => []);
  private _feedPoints() {
    for (const list of this._feed) list.length = 0;
    const each = (obj: Object3D) => {
      if ((obj.userData as { a?: number }).a !== FEED_STATE) return;
      COOPS.forEach((c, i) => {
        if (Math.hypot(obj.position.x - c.x, obj.position.z - c.z) > NOTICE || Math.abs(obj.position.y - c.y) > 1.5) return;
        const { forward, along } = frame(c);
        // Grains land ~1.3 m in front of the feeder (countryProps._poseFeed).
        const fwd = this._v.set(0, 0, 1).applyQuaternion(obj.quaternion);
        this._p.copy(obj.position).addScaledVector(fwd, 1.3);
        this._p.x -= c.x;
        this._p.z -= c.z;
        this._p.y = 0;
        this._feed[i].push({ x: clampX(this._p.dot(along)), z: clampZ(this._p.dot(forward)) });
      });
    };
    this._characters.forEachCharacter((_, obj) => each(obj));
    for (const npc of npcFeeders) each(npc);
    return this._feed;
  }

  /** Per frame: the prompt and the hens. */
  update() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    // Shared clock: the same wander plan and peck rhythm on every client.
    const t = this._characters.sharedTime();
    this._feeding.update();

    // Far from every coop: hens just stay on the plan, nothing to draw or upload.
    const me = this._characters.local.position;
    if (!COOPS.some((c) => Math.hypot(me.x - c.x, me.z - c.z) < HEN_RANGE)) {
      this._parked = true;
      return;
    }
    if (this._parked) {
      // Back in range: start from where the plan is now (same as other screens).
      for (const hen of this._hens) {
        const plan = planAt(hen, t);
        hen.x = plan.x;
        hen.z = plan.z;
        hen.heading = plan.heading;
      }
      this._parked = false;
    }

    const feed = this._feedPoints();
    const counters = this._counters.fill(0);
    this._hens.forEach((hen, i) => {
      const points = feed[hen.coop];
      // Several feeders: the flock splits between them.
      const point = points.length ? points[hen.pick % points.length] : null;
      const plan = planAt(hen, t);
      // To the grains, else back on the plan (it walks slower than this, so
      // the hen catches up and then moves exactly as on the other screens).
      const tx = point ? clampX(point.x + hen.ox) : plan.x;
      const tz = point ? clampZ(point.z + hen.oz) : plan.z;
      const dx = tx - hen.x;
      const dz = tz - hen.z;
      const dist = Math.hypot(dx, dz);
      const walking = dist > 0.03;
      const want = walking ? Math.atan2(dx, dz) : point ? Math.atan2(point.x - hen.x, point.z - hen.z) : plan.heading;
      let turn = want - hen.heading;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      hen.heading += turn * Math.min(1, dt * 8);
      if (walking) {
        const step = Math.min(dist, 1.2 * dt);
        hen.x += (dx / dist) * step;
        hen.z += (dz / dist) * step;
      }
      // Pecking: fast at the grains, now and then when wandering.
      const pecks = !walking && (!!point || plan.pecking);
      const peckRate = point ? 9 : 5;
      const pitch = pecks ? 0.75 * Math.max(0, Math.sin(t * peckRate + hen.phase)) ** 2 : 0;
      const bob = walking ? Math.abs(Math.sin(t * 14 + hen.phase)) * 0.015 : 0;

      const c = COOPS[hen.coop];
      toWorld(c, hen.x, bob, hen.z, this._p);
      this._q.setFromAxisAngle(UP, c.yaw + hen.heading).multiply(this._q2.setFromAxisAngle(this._xAxis, pitch));
      const look = i % this._henMeshes.length;
      this._henMeshes[look].setMatrixAt(counters[look]++, this._m.compose(this._p, this._q, this._one));
    });
    this._henMeshes.forEach((mesh, k) => {
      mesh.count = counters[k];
      mesh.instanceMatrix.needsUpdate = true;
    });
  }
}
