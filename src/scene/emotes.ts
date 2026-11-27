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
  // Walking a dog: one state per dog of the shop (scene/pets.ts DOGS).
  { id: 'dog', label: 'Dắt chó con', key: 'C', state: 14, duration: 0 },
  { id: 'dog2', label: 'Dắt chó beagle', key: 'M', state: 15, duration: 0 },
  { id: 'dog3', label: 'Dắt chó husky', key: '', state: 65, duration: 0 },
  { id: 'dog4', label: 'Dắt chó đốm', key: '', state: 66, duration: 0 },
  // Countryside (states 16+ need the 7-bit state field, see multiplayer/codec.ts).
  { id: 'stretch', label: 'Vươn vai', key: 'V', state: 16, duration: 5 },
  { id: 'skygaze', label: 'Ngắm trời', key: 'T', state: 17, duration: 0 },
  { id: 'clouds', label: 'Nằm ngắm mây', key: 'N', state: 18, duration: 0 },
  { id: 'flute', label: 'Thổi sáo', key: 'O', state: 19, duration: 0 },
  { id: 'fan', label: 'Phe phẩy quạt', key: 'Y', state: 20, duration: 0 },
  { id: 'whistle', label: 'Huýt sáo', key: 'U', state: 21, duration: 3.6 },
  { id: 'water', label: 'Tưới cây', key: 'R', state: 22, duration: 0 },
  { id: 'pick', label: 'Hái hoa', key: 'P', state: 23, duration: 0 },
  { id: 'feed', label: 'Cho gà ăn', key: 'G', state: 24, duration: 0 },
  { id: 'sweep', label: 'Quét sân', key: 'Z', state: 25, duration: 0 },
  { id: 'carry', label: 'Gánh nước', key: 'K', state: 26, duration: 0 },
  { id: 'read', label: 'Đọc sách', key: 'B', state: 27, duration: 0 },
  { id: 'benchSit', label: 'Ngồi ghế đá', key: 'F', state: 28, duration: 0 },
  { id: 'benchLie', label: 'Nằm ghế đá', key: 'L', state: 29, duration: 0 },
  { id: 'jumprope', label: 'Nhảy dây', key: 'J', state: 30, duration: 0 },
  { id: 'shuttle', label: 'Tâng cầu', key: 'X', state: 31, duration: 0 },
  { id: 'butterfly', label: 'Bắt bướm', key: 'I', state: 43, duration: 0 },
  // Together (scene/together.ts): aimed at the nearest player, who must accept.
  { id: 'giftFlower', label: 'Tặng hoa', key: '', state: 32, duration: 0 },
  { id: 'treatIceCream', label: 'Mời ăn kem', key: '', state: 33, duration: 0 },
  { id: 'holdHands', label: 'Nắm tay đi dạo', key: '', state: 36, duration: 0 },
  { id: 'pairDance', label: 'Nhảy đôi', key: '', state: 38, duration: 0 },
] as const;
/** Play-together emotes (aimed at the nearest player, scene/together.ts): shown with ♥ instead of a key. */
export const TOGETHER_EMOTE_IDS: ReadonlySet<string> = new Set(['giftFlower', 'treatIceCream', 'holdHands', 'pairDance']);
/** Key label of an emote in menus: its key, ♥ for play-together, · for menu-only ones. */
export const emoteKeyHtml = (e: { id: string; key: string }) => (e.key ? `<kbd>${e.key}</kbd>` : TOGETHER_EMOTE_IDS.has(e.id) ? '<kbd class="together">♥</kbd>' : '<kbd>·</kbd>');
/** Highest network animation state (server/realm.mjs MAX_ANIM_STATE mirrors it). */
export const MAX_NET_STATE = 66;
export const JUMPROPE_STATE = 30;
export const SHUTTLE_STATE = 31;
/** Holding out a flower / an ice cream to someone (waiting for an answer). */
export const OFFER_FLOWER_STATE = 32;
export const OFFER_ICECREAM_STATE = 33;
/** Got a flower / an ice cream from someone (not in the menu). */
export const HOLD_FLOWER_STATE = 34;
export const TREAT_ICECREAM_STATE = 35;
/** Walking hand in hand: the leader holds with the right hand (partner on its
 *  right), the follower with the left hand. */
export const HAND_RIGHT_STATE = 36;
export const HAND_LEFT_STATE = 37;
/** Dancing face to face, hands joined (clip phase on the shared clock). */
export const PAIR_DANCE_STATE = 38;
/**
 * Local-only poses (never sent): two players sitting side by side put an arm
 * around each other (scene/together.ts sets userData.pose). R = the partner
 * is on the right.
 */
export const PAIR_POSES = { sitArmR: 122, sitArmL: 123, benchArmR: 124, benchArmL: 125 } as const;
export const STRETCH_STATE = 16;
export const SKYGAZE_STATE = 17;
export const CLOUDS_STATE = 18;
export const FLUTE_STATE = 19;
export const FAN_STATE = 20;
export const WHISTLE_STATE = 21;
export const WATER_STATE = 22;
export const PICK_STATE = 23;
export const FEED_STATE = 24;
export const SWEEP_STATE = 25;
export const CARRY_STATE = 26;
export const READ_STATE = 27;
/** Sitting / lying on a stone bench (scene/benches.ts places the character). */
export const BENCH_SIT_STATE = 28;
export const BENCH_LIE_STATE = 29;
export const FISH_STATE = 7;
/**
 * Fishing mini-game stages on the pier (scene/fishingGame.ts), sent like any
 * state so others see the bite, the fight, the catch and a snapped line. They
 * play the fishing clip (copies, see createEmoteClips); the props follow the
 * stage. The relay asks for the fishing rod for all of them.
 */
export const FISH_BITE_STATE = 39;
export const FISH_FIGHT_STATE = 40;
export const FISH_LANDED_STATE = 41;
export const FISH_SNAP_STATE = 42;
export const FISHING_STATES: readonly number[] = [FISH_STATE, FISH_BITE_STATE, FISH_FIGHT_STATE, FISH_LANDED_STATE, FISH_SNAP_STATE];
/** Catching butterflies with a net, standing or running after them (scene/butterflies.ts). */
export const NET_STATE = 43;
/**
 * Holding up a caught fish (scene/fishingGame.ts), walking around to show it
 * off: state HOLD_FISH_STATE + the species index (fishingGame.ts FISH_SPECIES),
 * so everyone sees which fish. Ends with any other emote (6 casts again).
 */
export const HOLD_FISH_STATE = 44;
/** = fishingGame.ts SPECIES.length (21): states 44 … 64. */
export const HOLD_FISH_COUNT = 21;
export const isHoldFish = (a: number) => a >= HOLD_FISH_STATE && a < HOLD_FISH_STATE + HOLD_FISH_COUNT;
/** While holding a catch: the rod in the right hand, upright and leaning back over the shoulder (model space). */
export const HOLD_ROD_DIR = new Vector3(-0.12, 0.92, -0.37).normalize();
export const GUITAR_STATE = 10;
export const KITE_STATE = 11;
export const ICECREAM_STATE = 12;
export const HIGHFIVE_STATE = 13;
/** Walking a pet (scene/pets.ts draws the dog and the leash). */
export const DOG_STATE = 14;
/** Walking one of the shop's dogs (states 14, 15, 65, 66; scene/pets.ts DOGS, same order). */
export const DOG_STATES = [DOG_STATE, 15, 65, 66] as const;
/** Slot (1-based, menu / keys) of the high-five. */
export const HIGHFIVE_SLOT = EMOTES.findIndex((e) => e.id === 'highfive') + 1;

export const BONE = { rightHand: 8, leftHand: 18, chest: 7, head: 14 } as const;
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
export const NPC_STATES = { sitHoldWaist: 120, sitRelaxed: 121 } as const; // local only: above MAX_NET_STATE

/** Emotes that keep playing while the player walks (upper body only):
 *  guitar, kite, ice cream, the dogs, flute, fan, carrying water, reading. */
export const MOBILE_EMOTE_STATES = [
  10, 11, 12, ...DOG_STATES, FLUTE_STATE, FAN_STATE, CARRY_STATE, READ_STATE,
  HOLD_FLOWER_STATE, TREAT_ICECREAM_STATE, HAND_RIGHT_STATE, HAND_LEFT_STATE,
  // Fishing (and its mini-game stages): walk along the pier with the rod out.
  ...FISHING_STATES,
  // Running after butterflies with the net.
  NET_STATE,
  // Walking around with a caught fish.
  ...Array.from({ length: HOLD_FISH_COUNT }, (_, k) => HOLD_FISH_STATE + k),
];
/** States whose clip phase follows the shared (server) clock on every client. */
export const SYNCED_STATES = [PAIR_DANCE_STATE];

/** Emotes that play once from the start when triggered (period in seconds):
 *  the engine aligns the local clip phase to 0 (characters.ts emotePhases). */
export const STRETCH_PERIOD = 5;
export const WHISTLE_PERIOD = 1.2;
export const PHASED_EMOTES: Record<number, number> = { [STRETCH_STATE]: STRETCH_PERIOD };

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

// ---------------------------------------------------------------------------
// Countryside emotes: phase functions shared with the props (countryProps.ts).
// Positions are in model space (+y up, +z forward, x < 0 = the kid's right).
// ---------------------------------------------------------------------------

/** Mouth, in front of the face (hands / flute / whistle aim here). */
export const MOUTH = v(0, 1.29, 0.17);

/** Watering: the can sweeps right ↔ left (-1 … 1). */
export const WATER_PERIOD = 4;
export const waterSweep = (phase: number) => Math.sin(phase * TAU);

/** Picking a flower: crouch down, pick, stand up and smell it, lower the hand. */
export const PICK_PERIOD = 4.5;
export function pickPhase(phase: number) {
  const crouch = phase < 0.22 ? smooth(phase / 0.22) : phase < 0.34 ? 1 : phase < 0.52 ? 1 - smooth((phase - 0.34) / 0.18) : 0;
  const nose = phase < 0.4 ? 0 : phase < 0.56 ? smooth((phase - 0.4) / 0.16) : phase < 0.8 ? 1 : 1 - smooth((phase - 0.8) / 0.2);
  return { crouch, nose, holding: phase > 0.3 && phase < 0.96 };
}

/** Feeding chickens: dip into the basket, throw a handful forward, back. */
export const FEED_PERIOD = 1.8;
/** Grains leave the hand at this phase and land FEED_FLIGHT later. */
export const FEED_RELEASE = 0.45;
export const FEED_FLIGHT = 0.4;
export function feedSwing(phase: number): number {
  if (phase < 0.3) return 0;
  if (phase < 0.48) return smooth((phase - 0.3) / 0.18);
  if (phase < 0.6) return 1;
  return 1 - smooth((phase - 0.6) / 0.4);
}

/** Sweeping: the broom head swings side to side in front of the feet. */
export const SWEEP_PERIOD = 1.5;
export const broomTop = () => v(-0.08, 0.98, 0.22);
export const broomBottom = (phase: number) => v(-0.1 + 0.3 * Math.sin(phase * TAU), 0, 0.7);
/** Where the left hand holds the handle (fraction from the top). */
export const BROOM_LEFT_AT = 0.25;

/** Reading: a page is turned (right → left) near the end of every loop. */
export const READ_PERIOD = 6;
export function readTurn(phase: number): number {
  if (phase < 0.8) return 0;
  if (phase < 0.92) return smooth((phase - 0.8) / 0.12);
  return 1;
}

/** Fan: flapping angle (radians) in front of the face. */
export const FAN_PERIOD = 0.7;
export const fanFlap = (phase: number) => 0.55 * Math.sin(phase * TAU);

/**
 * Jump rope: the rope turns forward (under the feet at phase 0, then behind,
 * over the head, in front). Its loop direction from the hands, model space:
 * down·cos φ + back·sin φ.
 */
export const JUMPROPE_PERIOD = 0.66;
export const ropeDir = (phase: number, out = new Vector3()) => out.set(0, -Math.cos(phase * TAU), -Math.sin(phase * TAU));
/** Hop height: in the air while the rope passes under the feet. */
export const ropeHop = (phase: number) => 0.09 * Math.max(0, Math.cos(phase * TAU)) ** 1.5;

/** Shuttlecock (đá cầu): kicked up with the inside of the right foot at phase 0. */
export const SHUTTLE_PERIOD = 1.1;

/**
 * Butterfly net (scene/butterflies.ts): the net sweeps from the right to the
 * left in front of the kid and back, NET_PERIOD s a round trip.
 */
export const NET_PERIOD = 1.6;
/** -1 = net out to the right, 1 = out to the left. */
export function netSwing(phase: number): number {
  return Math.sin(phase * TAU);
}
/** Net handle direction in model space (the kid faces +z, its right is -x). */
/** Loop length of the running-with-the-net clip (set when the clips are built). */
export let NET_WALK_PERIOD = 0;
export function netDir(phase: number): Vector3 {
  const s = (netSwing(phase) + 1) / 2;
  const lift = 0.06 * Math.sin(phase * TAU * 2);
  return lerpDir(v(-0.62, 0.5 + lift, 0.6), v(0.55, 0.42 + lift, 0.72), smooth(s));
}
export const SHUTTLE_KICK = v(-0.02, 0.36, 0.33);
export const SHUTTLE_RISE = 1.3;
export const shuttleHeight = (phase: number) => SHUTTLE_KICK.y + 4 * SHUTTLE_RISE * phase * (1 - phase);

/** Dancing together: the joined hands rise overhead and come down. */
export const PAIR_DANCE_PERIOD = 2.4;
/** Distance between two dancing partners (character origins). */
export const PAIR_DANCE_GAP = 0.8;
/** Walking hand in hand: the follower walks this far to the leader's right. */
export const HAND_GAP = 0.62;

/** Create the procedural emote clips, in state order (3 … MAX_NET_STATE). */
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

  /** Rest direction of a bone chain, one per segment (model space). */
  const restDirs = (chain: number[]) =>
    chain.slice(0, -1).map((b, k) => new Vector3().subVectors(rest.worldPos[chain[k + 1]], rest.worldPos[b]).normalize());
  const lerpDirs = (a: Vector3[], b: Vector3[], t: number) => a.map((d, k) => lerpDir(d, b[k], t));
  /** Shoulder position after a spine turn (and a hips shift), model space. */
  const shoulderAt = (chain: number[], spineTurn = new Quaternion(), hipsShift = new Vector3()) => {
    const pivot = rest.worldPos[SPINE];
    return rest.worldPos[chain[1]].clone().sub(pivot).applyQuaternion(spineTurn).add(pivot).add(hipsShift);
  };
  /**
   * Two-bone IK: upper arm + forearm directions that put the hand on
   * `target` (model space), the elbow bending toward `pole`. Out of reach =
   * the arm points straight at the target.
   */
  const reach = (chain: number[], target: Vector3, pole: Vector3, shoulder = rest.worldPos[chain[1]]): Vector3[] => {
    const [, sh, el, ha] = chain;
    const l1 = rest.worldPos[el].distanceTo(rest.worldPos[sh]);
    const l2 = rest.worldPos[ha].distanceTo(rest.worldPos[el]);
    const d = target.clone().sub(shoulder);
    const dist = Math.min(l1 + l2 - 1e-4, Math.max(Math.abs(l1 - l2) + 1e-4, d.length()));
    const dir = d.normalize();
    const cosA = Math.min(1, Math.max(-1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)));
    const a = Math.acos(cosA);
    const bend = pole.clone().addScaledVector(dir, -pole.dot(dir));
    if (bend.lengthSq() < 1e-8) bend.set(0, -1, 0).addScaledVector(dir, -dir.y);
    bend.normalize();
    const upper = dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(bend, Math.sin(a));
    const elbow = shoulder.clone().addScaledVector(upper, l1);
    const fore = shoulder.clone().addScaledVector(dir, dist).sub(elbow).normalize();
    return [upper, fore];
  };
  const RIGHT_POLE = v(-0.6, -0.6, -0.4);
  const LEFT_POLE = v(0.6, -0.6, -0.4);
  const restRightArm = restDirs(ARM(RIGHT_ARM));
  const restLeftArm = restDirs(ARM(LEFT_ARM));
  /** Hands on the hips, elbows out. */
  const akimbo = (f: Frame, chain: number[], side: number, turn?: Quaternion) =>
    aimChain(f, rest, ARM(chain), reach(chain, v(side * 0.2, 0.76, 0.0), v(side * 0.8, -0.1, -0.6), shoulderAt(chain, turn)), turn);

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
  const sitFrame = (t: number): Frame => {
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
  };
  const sit = buildClip('emote-sit', rest, 3.2, 16, sitFrame);

  // 7 Fishing: both hands on the rod, waiting (nibbles), then a yank up and a
  // slow lowering. The rod itself is a prop that follows the right hand.
  const fishFrame = (t: number): Frame => {
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
  };
  const fish = buildClip('emote-fish', rest, FISH_PERIOD, 28, fishFrame);
  // Walking with the rod held out (line in the water): the run cycle below the
  // waist, the waiting pose above. One copy per fishing state (mini-game stages).
  const fishWalk = buildMovingClip('emote-fish-walk', rest, run, 3, () => fishFrame(0.25));
  const fishMoving = FISHING_STATES.map((state, k) => ({ state, clip: k ? fishWalk.clone() : fishWalk }));

  // 43 Catching butterflies: the net sweeps right ↔ left in front, the chest
  // turning with it, the free arm swinging low. Running: the same sweep over
  // the run cycle (legs from the run clip).
  const netFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const s = netSwing(t);
    const twist = aroundY(0.22 * s).multiply(aroundX(0.05));
    turnBone(f, rest, SPINE, twist);
    const d = netDir(t);
    aimChain(f, rest, ARM(RIGHT_ARM), [lerpDir(v(-0.3, -0.4, 0.86), d, 0.4), d], twist);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.25, -0.85, 0.3 + 0.1 * s), v(0.12, -0.55, 0.8)], twist);
    return f;
  };
  const net = buildClip('emote-net', rest, NET_PERIOD, 24, netFrame);
  NET_WALK_PERIOD = run.duration * 3;
  const netWalk = buildMovingClip('emote-net-walk', rest, run, 3, (p) => netFrame(((p * NET_WALK_PERIOD) / NET_PERIOD) % 1));

  // 44 … 64 Showing off a catch: the fish held up in the left hand in front of
  // the shoulder, the rod in the right hand (low, in front of the hip, the rod
  // upright over the shoulder: HOLD_ROD_DIR), chest out; the same pose while
  // walking (legs from the run clip). One copy per species state.
  const holdFishFrame = (): Frame => {
    const f: Frame = { quats: new Map() };
    const proud = aroundX(-0.06);
    turnBone(f, rest, SPINE, proud);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.45, -0.05, 0.89), v(0.1, 0.8, 0.6)], proud);
    aimChain(f, rest, ARM(RIGHT_ARM), [v(-0.3, -0.85, 0.3), v(-0.2, -0.15, 0.97)], proud);
    return f;
  };
  const holdFish = buildClip('emote-hold-fish', rest, 2, 2, holdFishFrame);
  const holdFishWalk = buildMovingClip('emote-hold-fish-walk', rest, run, 3, holdFishFrame);
  const holdFishStates = Array.from({ length: HOLD_FISH_COUNT }, (_, k) => HOLD_FISH_STATE + k);
  const holdFishClips = holdFishStates.map((_, k) => (k ? holdFish.clone() : holdFish));
  const holdFishMoving = holdFishStates.map((state, k) => ({ state, clip: k ? holdFishWalk.clone() : holdFishWalk }));

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
  // Own copies per dog state (one action per state in the mixer).
  const [walkDog2, walkDog3, walkDog4] = [0, 1, 2].map(() => walkDog.clone());

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
    ...DOG_STATES.slice(1).map((state) => ({ state, clip: buildMovingClip(`emote-walk-dog${state}-walk`, rest, run, 3, leashFrame) })),
  ];

  // ---------------------------------------------------------------------------
  // Countryside emotes (states 16 … 29)
  // ---------------------------------------------------------------------------

  // 16 Stretch: arms up overhead, lean back with a yawn, lower the arms
  // through the sides, relax. Plays from phase 0 (PHASED_EMOTES).
  const upR = [v(-0.2, 0.98, 0.05), v(0.22, 0.97, 0.02)];
  const upL = [v(0.2, 0.98, 0.05), v(-0.22, 0.97, 0.02)];
  const sideR = [v(-0.97, 0.2, 0.1), v(-0.98, 0.12, 0.12)];
  const sideL = [v(0.97, 0.2, 0.1), v(0.98, 0.12, 0.12)];
  const stretch = buildClip('emote-stretch', rest, STRETCH_PERIOD, 50, (t) => {
    const f: Frame = { quats: new Map() };
    const up = t < 0.2 ? smooth(t / 0.2) : t < 0.55 ? 1 : 0;
    const down = t < 0.55 ? 0 : t < 0.68 ? smooth((t - 0.55) / 0.13) : 1;
    const relax = t < 0.68 ? 0 : t < 0.82 ? smooth((t - 0.68) / 0.14) : 1;
    const yawn = t < 0.16 ? 0 : t < 0.28 ? smooth((t - 0.16) / 0.12) : t < 0.5 ? 1 : t < 0.62 ? 1 - smooth((t - 0.5) / 0.12) : 0;
    const arch = aroundX(-0.14 * up * (1 - down) - 0.05 * yawn);
    turnBone(f, rest, SPINE, arch);
    turnBone(f, rest, NECK, aroundX(-0.45 * yawn), arch);
    for (const [chain, restArm, upA, sideA] of [[RIGHT_ARM, restRightArm, upR, sideR], [LEFT_ARM, restLeftArm, upL, sideL]] as const) {
      const dirs = t < 0.55 ? lerpDirs(restArm, upA, up) : t < 0.68 ? lerpDirs(upA, sideA, down) : lerpDirs(sideA, restArm, relax);
      aimChain(f, rest, ARM(chain), dirs, arch);
    }
    return f;
  });

  // 17 Sky gaze: hands on the hips, head tilted back looking at the sky,
  // slowly looking around, breathing deeply.
  const skygaze = buildClip('emote-skygaze', rest, 5, 24, (t) => {
    const f: Frame = { quats: new Map() };
    const breathe = aroundX(-0.06 - 0.025 * Math.sin(t * TAU));
    turnBone(f, rest, SPINE, breathe);
    turnBone(f, rest, NECK, aroundX(-0.55).multiply(aroundY(0.3 * Math.sin(t * TAU))), breathe);
    akimbo(f, RIGHT_ARM, -1, breathe);
    akimbo(f, LEFT_ARM, 1, breathe);
    return f;
  });

  // 18 Cloud watching: flat on the back, hands behind the head, both knees
  // up swaying together; now and then the right hand points at a cloud.
  const clouds = buildClip('emote-clouds', rest, 8, 64, (t) => {
    const f: Frame = { quats: new Map(), hipsOffset: v(0, -0.6, 0) };
    const body = aroundX(-Math.PI / 2); // +y (head) → -z, face → up
    turnBone(f, rest, HIPS, body);
    const lift = aroundX(0.12 + 0.02 * Math.sin(t * TAU * 2));
    turnBone(f, rest, SPINE, lift, body);
    const torso = lift.clone().multiply(body);
    turnBone(f, rest, NECK, aroundX(0.2), torso);
    const point = t < 0.45 ? 0 : t < 0.52 ? smooth((t - 0.45) / 0.07) : t < 0.7 ? 1 : t < 0.78 ? 1 - smooth((t - 0.7) / 0.08) : 0;
    const pillowR = [v(-0.85, 0.35, -0.4), v(0.8, 0.3, -0.5)];
    const pointR = [v(-0.25, 0.95, -0.15), v(-0.2 + 0.1 * Math.sin(t * TAU * 6), 0.97, -0.1)];
    aimChain(f, rest, ARM(RIGHT_ARM), lerpDirs(pillowR, pointR, point), torso);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.85, 0.35, -0.4), v(-0.8, 0.3, -0.5)], torso);
    const sway = aroundZ(0.18 * Math.sin(t * TAU));
    for (const [chain, s] of [[RIGHT_LEG, -1], [LEFT_LEG, 1]] as const) {
      aimChain(f, rest, chain, [v(s * 0.1, 0.8, 0.58).applyQuaternion(sway), v(s * 0.03, -0.78, 0.62).applyQuaternion(sway), v(0, -0.2, 0.98)], body);
    }
    return f;
  });

  // 19 Bamboo flute (sáo ngang): held across to the right of the mouth, both
  // hands on it, head tilted toward it, swaying with the tune.
  const fluteFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const sway = aroundZ(0.04 * Math.sin(t * TAU)).multiply(aroundX(0.03 * Math.sin(t * TAU * 2)));
    turnBone(f, rest, SPINE, sway);
    turnBone(f, rest, NECK, aroundZ(0.1).multiply(aroundY(-0.1)), sway);
    const bob = v(0, 0.01 * Math.sin(t * TAU * 4), 0);
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, v(-0.31, 1.26, 0.15).add(bob), v(-0.5, -0.8, -0.1), shoulderAt(RIGHT_ARM, sway)), sway);
    aimChain(f, rest, ARM(LEFT_ARM), reach(LEFT_ARM, v(-0.12, 1.27, 0.18).add(bob), v(0.2, -0.9, 0.1), shoulderAt(LEFT_ARM, sway)), sway);
    return f;
  };
  const flute = buildClip('emote-flute', rest, 2.4, 32, fluteFrame);

  // 20 Hand fan: fanning the face with the right hand, left hand on the hip.
  const fanFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    turnBone(f, rest, NECK, aroundX(-0.08));
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, v(-0.17 + 0.05 * Math.sin(t * TAU), 1.13, 0.25), RIGHT_POLE));
    akimbo(f, LEFT_ARM, 1);
    return f;
  };
  const fan = buildClip('emote-fan', rest, FAN_PERIOD, 16, fanFrame);

  // 21 Whistle: two fingers at the mouth, the other hand waving overhead.
  const whistle = buildClip('emote-whistle', rest, WHISTLE_PERIOD, 16, (t) => {
    const f: Frame = { quats: new Map() };
    turnBone(f, rest, NECK, aroundX(-0.1));
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, v(-0.035, 1.27, 0.2), v(-0.4, -0.9, 0.1)));
    const swing = Math.sin(t * TAU);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.55, 0.8, 0.15), v(0.15 - 0.45 * swing, 1, 0.2)]);
    return f;
  });

  // 22 Watering: the can held out in the right hand, sweeping slowly over
  // the plants, looking where the water goes.
  const water = buildClip('emote-water', rest, WATER_PERIOD, 32, (t) => {
    const f: Frame = { quats: new Map() };
    const sweep = waterSweep(t);
    const lean = aroundX(0.1);
    turnBone(f, rest, SPINE, lean);
    turnBone(f, rest, NECK, aroundX(0.32).multiply(aroundY(-0.15 + 0.25 * sweep)), lean);
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, v(-0.15 + 0.13 * sweep, 0.9, 0.34), RIGHT_POLE, shoulderAt(RIGHT_ARM, lean)), lean);
    return f;
  });

  // 23 Picking a flower: squat, pick, stand up, smell it, lower the hand.
  const squatR = [v(-0.15, -0.2, 0.97), v(0, -0.77, -0.64), v(0, -0.5, 0.87)];
  const squatL = [v(0.15, -0.2, 0.97), v(0, -0.77, -0.64), v(0, -0.5, 0.87)];
  const restLegR = restDirs(RIGHT_LEG);
  const restLegL = restDirs(LEFT_LEG);
  const pick = buildClip('emote-pick', rest, PICK_PERIOD, 64, (t) => {
    const { crouch, nose } = pickPhase(t);
    const hips = v(0, -0.32 * crouch, -0.08 * crouch);
    const f: Frame = { quats: new Map(), hipsOffset: hips };
    const bend = aroundX(1.1 * crouch);
    turnBone(f, rest, SPINE, bend);
    turnBone(f, rest, NECK, aroundX(-0.35 * crouch + 0.18 * nose), bend);
    aimChain(f, rest, RIGHT_LEG, lerpDirs(restLegR, squatR, crouch));
    aimChain(f, rest, LEFT_LEG, lerpDirs(restLegL, squatL, crouch));
    const tug = t > 0.24 && t < 0.34 ? 0.05 * Math.sin(((t - 0.24) / 0.1) * Math.PI) : 0;
    const shoulderR = shoulderAt(RIGHT_ARM, bend, hips);
    const down = reach(RIGHT_ARM, v(-0.14, 0.28 + tug, 0.4), RIGHT_POLE, shoulderR);
    const smell = reach(RIGHT_ARM, v(-0.05, 1.22, 0.2), v(-0.7, -0.6, 0), shoulderR);
    aimChain(f, rest, ARM(RIGHT_ARM), lerpDirs(lerpDirs(restRightArm, down, crouch), smell, nose), bend);
    const knee = reach(LEFT_ARM, v(0.13, 0.33, 0.27), LEFT_POLE, shoulderAt(LEFT_ARM, bend, hips));
    aimChain(f, rest, ARM(LEFT_ARM), lerpDirs(restLeftArm, knee, crouch), bend);
    return f;
  });

  // 24 Feeding chickens: a basket on the left arm, the right hand dips in
  // and throws a handful of grain forward (props draw the grains).
  const feed = buildClip('emote-feed', rest, FEED_PERIOD, 36, (t) => {
    const f: Frame = { quats: new Map() };
    const s = feedSwing(t);
    const twist = aroundY(-0.18 * s);
    turnBone(f, rest, SPINE, twist);
    turnBone(f, rest, NECK, aroundX(0.15).multiply(aroundY(0.1 * s)), twist);
    aimChain(f, rest, ARM(LEFT_ARM), reach(LEFT_ARM, v(0.06, 0.86, 0.24), LEFT_POLE, shoulderAt(LEFT_ARM, twist)), twist);
    const hand = v(0.02, 0.92, 0.24).lerp(v(-0.32, 1.02, 0.4), s);
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, hand, RIGHT_POLE, shoulderAt(RIGHT_ARM, twist)), twist);
    return f;
  });

  // 25 Sweeping: both hands on the broom handle, leaning in, the broom head
  // swinging side to side in front of the feet.
  const sweep = buildClip('emote-sweep', rest, SWEEP_PERIOD, 30, (t) => {
    const f: Frame = { quats: new Map() };
    const lean = aroundY(0.12 * Math.sin(t * TAU)).multiply(aroundX(0.3));
    turnBone(f, rest, SPINE, lean);
    turnBone(f, rest, NECK, aroundX(0.1), lean);
    const top = broomTop();
    const left = top.clone().lerp(broomBottom(t), BROOM_LEFT_AT);
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, top, RIGHT_POLE, shoulderAt(RIGHT_ARM, lean)), lean);
    aimChain(f, rest, ARM(LEFT_ARM), reach(LEFT_ARM, left, v(0.6, -0.5, -0.4), shoulderAt(LEFT_ARM, lean)), lean);
    return f;
  });

  // 26 Carrying water (gánh nước): a pole on the right shoulder, the right
  // hand steadying it in front, the left arm out a little for balance.
  const carryFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const bob = 0.012 * Math.sin(t * TAU * 2);
    turnBone(f, rest, SPINE, aroundZ(-0.04));
    turnBone(f, rest, NECK, aroundZ(-0.06));
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, v(-0.15, 1.13 + bob, 0.22), v(-0.5, -0.8, -0.2)));
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.5, -0.85, 0.1), v(0.42, -0.85, 0.25)]);
    return f;
  };
  const carry = buildClip('emote-carry', rest, 2, 24, carryFrame);

  // 27 Reading: an open book held in both hands, head down, eyes moving
  // along the lines; the right hand turns a page now and then.
  const readFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    turnBone(f, rest, NECK, aroundX(0.42).multiply(aroundY(0.08 * Math.sin(t * TAU * 5))));
    const lift = Math.sin(readTurn(t) * Math.PI);
    aimChain(f, rest, ARM(LEFT_ARM), reach(LEFT_ARM, v(0.13, 0.97, 0.27), LEFT_POLE));
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, v(-0.13 + 0.12 * lift, 0.97 + 0.06 * lift, 0.27), RIGHT_POLE));
    return f;
  };
  const read = buildClip('emote-read', rest, READ_PERIOD, 60, readFrame);

  // 28 Sitting on a bench (seat top ≈ 0.3 above the feet): thighs flat,
  // lower legs swinging, hands on the seat edge, looking around.
  const SEAT_DROP = v(0, -0.33, 0);
  const benchSitFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map(), hipsOffset: SEAT_DROP };
    const lean = aroundX(0.1 + 0.015 * Math.sin(t * TAU * 2));
    turnBone(f, rest, SPINE, lean);
    turnBone(f, rest, NECK, aroundY(0.35 * Math.sin(t * TAU)).multiply(aroundX(-0.05)), lean);
    for (const [chain, s, off] of [[RIGHT_LEG, -1, 0], [LEFT_LEG, 1, Math.PI]] as const) {
      const a = 0.25 + 0.3 * Math.sin(t * TAU * 3 + off);
      const swing = aroundX(-a);
      aimChain(f, rest, chain, [v(s * 0.12, 0.02, 1), v(s * 0.02, -1, 0).applyQuaternion(swing), v(0, -0.5, 0.87).applyQuaternion(swing)]);
    }
    for (const [chain, s] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      aimChain(f, rest, ARM(chain), reach(chain, v(s * 0.24, 0.31, 0.06), v(s * 0.4, 0, -1), shoulderAt(chain, lean, SEAT_DROP)), lean);
    }
    return f;
  };
  const benchSit = buildClip('emote-bench-sit', rest, 6, 72, benchSitFrame);

  // 29 Lying on a bench: on the back, hands behind the head, right knee up,
  // left leg out, the foot tapping.
  const benchLie = buildClip('emote-bench-lie', rest, 5, 30, (t) => {
    const f: Frame = { quats: new Map(), hipsOffset: v(0, -0.31, 0) };
    const body = aroundX(-Math.PI / 2);
    turnBone(f, rest, HIPS, body);
    const lift = aroundX(0.16 + 0.02 * Math.sin(t * TAU));
    turnBone(f, rest, SPINE, lift, body);
    const torso = lift.clone().multiply(body);
    turnBone(f, rest, NECK, aroundX(0.2), torso);
    for (const [chain, side] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      aimChain(f, rest, ARM(chain), [v(side * 0.85, 0.35, -0.4), v(-side * 0.8, 0.3, -0.5)], torso);
    }
    aimChain(f, rest, RIGHT_LEG, [v(-0.12, 0.8, 0.58), v(-0.04, -0.78, 0.62), v(0, -0.2, 0.98)], body);
    const tap = 0.12 * Math.max(0, Math.sin(t * TAU * 4));
    aimChain(f, rest, LEFT_LEG, [v(0.08, -0.02, 1), v(0.06, 0.02, 1), v(0.05, 0.85 - tap, 0.5 + tap)], body);
    return f;
  });

  // ---------------------------------------------------------------------------
  // Play together (states 30 … 38) and local pair poses
  // ---------------------------------------------------------------------------

  // 30 Jump rope: hands at the hips turning small circles with the rope, a hop
  // each time it passes under the feet, knees soft on landing.
  const bentR = [v(-0.1, -0.88, 0.42), v(0, -0.95, -0.3), v(0, -0.5, 0.87)];
  const bentL = [v(0.1, -0.88, 0.42), v(0, -0.95, -0.3), v(0, -0.5, 0.87)];
  const tipToe = [v(0, -0.25, 0.97)];
  const jumpRope = buildClip('emote-jumprope', rest, JUMPROPE_PERIOD, 24, (t) => {
    const hop = ropeHop(t);
    const land = 0.05 * Math.max(0, -Math.cos(t * TAU));
    const f: Frame = { quats: new Map(), hipsOffsetY: hop - land };
    const bend = land / 0.05;
    const air = hop / 0.09;
    aimChain(f, rest, RIGHT_LEG, [...lerpDirs(restLegR.slice(0, 2), bentR.slice(0, 2), bend), lerpDir(restLegR[2], tipToe[0], air)]);
    aimChain(f, rest, LEFT_LEG, [...lerpDirs(restLegL.slice(0, 2), bentL.slice(0, 2), bend), lerpDir(restLegL[2], tipToe[0], air)]);
    const circle = ropeDir(t).multiplyScalar(0.05);
    const hips = v(0, hop - land, 0);
    for (const [chain, s, pole] of [[RIGHT_ARM, -1, RIGHT_POLE], [LEFT_ARM, 1, LEFT_POLE]] as const) {
      aimChain(f, rest, ARM(chain), reach(chain, v(s * 0.3, 0.84, 0.08).add(circle).add(hips), pole, shoulderAt(chain, undefined, hips)));
    }
    return f;
  });

  // 31 Shuttlecock: kicked up with the inside of the right foot at phase 0,
  // arms out for balance, eyes on the shuttle.
  const kickR = [v(-0.35, -0.45, 0.82), v(0.6, -0.75, 0.28), v(0.75, -0.1, 0.65)];
  const shuttle = buildClip('emote-shuttle', rest, SHUTTLE_PERIOD, 44, (t) => {
    const f: Frame = { quats: new Map() };
    const kick = Math.max(0, Math.cos(t * TAU)) ** 6;
    aimChain(f, rest, RIGHT_LEG, lerpDirs(restLegR, kickR, kick));
    const height = (shuttleHeight(t) - SHUTTLE_KICK.y) / SHUTTLE_RISE; // 0 … 1
    const lean = aroundX(0.12 + 0.08 * kick).multiply(aroundZ(-0.06 * kick));
    turnBone(f, rest, SPINE, lean);
    turnBone(f, rest, NECK, aroundX(0.45 - 0.9 * height), lean);
    for (const [chain, s] of [[RIGHT_ARM, -1], [LEFT_ARM, 1]] as const) {
      const out = 0.5 + 0.5 * kick;
      aimChain(f, rest, ARM(chain), [lerpDir(v(s * 0.4, -0.85, 0.2), v(s * 0.9, -0.3, 0.2), out), lerpDir(v(s * 0.2, -0.8, 0.5), v(s * 0.85, -0.1, 0.5), out)], lean);
    }
    return f;
  });

  // 32 / 33 Offering something (flower / ice cream) with the right hand held
  // out, a small bow and a shy sway.
  const offerFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const lean = aroundX(0.1).multiply(aroundZ(0.03 * Math.sin(t * TAU)));
    turnBone(f, rest, SPINE, lean);
    turnBone(f, rest, NECK, aroundX(0.12), lean);
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, v(-0.1, 1.0 + 0.015 * Math.sin(t * TAU * 2), 0.42), RIGHT_POLE, shoulderAt(RIGHT_ARM, lean)), lean);
    aimChain(f, rest, ARM(LEFT_ARM), [v(0.2, -0.85, -0.45), v(-0.5, -0.4, -0.75)], lean); // hand behind the back
    return f;
  };
  const offerFlower = buildClip('emote-offer-flower', rest, 2, 16, offerFrame);
  const offerIceCream = buildClip('emote-offer-icecream', rest, 2, 16, offerFrame);

  // 34 Holding a flower that was given: at the chest, now and then to the nose.
  const holdFlowerFrame = (t: number): Frame => {
    const f: Frame = { quats: new Map() };
    const smell = t < 0.5 ? 0 : t < 0.6 ? smooth((t - 0.5) / 0.1) : t < 0.85 ? 1 : 1 - smooth((t - 0.85) / 0.15);
    turnBone(f, rest, NECK, aroundX(0.08 + 0.15 * smell));
    const hand = v(-0.1, 1.0, 0.24).lerp(v(-0.05, 1.22, 0.2), smell);
    aimChain(f, rest, ARM(RIGHT_ARM), reach(RIGHT_ARM, hand, v(-0.7, -0.6, 0)));
    return f;
  };
  const holdFlower = buildClip('emote-hold-flower', rest, 4, 32, holdFlowerFrame);
  // 35 An ice cream someone treated us to: same as eating our own.
  const treatIceCream = buildClip('emote-treat-icecream', rest, ICECREAM_PERIOD, 30, iceCreamFrame);

  // 36 / 37 Hand in hand: the hand toward the partner low and out to the
  // side; the other arm is free (swings with the walk).
  const handFrame = (side: number) => (): Frame => {
    const f: Frame = { quats: new Map() };
    const chain = side < 0 ? RIGHT_ARM : LEFT_ARM;
    aimChain(f, rest, ARM(chain), reach(chain, v(side * (HAND_GAP / 2), 0.78, 0.06), v(side * 0.2, 0.3, -1)));
    turnBone(f, rest, NECK, aroundY(side * -0.25)); // glance at the partner
    return f;
  };
  const handRightFrame = handFrame(-1);
  const handLeftFrame = handFrame(1);
  const handRight = buildClip('emote-hand-right', rest, 2, 4, handRightFrame);
  const handLeft = buildClip('emote-hand-left', rest, 2, 4, handLeftFrame);

  // 38 Dancing together, face to face, both hands joined: bouncing on the
  // beat, the joined hands rising into an arch overhead and coming down,
  // leaning back a little. Symmetric, so both partners match on the shared clock.
  const pairDance = buildClip('emote-pair-dance', rest, PAIR_DANCE_PERIOD, 48, (t) => {
    const raise = smooth(0.5 - 0.5 * Math.cos(t * TAU));
    const bounce = 0.035 * Math.abs(Math.sin(t * TAU * 2));
    const f: Frame = { quats: new Map(), hipsOffsetY: -bounce };
    const lean = aroundX(-0.08 * (1 - raise) + 0.04 * raise);
    turnBone(f, rest, SPINE, lean);
    turnBone(f, rest, NECK, aroundX(-0.15 * raise).multiply(aroundY(0.2 * Math.sin(t * TAU * 2))), lean);
    const hips = v(0, -bounce, 0);
    const reachOut = PAIR_DANCE_GAP / 2 - 0.04;
    for (const [chain, s, pole] of [[RIGHT_ARM, -1, RIGHT_POLE], [LEFT_ARM, 1, LEFT_POLE]] as const) {
      const hand = v(s * 0.17, 0.95 + 0.42 * raise, reachOut - 0.1 * raise).add(hips);
      aimChain(f, rest, ARM(chain), reach(chain, hand, pole, shoulderAt(chain, lean, hips)), lean);
    }
    for (const [chain, s] of [[RIGHT_LEG, -1], [LEFT_LEG, 1]] as const) {
      const knee = bounce / 0.035;
      aimChain(f, rest, chain, lerpDirs(s < 0 ? restLegR : restLegL, s < 0 ? bentR : bentL, 0.35 * knee));
    }
    return f;
  });

  // Local pair poses: sitting side by side with an arm around the partner's
  // shoulders (side -1 = partner on the right), leaning toward them.
  const armAround = (base: (t: number) => Frame, baseLean: (t: number) => Quaternion, hips: Vector3, side: number) => (t: number): Frame => {
    const f = base(t);
    const turn = aroundZ(-side * 0.08).multiply(baseLean(t));
    turnBone(f, rest, SPINE, turn);
    const chain = side < 0 ? RIGHT_ARM : LEFT_ARM;
    const shoulder = shoulderAt(chain, turn, hips);
    const hand = v(side * 0.5, shoulder.y + 0.05, 0.02);
    aimChain(f, rest, ARM(chain), reach(chain, hand, v(0, 0.3, -1), shoulder), turn);
    turnBone(f, rest, NECK, aroundY(-side * 0.3), turn);
    return f;
  };
  const sitLean = (t: number) => aroundX(0.16 + 0.03 * Math.sin(t * TAU));
  const benchLean = (t: number) => aroundX(0.1 + 0.015 * Math.sin(t * TAU * 2));
  const SIT_DROP = v(0, -0.56, 0);
  const pairPoses = [
    { state: PAIR_POSES.sitArmR, clip: buildClip('pair-sit-arm-r', rest, 3.2, 16, armAround(sitFrame, sitLean, SIT_DROP, -1)) },
    { state: PAIR_POSES.sitArmL, clip: buildClip('pair-sit-arm-l', rest, 3.2, 16, armAround(sitFrame, sitLean, SIT_DROP, 1)) },
    { state: PAIR_POSES.benchArmR, clip: buildClip('pair-bench-arm-r', rest, 6, 72, armAround(benchSitFrame, benchLean, SEAT_DROP, -1)) },
    { state: PAIR_POSES.benchArmL, clip: buildClip('pair-bench-arm-l', rest, 6, 72, armAround(benchSitFrame, benchLean, SEAT_DROP, 1)) },
  ];

  const countryClips = [
    stretch, skygaze, clouds, flute, fan, whistle, water, pick, feed, sweep, carry, read, benchSit, benchLie,
    jumpRope, shuttle, offerFlower, offerIceCream, holdFlower, treatIceCream, handRight, handLeft, pairDance,
  ];
  const countryMoving = [
    { state: FLUTE_STATE, clip: buildMovingClip('emote-flute-walk', rest, run, 3, fluteFrame) },
    { state: FAN_STATE, clip: buildMovingClip('emote-fan-walk', rest, run, 3, (t) => {
      const f = fanFrame((t * 3 * run.duration) / FAN_PERIOD % 1);
      return f;
    }) },
    { state: CARRY_STATE, clip: buildMovingClip('emote-carry-walk', rest, run, 3, (t) => {
      const f = carryFrame(t);
      f.quats.delete(LEFT_ARM[1]); // the free arm swings with the walk
      f.quats.delete(LEFT_ARM[2]);
      return f;
    }) },
    { state: READ_STATE, clip: buildMovingClip('emote-read-walk', rest, run, 6, readFrame) },
    { state: HOLD_FLOWER_STATE, clip: buildMovingClip('emote-hold-flower-walk', rest, run, 6, holdFlowerFrame) },
    { state: TREAT_ICECREAM_STATE, clip: buildMovingClip('emote-treat-icecream-walk', rest, run, 4, iceCreamFrame) },
    { state: HAND_RIGHT_STATE, clip: buildMovingClip('emote-hand-right-walk', rest, run, 2, handRightFrame) },
    { state: HAND_LEFT_STATE, clip: buildMovingClip('emote-hand-left-walk', rest, run, 2, handLeftFrame) },
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
    ...pairPoses,
  ];

  return {
    // States 39 … 42: the fishing mini-game stages, same clip (own copies: one
    // action per state in the mixer).
    clips: [wave, clap, dance, sit, fish, prone, sunbathe, guitar, kite, iceCream, highFive, walkDog, walkDog2, ...countryClips, ...[0, 1, 2, 3].map(() => fish.clone()), net, ...holdFishClips, walkDog3, walkDog4],
    moving: [...moving, ...countryMoving, ...fishMoving, { state: NET_STATE, clip: netWalk }, ...holdFishMoving],
    npc,
  };
}
