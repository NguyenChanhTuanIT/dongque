// Dev tool: export the kid character (.bin mesh + skeleton + animations) as
// one binary glTF that Blender & co. can open. Open
//   http://localhost:5173/tools/export-kid-glb.html   (npm run dev)
// and the file downloads. The game itself keeps loading the .bin files.
//
// - Bones get descriptive names (hips, thigh_R, forearm_L…) instead of bone_<i>.
// - Real colors are baked into COLOR_0 (the game colors the kid in its shader
//   from ramp rows); the raw ramp info stays in the custom `_colorInfo`.
// - Animations: idle, run, jump, bored (the original clips) and every
//   procedural emote of scene/emotes.ts, named after its id.
//
// The model, skeleton and clips are from Summer Afternoon (Vicente Lucendo):
// converting them does not change who owns them (see exports/README.md).

import { AnimationClip, BufferAttribute, Color, MeshStandardMaterial, Scene, type SkinnedMesh } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { geometryLoader } from '../src/engine/loaders/geometries';
import { EMOTES, createEmoteClips } from '../src/scene/emotes';

/** Kid skeleton slots (see the map at the top of scene/emotes.ts). */
const BONE_NAMES = [
  'shin_R', // 0 right knee
  'foot_R', // 1 right ankle
  'toe_R', // 2
  'thigh_R', // 3 right hip
  'hips', // 4 root
  'spine', // 5
  'thigh_L', // 6 left hip
  'chest', // 7
  'hand_R', // 8
  'forearm_R', // 9 right elbow
  'upperarm_R', // 10 right shoulder
  'neck_base', // 11
  'clavicle_R', // 12
  'neck', // 13
  'head', // 14
  'shin_L', // 15
  'foot_L', // 16
  'toe_L', // 17
  'hand_L', // 18
  'upperarm_L', // 19
  'forearm_L', // 20
  'clavicle_L', // 21
];

const ORIGINAL_CLIPS: Array<[file: string, name: string]> = [
  ['kid-idle.bin', 'idle'],
  ['kid-run.bin', 'run'],
  ['kid-air.bin', 'jump'],
  ['kid-bored.bin', 'bored'],
];

/** colorInfo.y kinds (scene/appearance.ts). */
const KIND_SKIN = 1;
const KIND_PLAYER = 2;
const SKIN_ROW = 79; // first of the four skin tones
/** Lit side of the toon ramps (the shader moves along x with the light). */
const RAMP_X = 0.8;
/** The player color for the export (the game picks a random one per player). */
const PLAYER_COLOR = new Color().setHSL(0.58, 0.4, 0.45);

async function rampSampler(): Promise<(row: number, out: Color) => Color> {
  const image = new Image();
  image.src = '/assets/images/ramps.png';
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return (row, out) => {
    // Same lookup as getRamp() in glsl/fragment.glsl (texture flipY: row 0 at the top).
    const y = Math.min(height - 1, Math.max(0, Math.floor((row * 0.01 - 0.005) * height)));
    const x = Math.min(width - 1, Math.floor(RAMP_X * width));
    const p = (y * width + x) * 4;
    return out.setRGB(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255).convertSRGBToLinear();
  };
}

export async function exportKidGlb(): Promise<ArrayBuffer> {
  const [skinned, clips] = await Promise.all([
    geometryLoader.skin('kid.bin', 'kid-bones.bin') as Promise<SkinnedMesh>,
    Promise.all(ORIGINAL_CLIPS.map(([file]) => geometryLoader.skinAnimation(file))),
  ]);
  const ramp = await rampSampler();

  // Emotes are generated from the original bone names: build them first.
  const emotes = createEmoteClips(skinned, clips[0], clips[1]).clips;
  const named: AnimationClip[] = [
    ...clips.map((clip, i) => Object.assign(clip.clone(), { name: ORIGINAL_CLIPS[i][1] })),
    ...emotes.map((clip, i) => {
      const emote = EMOTES.find((e) => e.state === i + 3);
      return Object.assign(clip.clone(), { name: emote ? emote.id : `emote_${i + 3}` });
    }),
  ];

  // Descriptive bone names, and the clips' tracks renamed to match.
  const rename = new Map<string, string>();
  skinned.skeleton.bones.forEach((bone, i) => {
    const name = BONE_NAMES[i] ?? `bone_${i}`;
    rename.set(bone.name, name);
    bone.name = name;
  });
  for (const clip of named) {
    for (const track of clip.tracks) {
      const dot = track.name.indexOf('.');
      const target = rename.get(track.name.slice(0, dot));
      if (target) track.name = target + track.name.slice(dot);
    }
  }

  // Bake the colors the shader would show into COLOR_0.
  const geometry = skinned.geometry;
  const info = geometry.attributes.colorInfo;
  const colors = new Float32Array(info.count * 3);
  const c = new Color();
  for (let i = 0; i < info.count; i++) {
    const kind = Math.round(info.getY(i));
    if (kind === KIND_PLAYER) c.copy(PLAYER_COLOR);
    else ramp(kind === KIND_SKIN ? SKIN_ROW : info.getX(i), c);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.setAttribute('colorInfo', new BufferAttribute(Float32Array.from(info.array as ArrayLike<number>), 2));

  skinned.name = 'kid';
  skinned.material = new MeshStandardMaterial({ name: 'kid', vertexColors: true, roughness: 0.9 });
  const scene = new Scene();
  scene.name = 'kid';
  scene.add(skinned);
  scene.updateMatrixWorld(true);

  return (await new GLTFExporter().parseAsync(scene, { binary: true, animations: named })) as ArrayBuffer;
}

export async function downloadKidGlb() {
  const glb = await exportKidGlb();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));
  a.download = 'kid.glb';
  a.click();
  return glb.byteLength;
}
