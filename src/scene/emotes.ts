// Procedural emote clips for the kid (no extra animation assets): each clip
// starts from the first frame of the idle clip and overrides some bones by
// steering limb directions in model space (+y up, +z forward, x < 0 is the
// kid's right side).
//
// Skeleton map (from the bind pose of kid-bones.bin):
//   4 hips (root) → 5 spine → 7 chest → 11 neck base → 13 neck → 14 head
//   right arm: 12 clavicle → 10 shoulder → 9 elbow → 8 hand   (x < 0)
//   left arm:  21 clavicle → 19 shoulder → 20 elbow → 18 hand (x > 0)
//   right leg: 3 hip → 0 knee → 1 ankle → 2 toe               (x < 0)
//   left leg:  6 hip → 15 knee → 16 ankle → 17 toe            (x > 0)

import {
  AnimationClip,
  InterpolateLinear,
  KeyframeTrack,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type Bone,
  type SkinnedMesh,
} from 'three';

/**
 * Emote menu / keys, in slot order (key n = slot n). `state` is the network
 * animation state `a` (0 ground, 1 airborne, 2 the original bored clip;
 * 3+ the procedural clips below, in state order). `duration` 0 = until the
 * player moves.
 */
export const EMOTES = [
  { id: 'wave', label: 'Chào', key: '1', state: 3, duration: 3 },
  { id: 'clap', label: 'Vỗ tay', key: '2', state: 4, duration: 3 },
  { id: 'dance', label: 'Nhảy múa', key: '3', state: 5, duration: 0 },
  { id: 'bored', label: 'Chán', key: '4', state: 2, duration: 0 },
  { id: 'sit', label: 'Ngồi xếp bằng', key: '5', state: 6, duration: 0 },
  { id: 'fish', label: 'Câu cá', key: '6', state: 7, duration: 0 },
  { id: 'prone', label: 'Nằm sấp', key: '7', state: 8, duration: 0 },
  { id: 'sunbathe', label: 'Nằm hóng nắng', key: '8', state: 9, duration: 0 },
  { id: 'guitar', label: 'Đàn guitar', key: '9', state: 10, duration: 0 },
  { id: 'kite', label: 'Thả diều', key: '0', state: 11, duration: 0 },
  { id: 'icecream', label: 'Ăn kem', key: 'Q', state: 12, duration: 0 },
  { id: 'highfive', label: 'Đập tay', key: 'H', state: 13, duration: 5 },
  { id: 'dog', label: 'Dắt chó', key: 'C', state: 14, duration: 0 },
  { id: 'cat', label: 'Dắt mèo', key: 'M', state: 15, duration: 0 },
] as const;
export const FISH_STATE = 7;
export const GUITAR_STATE = 10;
export const KITE_STATE = 11;
export const ICECREAM_STATE = 12;
export const HIGHFIVE_STATE = 13;
/** Walking a pet (scene/pets.ts draws the dog / cat and the leash). */
export const DOG_STATE = 14;
export const CAT_STATE = 15;
/** Slot (1-based, menu / keys) of the high-five. */
export const HIGHFIVE_SLOT = EMOTES.findIndex((e) => e.id === 'highfive') + 1;

export const BONE = { rightHand: 8, leftHand: 18, chest: 7 } as const;
const RIGHT_ARM = [12, 10, 9, 8];
const LEFT_ARM = [21, 19, 20, 18];
const RIGHT_LEG = [3, 0, 1, 2];
const LEFT_LEG = [6, 15, 16, 17];
const SPINE = 5;
const HIPS = 4;
const NECK = 13;
/** Arms are aimed from the shoulder (skip the clavicle). */
const ARM = (chain: number[]) => chain.slice(1);

interface Rest {
  bones: Bone[];
  parent: number[];
  localPos: Vector3[];
  localQuat: Quaternion[];
  localScale: Vector3[];
  worldPos: Vector3[];
  worldQuat: Quaternion[];
}

/** Pose the skeleton on the idle clip's first frame and record transforms. */
function captureRest(skinned: SkinnedMesh, idle: AnimationClip): Rest {
  const bones = skinned.skeleton.bones;
  const saved = bones.map((b) => [b.position.clone(), b.quaternion.clone(), b.scale.clone()] as const);
  for (const track of idle.tracks) {
    const [name, prop] = track.name.split('.');
    const bone = bones[Number(name.replace('bone_', ''))];
    if (!bone) continue;
    const v = track.values;
    if (prop === 'quaternion') bone.quaternion.set(v[0], v[1], v[2], v[3]).normalize();
    else if (prop === 'position') bone.position.set(v[0], v[1], v[2]);
    else if (prop === 'scale') bone.scale.set(v[0], v[1], v[2]);
  }
  skinned.updateMatrixWorld(true);
  const rest: Rest = {
    bones,
    parent: bones.map((b) => (b.parent && (b.parent as Bone).isBone ? bones.indexOf(b.parent as Bone) : -1)),
    localPos: bones.map((b) => b.position.clone()),
    localQuat: bones.map((b) => b.quaternion.clone()),
    localScale: bones.map((b) => b.scale.clone()),
    worldPos: bones.map((b) => b.getWorldPosition(new Vector3())),
    worldQuat: bones.map((b) => b.getWorldQuaternion(new Quaternion())),
  };
  // Restore whatever pose the shared skeleton had.
  bones.forEach((b, i) => {
    b.position.copy(saved[i][0]);
    b.quaternion.copy(saved[i][1]);
    b.scale.copy(saved[i][2]);
  });
  skinned.updateMatrixWorld(true);
  return rest;
}

type Frame = { quats: Map<number, Quaternion>; hipsOffsetY?: number; hipsOffset?: Vector3 };

/**
 * Aim a bone chain: segment k (chain[k] → chain[k+1]) is swung to point along
 * dirs[k] (model space). `parentTurn` is a model-space rotation already applied
 * above the chain (e.g. a spine sway), so the chain follows it first.
 */
function aimChain(f: Frame, rest: Rest, chain: number[], dirs: Vector3[], parentTurn = new Quaternion()) {
  let accum = parentTurn.clone();
  let parentWorld = accum.clone().multiply(rest.worldQuat[rest.parent[chain[0]]]);
  dirs.forEach((dir, k) => {
    const b = chain[k];
    const next = chain[k + 1];
    const worldFollow = accum.clone().multiply(rest.worldQuat[b]);
    const restDir = new Vector3().subVectors(rest.worldPos[next], rest.worldPos[b]).normalize().applyQuaternion(accum);
    const swing = new Quaternion().setFromUnitVectors(restDir, dir.clone().normalize());
    const world = swing.clone().multiply(worldFollow);
    f.quats.set(b, parentWorld.clone().invert().multiply(world));
    accum = swing.multiply(accum);
    parentWorld = world;
  });
}

/**
 * Rotate one bone by a model-space rotation (children follow). `parentTurn`
 * is the rotation already applied above it (e.g. the hips when lying down).
 * Works for the root bone too (its parent is the mesh: identity).
 */
function turnBone(f: Frame, rest: Rest, bone: number, turn: Quaternion, parentTurn = new Quaternion()) {
  const parentRest = rest.parent[bone] >= 0 ? rest.worldQuat[rest.parent[bone]] : new Quaternion();
  const parentWorld = parentTurn.clone().multiply(parentRest);
  const world = turn.clone().multiply(parentTurn).multiply(rest.worldQuat[bone]);
  f.quats.set(bone, parentWorld.invert().multiply(world));
}

/** Build a looping clip: idle pose for every bone, overridden per frame. */
function buildClip(name: string, rest: Rest, period: number, samples: number, frameAt: (phase: number) => Frame) {
  const times: number[] = [];
  const frames: Frame[] = [];
  for (let i = 0; i <= samples; i++) {
    times.push((i / samples) * period);
    frames.push(frameAt(i / samples));
  }
  const tracks: KeyframeTrack[] = [];
  rest.bones.forEach((_, b) => {
    const qValues: number[] = [];
    let prev: Quaternion | null = null;
    for (const f of frames) {
      const q = (f.quats.get(b) ?? rest.localQuat[b]).clone();
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // keep the shortest path
      qValues.push(q.x, q.y, q.z, q.w);
      prev = q;
    }
    tracks.push(new QuaternionKeyframeTrack(`bone_${b}.quaternion`, times, qValues, InterpolateLinear));
    const pValues: number[] = [];
    for (const f of frames) {
      const p = rest.localPos[b];
      const o = b === HIPS ? f.hipsOffset ?? new Vector3(0, f.hipsOffsetY ?? 0, 0) : null;
      pValues.push(p.x + (o?.x ?? 0), p.y + (o?.y ?? 0), p.z + (o?.z ?? 0));
    }
    tracks.push(new VectorKeyframeTrack(`bone_${b}.position`, times, pValues, InterpolateLinear));
    const s = rest.localScale[b];
    tracks.push(new VectorKeyframeTrack(`bone_${b}.scale`, [0, period], [s.x, s.y, s.z, s.x, s.y, s.z], InterpolateLinear));
  });
  return new AnimationClip(name, period, tracks);
}

/**
 * 'While walking' variant of an emote: the frame function drives the bones it
 * overrides (arms, spine, head); everything else — hips, legs and any free arm
 * — comes from the run clip, so the kid keeps walking / running naturally.
 * The period is a whole number of run cycles so the legs loop seamlessly.
 */
function buildMovingClip(name: string, rest: Rest, run: AnimationClip, loops: number, frameAt: (phase: number) => Frame) {
  const runPeriod = run.duration;
  const period = runPeriod * loops;
  const samples = loops * 12;
  const sample = new Map<string, { evaluate(t: number): ArrayLike<number> }>();
  for (const track of run.tracks) sample.set(track.name, track.createInterpolant() as any);
  const read = (bone: number, prop: string, t: number, size: number): number[] => {
    const it = sample.get(`bone_${bone}.${prop}`);
    if (!it) return prop === 'quaternion' ? rest.localQuat[bone].toArray() : (prop === 'position' ? rest.localPos[bone] : rest.localScale[bone]).toArray();
    return Array.from(it.evaluate(t % runPeriod)).slice(0, size);
  };
  const times: number[] = [];
  const frames: Frame[] = [];
  for (let i = 0; i <= samples; i++) {
    times.push((i / samples) * period);
    frames.push(frameAt(i / samples));
  }
  const tracks: KeyframeTrack[] = [];
  rest.bones.forEach((_, b) => {
    const q: number[] = [];
    const p: number[] = [];
    const s: number[] = [];
    let prev: Quaternion | null = null;
    frames.forEach((f, k) => {
      const t = times[k];
      const own = f.quats.get(b);
      const quat = own ? own.clone() : new Quaternion().fromArray(read(b, 'quaternion', t, 4));
      if (prev && prev.dot(quat) < 0) quat.set(-quat.x, -quat.y, -quat.z, -quat.w);
      q.push(quat.x, quat.y, quat.z, quat.w);
      prev = quat;
      p.push(...read(b, 'position', t, 3));
      s.push(...read(b, 'scale', t, 3));
    });
    tracks.push(new QuaternionKeyframeTrack(`bone_${b}.quaternion`, times, q, InterpolateLinear));
    tracks.push(new VectorKeyframeTrack(`bone_${b}.position`, times, p, InterpolateLinear));
    tracks.push(new VectorKeyframeTrack(`bone_${b}.scale`, times, s, InterpolateLinear));
  });
  return new AnimationClip(name, period, tracks);
}

/**
 * NPC-only poses (scene/npcs.ts), never sent over the network: sitting side
 * by side on the sand; one holds the partner (on its right) by the waist, the
 * other just sits, hands on the knees.
 */
export const NPC_STATES = { sitHoldWaist: 20, sitRelaxed: 21 } as const; // local only: beyond the 4-bit network range

/** Emotes that keep playing while the player walks (upper body only). */
export const MOBILE_EMOTE_STATES = [10, 11, 12, 14, 15]; // guitar, kite, ice cream, dog, cat

const TAU = Math.PI * 2;
const v = (x: number, y: number, z: number) => new Vector3(x, y, z);
const lerpDir = (a: Vector3, b: Vector3, t: number) => a.clone().lerp(b, t).normalize();
const aroundX = (angle: number) => new Quaternion().setFromAxisAngle(v(1, 0, 0), angle);
const aroundZ = (angle: number) => new Quaternion().setFromAxisAngle(v(0, 0, 1), angle);
const aroundY = (angle: number) => new Quaternion().setFromAxisAngle(v(0, 1, 0), angle);
const smooth = (t: number) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// Fishing: shared with the rod/line/fish props (scene/fishing.ts)
// ---------------------------------------------------------------------------

export const FISH_PERIOD = 2.8;

/** 0 = waiting with the line out, 1 = rod yanked up (fish out of the water). */
export function fishPull(phase: number): number {
  if (phase < 0.55) return 0;
  if (phase < 0.66) return smooth((phase - 0.55) / 0.11);
  if (phase < 0.8) return 1;
  return 1 - smooth((phase - 0.8) / 0.2);
}

/** Rod direction in model space for a clip phase. */
export function fishRodDir(phase: number): Vector3 {
  const pull = fishPull(phase);
  const nibble = phase < 0.55 ? 0.04 * Math.sin(phase * TAU * 6) : 0;
  return lerpDir(v(0.05, 0.42 + nibble, 0.9), v(-0.02, 0.97, -0.2), pull);
}

/** Ice cream lick: 0 = cone in front of the chest, 1 = at the mouth. */
export const ICECREAM_PERIOD = 3;
export function iceCreamLick(phase: number): number {
  if (phase < 0.45) return 0;
  if (phase < 0.6) return smooth((phase - 0.45) / 0.15);
  if (phase < 0.8) return 1;
  return 1 - smooth((phase - 0.8) / 0.2);
}

/** Create the procedural emote clips, in state order (3 … 13). */
export interface EmoteClips {
  /** One clip per emote state 3, 4, … (clip index = state + 1). */
  clips: AnimationClip[];
  /** 'While walking' variants for MOBILE_EMOTE_STATES. */
  moving: Array<{ state: number; clip: AnimationClip }>;
  /** NPC-only clips (NPC_STATES). */
  npc: Array<{ state: number; clip: AnimationClip }>;
}

export function createEmoteClips(skinned: SkinnedMesh, idle: AnimationClip, run: AnimationClip): EmoteClips {
  const rest = captureRest(skinned, idle);

  // 3 Wave: right arm raised, forearm swinging side to side.
  const wave = buildClip('emote-wave', rest, 0.9, 16, (t) => {
    const f: Frame = { quats: new Map() };
    const swing = Math.sin(t * TAU);
    aimChain(f, rest, ARM(RIGHT_ARM), [v(-0.55, 0.8, 0.15), v(-0.15 + 0.45 * swing, 1, 0.2)]);
    return f;
  });

  // 4 Clap: both arms forward, forearms opening and meeting in front.
  const clap = buildClip('emote-clap', rest, 0.45, 12, (t) => {
    const f: Frame = { quats: new Map() };
    const open = (1 - Math.cos(t * TAU)) / 2; // 0 = hands together
    for (const [chain, side] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      aimChain(f, rest, ARM(chain), [v(side * 0.35, -0.5, 0.8), v(-side * (0.75 - 0.6 * open), 0.25, 0.75)]);
    }
    return f;
  });

  // 5 Dance: arms up, waving out of phase, body swaying and bobbing.
  const dance = buildClip('emote-dance', rest, 0.8, 16, (t) => {
    const f: Frame = { quats: new Map(), hipsOffsetY: -0.035 * Math.abs(Math.sin(t * TAU)) };
    const sway = aroundZ(0.14 * Math.sin(t * TAU));
    turnBone(f, rest, SPINE, sway);
    for (const [chain, side] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      const phase = Math.sin(t * TAU + (side > 0 ? Math.PI : 0));
      aimChain(f, rest, ARM(chain), [v(side * 0.6, 0.75, 0.1), v(side * (0.2 + 0.4 * phase), 0.9, 0.25)], sway);
    }
    return f;
  });

  // 6 Sit cross-legged: hips down, thighs open, shins crossed, hands on the
  // knees, slow breathing lean.
  const sit = buildClip('emote-sit', rest, 3.2, 16, (t) => {
    const f: Frame = { quats: new Map(), hipsOffsetY: -0.56 };
    // Right shin crosses in front of the left one (slightly lower / further forward).
    aimChain(f, rest, RIGHT_LEG, [v(-0.74, -0.1, 0.66), v(0.93, -0.04, 0.37), v(0.55, -0.45, 0.7)]);
    aimChain(f, rest, LEFT_LEG, [v(0.74, -0.06, 0.66), v(-0.95, 0.08, 0.3), v(-0.55, -0.45, 0.7)]);
    const lean = aroundX(0.16 + 0.03 * Math.sin(t * TAU));
    turnBone(f, rest, SPINE, lean);
    for (const [chain, side] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      aimChain(f, rest, ARM(chain), [v(side * 0.32, -0.72, 0.6), v(side * 0.3, -0.55, 0.78)], lean);
    }
    return f;
  });

  // 7 Fishing: both hands on the rod, waiting (nibbles), then a yank up and a
  // slow lowering. The rod itself is a prop that follows the right hand.
  const fish = buildClip('emote-fish', rest, FISH_PERIOD, 28, (t) => {
    const f: Frame = { quats: new Map() };
    const pull = fishPull(t);
    const lean = aroundX(0.08 - 0.22 * pull);
    turnBone(f, rest, SPINE, lean);
    const nibble = t < 0.55 ? 0.05 * Math.sin(t * TAU * 6) : 0;
    aimChain(f, rest, ARM(RIGHT_ARM), [
      lerpDir(v(-0.25, -0.75, 0.6), v(-0.3, 0.15, 0.95), pull),
      lerpDir(v(0.25, 0.1 + nibble, 0.95), v(0.2, 0.85, 0.5), pull),
    ], lean);
    aimChain(f, rest, ARM(LEFT_ARM), [
      lerpDir(v(0.2, -0.7, 0.68), v(0.15, 0.05, 0.98), pull),
      lerpDir(v(-0.55, 0.05 + nibble, 0.83), v(-0.45, 0.75, 0.5), pull),
    ], lean);
    return f;
  });

  // 8 Lying on the belly: body pitched flat (face down), chest propped on the
  // elbows, chin in the hands, head up, lower legs kicking in the air.
  const prone = buildClip('emote-prone', rest, 1.6, 16, (t) => {
    const f: Frame = { quats: new Map(), hipsOffset: v(0, -0.59, 0.15) };
    const body = aroundX(Math.PI / 2); // +y (head) → +z, face → down
    turnBone(f, rest, HIPS, body);
    const chest = aroundX(-0.2 - 0.02 * Math.sin(t * TAU)); // arch up a little
    turnBone(f, rest, SPINE, chest, body);
    const torso = chest.clone().multiply(body);
    turnBone(f, rest, NECK, aroundX(-0.75), torso); // look ahead, not at the ground
    for (const [chain, side] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      aimChain(f, rest, ARM(chain), [v(side * 0.35, -0.75, 0.55), v(-side * 0.5, 0.45, 0.74)], torso);
    }
    for (const [chain, side, offset] of [[RIGHT_LEG, -1, 0], [LEFT_LEG, 1, Math.PI]] as const) {
      const a = 0.55 + 0.45 * Math.sin(t * TAU + offset); // lower leg angle up from the ground
      aimChain(f, rest, chain, [v(side * 0.1, -0.06, -1), v(side * 0.04, Math.sin(a), -Math.cos(a)), v(0, -0.25, -1)], body);
    }
    return f;
  });

  // 9 Sunbathing: on the back, upper body raised a bit, hands behind the head,
  // looking ahead (at the sea), one knee up, the other foot tapping.
  const sunbathe = buildClip('emote-sunbathe', rest, 4, 24, (t) => {
    const f: Frame = { quats: new Map(), hipsOffset: v(0, -0.6, 0) };
    const body = aroundX(-Math.PI / 2); // +y (head) → -z, face → up
    turnBone(f, rest, HIPS, body);
    const lift = aroundX(0.5 + 0.025 * Math.sin(t * TAU)); // breathing
    turnBone(f, rest, SPINE, lift, body);
    const torso = lift.clone().multiply(body);
    turnBone(f, rest, NECK, aroundX(0.35), torso);
    for (const [chain, side] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      aimChain(f, rest, ARM(chain), [v(side * 0.85, 0.35, -0.4), v(-side * 0.8, 0.3, -0.5)], torso);
    }
    aimChain(f, rest, RIGHT_LEG, [v(-0.12, 0.8, 0.58), v(-0.04, -0.78, 0.62), v(0, -0.2, 0.98)], body); // knee up
    const tap = 0.12 * Math.max(0, Math.sin(t * TAU * 4));
    aimChain(f, rest, LEFT_LEG, [v(0.1, -0.02, 1), v(0.08, 0.02, 1), v(0.05, 0.85 - tap, 0.5 + tap)], body);
    return f;
  });

  // 10 Guitar: left hand forward-left on the neck, right forearm strumming
  // over the body, gentle sway and head nod. The guitar is a prop
  // (scene/guitar.ts) placed from the chest and the left hand.
  const guitarFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const sway = aroundZ(0.05 * Math.sin(t * TAU)).multiply(aroundX(0.06));
    turnBone(f, rest, SPINE, sway);
    turnBone(f, rest, NECK, aroundX(0.12 * Math.abs(Math.sin(t * TAU * 2))), sway);
    const strum = Math.sin(t * TAU * 4); // 4 down/up strokes per loop
    aimChain(f, rest, ARM(RIGHT_ARM), [v(-0.32, -0.78, 0.5), v(0.78, -0.12 + 0.28 * strum, 0.58)], sway);
    const slide = 0.05 * Math.sin(t * TAU);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.38, -0.6, 0.7), v(0.2 + slide, 0.5, 0.84)], sway);
    return f;
  };
  const guitar = buildClip('emote-guitar', rest, 2, 32, guitarFrame);

  // 11 Kite: right hand up and forward holding the string, small tugs,
  // looking up at the kite (scene/props.ts flies it).
  const kiteFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const tug = Math.max(0, Math.sin(t * TAU * 2)) ** 3;
    turnBone(f, rest, NECK, aroundX(-0.4));
    aimChain(f, rest, ARM(RIGHT_ARM), [v(-0.3, 0.4 + 0.1 * tug, 0.86), v(-0.1, 0.78 - 0.25 * tug, 0.6)]);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.25, -0.75, 0.6), v(-0.15, -0.2, 0.97)]);
    return f;
  };
  const kite = buildClip('emote-kite', rest, 2.4, 24, kiteFrame);

  // 12 Ice cream: cone in the right hand in front of the chest, brought to
  // the mouth for a lick now and then; the head dips toward it.
  const iceCreamFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const lick = iceCreamLick(t);
    turnBone(f, rest, NECK, aroundX(0.05 + 0.2 * lick));
    aimChain(f, rest, ARM(RIGHT_ARM), [
      lerpDir(v(-0.22, -0.8, 0.55), v(-0.12, -0.62, 0.78), lick),
      lerpDir(v(0.3, 0.55, 0.78), v(0.45, 0.85, 0.28), lick),
    ]);
    return f;
  };
  const iceCream = buildClip('emote-icecream', rest, ICECREAM_PERIOD, 30, iceCreamFrame);

  // 13 High five: right hand raised forward, palm out, a small bounce.
  const highFive = buildClip('emote-highfive', rest, 1, 12, (t) => {
    const f: Frame = { quats: new Map() };
    const bounce = 0.06 * Math.sin(t * TAU);
    aimChain(f, rest, ARM(RIGHT_ARM), [v(-0.22, 0.5 + bounce, 0.84), v(-0.05, 0.96, 0.28 + bounce)]);
    return f;
  });

  // 14 / 15 Walking a pet: right hand low and forward holding the leash,
  // a small tug now and then.
  const leashFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const tug = Math.max(0, Math.sin(t * TAU)) ** 4;
    aimChain(f, rest, ARM(RIGHT_ARM), [v(-0.32, -0.8, 0.5 + 0.1 * tug), v(-0.25, -0.3 + 0.15 * tug, 0.92)]);
    turnBone(f, rest, NECK, aroundX(0.18).multiply(aroundY(-0.25))); // glance down at the pet
    return f;
  };
  const walkDog = buildClip('emote-walk-dog', rest, 2.5, 20, leashFrame);
  const walkCat = buildClip('emote-walk-cat', rest, 2.5, 20, leashFrame);

  // While walking: upper body from the emote, legs from the run cycle
  // (kite: the free left arm swings too; ice cream: same).
  const moving = [
    { state: 10, clip: buildMovingClip('emote-guitar-walk', rest, run, 3, guitarFrame) },
    { state: 11, clip: buildMovingClip('emote-kite-walk', rest, run, 3, (t) => {
      const f = kiteFrame(t);
      f.quats.delete(LEFT_ARM[1]); // let the left arm swing with the walk
      f.quats.delete(LEFT_ARM[2]);
      return f;
    }) },
    { state: 12, clip: buildMovingClip('emote-icecream-walk', rest, run, 4, iceCreamFrame) },
    { state: DOG_STATE, clip: buildMovingClip('emote-walk-dog-walk', rest, run, 3, leashFrame) },
    { state: CAT_STATE, clip: buildMovingClip('emote-walk-cat-walk', rest, run, 3, leashFrame) },
  ];

  // NPC: sitting on the sand, knees up.
  const sitLegs = (f: Frame) => {
    for (const [chain, s] of [[RIGHT_LEG, -1], [LEFT_LEG, 1]] as const) {
      aimChain(f, rest, chain, [v(s * 0.14, 0.42, 0.9), v(s * 0.04, -0.62, 0.78), v(0, -0.25, 0.97)]);
    }
  };
  // Holding the partner (on the kid's right, -x) by the waist: the right arm
  // goes down behind her back and wraps around her waist; the left hand is
  // propped on the sand; leaning a little toward her; breathing.
  const sitHoldWaist = (t: number): Frame => {
    const f: Frame = { quats: new Map(), hipsOffset: v(0, -0.6, 0) };
    const lean = aroundZ(0.07 + 0.012 * Math.sin(t * TAU)).multiply(aroundX(0.05));
    turnBone(f, rest, SPINE, lean);
    turnBone(f, rest, NECK, aroundZ(0.1));
    aimChain(f, rest, ARM(RIGHT_ARM), [v(-0.45, -0.7, -0.55), v(-0.92, -0.1, 0.35)], lean);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.4, -0.75, -0.45), v(0.12, -0.92, -0.3)], lean);
    sitLegs(f);
    return f;
  };
  // Just sitting: upright, hands resting on the knees, breathing.
  const sitRelaxed = (t: number): Frame => {
    const f: Frame = { quats: new Map(), hipsOffset: v(0, -0.6, 0) };
    const breathe = aroundX(0.04 + 0.015 * Math.sin(t * TAU));
    turnBone(f, rest, SPINE, breathe);
    for (const [chain, s] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      aimChain(f, rest, ARM(chain), [v(s * 0.15, -0.6, 0.78), v(s * 0.05, -0.45, 0.89)], breathe);
    }
    sitLegs(f);
    return f;
  };
  const npc = [
    { state: NPC_STATES.sitHoldWaist, clip: buildClip('npc-sit-hold-waist', rest, 4, 16, sitHoldWaist) },
    { state: NPC_STATES.sitRelaxed, clip: buildClip('npc-sit-relaxed', rest, 4, 16, sitRelaxed) },
  ];

  return { clips: [wave, clap, dance, sit, fish, prone, sunbathe, guitar, kite, iceCream, highFive, walkDog, walkCat], moving, npc };
}
