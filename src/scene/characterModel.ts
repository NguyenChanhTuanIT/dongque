// Which body the players have: the original kid (`.bin` assets of the
// Summer Afternoon experiment) by default. `?char=kaykit` in the URL tries a
// CC0 glTF model instead (work in progress: no outfits, emotes not tuned).
//
// KayKit Adventurers (Kay Lousberg, CC0 1.0): public/assets/characters/kaykit/.

import { BufferAttribute, type AnimationClip, type SkinnedMesh } from 'three';
import { geometryLoader } from '../engine/loaders/geometries';
import { loadGltfCharacter } from '../engine/loaders/gltfCharacter';
import { withOutfitParts } from './appearance';

export interface CharacterBody {
  skinned: SkinnedMesh;
  /** idle, run, airborne, bored: animation states 0-2 (see engine/characters.ts). */
  clips: AnimationClip[];
  /** The outfit parts (hats, hair…) are built for the kid only. */
  outfits: boolean;
  /** Per-vertex colors (`charColor`) instead of the kid's ramp rows. */
  vertexColors: boolean;
}

/**
 * KayKit "Rig_Medium" bone for each slot of the kid skeleton (scene/emotes.ts
 * skeleton map); null = no such bone (clavicles, neck), a still helper is used.
 */
const KAYKIT_RIG: Array<string | null> = [
  'lowerleg.r', // 0 right knee
  'foot.r', // 1 right ankle
  'toes.r', // 2 right toe
  'upperleg.r', // 3 right hip
  'hips', // 4 hips
  'spine', // 5 spine
  'upperleg.l', // 6 left hip
  'chest', // 7 chest
  'hand.r', // 8 right hand
  'lowerarm.r', // 9 right elbow
  'upperarm.r', // 10 right shoulder
  null, // 11 neck base
  null, // 12 right clavicle
  'head', // 13 neck (the emotes nod with it)
  null, // 14 head
  'lowerleg.l', // 15 left knee
  'foot.l', // 16 left ankle
  'toes.l', // 17 left toe
  'hand.l', // 18 left hand
  'upperarm.l', // 19 left shoulder
  'lowerarm.l', // 20 left elbow
  null, // 21 left clavicle
];
const KAYKIT_HELPER_PARENTS: Record<number, string> = { 11: 'chest', 12: 'chest', 14: 'head', 21: 'chest' };

export const CHARACTER_MODEL = new URLSearchParams(window.location.search).get('char') === 'kaykit' ? 'kaykit' : 'kid';

export async function loadCharacterBody(): Promise<CharacterBody> {
  if (CHARACTER_MODEL === 'kid') {
    const [skinned, clips] = await Promise.all([
      geometryLoader.skin('kid.bin', 'kid-bones.bin'),
      Promise.all(['kid-idle.bin', 'kid-run.bin', 'kid-air.bin', 'kid-bored.bin'].map((c) => geometryLoader.skinAnimation(c))),
    ]);
    // Outfits: every part (hat, hair styles, skirt, glasses…) is in the mesh;
    // the shader shows each player's parts from a per-instance bitmask.
    skinned.geometry = withOutfitParts(skinned.geometry);
    return { skinned, clips, outfits: true, vertexColors: false };
  }

  const { skinned, clips } = await loadGltfCharacter({
    url: '/assets/characters/kaykit/Rogue.glb',
    rig: KAYKIT_RIG,
    helperParents: KAYKIT_HELPER_PARENTS,
    height: 1.55, // the kid's height: camera, physics and props are tuned for it
  });
  const clip = (name: string) => {
    const c = clips.get(name);
    if (!c) throw new Error(`KayKit clip "${name}" missing`);
    return c;
  };
  // Every vertex is the always-visible body part (outfit mask bit 0).
  skinned.geometry.setAttribute('partId', new BufferAttribute(new Float32Array(skinned.geometry.attributes.position.count), 1));
  return {
    skinned,
    clips: [clip('Idle'), clip('Running_A'), clip('Jump_Idle'), clip('Sit_Floor_Idle')],
    outfits: false,
    vertexColors: true,
  };
}
