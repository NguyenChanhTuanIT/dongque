// Client-side NPCs: every client runs the same little scenes (deterministic
// spots, time-driven), so all players see them alike without any network
// traffic. Each group is toggled live from the admin panel
// (config.features.npcs).
//
//   seaCouple   two kids sitting on the beach watching the sea, the boy holding the girl by the waist
//   kiteFlyers  two kids strolling on the beach with kites, laughing now and then
//   guitarist   a kid playing guitar and singing at the far end of the road
//
// Optional sounds (drop the files in public/assets/audio/, they are picked up
// automatically; nothing plays while they are missing):
//   npc-laugh.mp3   one-shot laughter of the kite flyers (louder when close)
//   npc-guitar.mp3  looping guitar / song of the guitarist (louder when close)

import { CanvasTexture, Raycaster, Sprite, SpriteMaterial, Vector3, type Mesh, type Object3D } from 'three';
import { gsap } from 'gsap';
import { clock } from '../engine/clock';
import type { AudioController } from '../engine/audio';
import type { CharacterLocal, Characters } from '../engine/characters';
import type { SceneConfig } from '../config/schema';
import { GUITAR_STATE, KITE_STATE, NPC_STATES } from './emotes';

type Group = keyof SceneConfig['features']['npcs'];

const LAUGH_URL = '/assets/audio/npc-laugh.mp3';
const GUITAR_URL = '/assets/audio/npc-guitar.mp3';
const LAUGH_RANGE = 35;
const GUITAR_RANGE = 45;
const UP = new Vector3(0, 1, 0);

/** Outfit = item index per slot [hat, hair, top, bottom, shoes, glasses]; seed = skin tone + hue. */
const LOOKS = {
  coupleBoy: { outfit: [1, 0, 0, 0, 0, 0], seed: 0.62 },
  coupleGirl: { outfit: [0, 3, 0, 1, 1, 0], seed: 1.93 },
  kiteGirl: { outfit: [1, 1, 0, 1, 0, 0], seed: 2.14 },
  kiteBoy: { outfit: [0, 0, 0, 0, 1, 1], seed: 0.36 },
  guitarist: { outfit: [1, 0, 0, 0, 0, 1], seed: 3.08 },
};

/** Spots, found by probing the map: the coast runs along x ≈ 80–82 (sea toward +x). */
const SPOT = {
  couple: { x: 77, z: 0 },
  kites: { cx: 73.5, cz: 22, rx: 3, rz: 8 },
  guitarist: { x: 19.5, z: -2, lookAt: { x: 15.5, z: -57 } }, // faces the spawn, up the road
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

interface KiteWalker {
  npc: CharacterLocal;
  phase: number; // offset on the ellipse
  u: number;
  yaw: number;
  speed: number;
  schedule: number; // offset in the walk / stop cycle
}

export class NpcManager {
  private _enabled: Record<Group, boolean> = { seaCouple: false, kiteFlyers: false, guitarist: false };
  private _active = new Map<Group, string[]>();
  private _walkers: KiteWalker[] = [];
  private _guitarist: CharacterLocal | null = null;
  private _guitarLoop: { setVolume(v: number): void; stop(): void } | null = null;
  private _guitarLoopPending = false;
  private _rc = new Raycaster();
  private _textures = new Map<string, CanvasTexture>();
  private _nextLaugh = 4;
  private _nextNote = 0;
  private _time = 0;

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
    } else {
      const { x, z, lookAt } = SPOT.guitarist;
      this._guitarist = this._spawn('guitarist', LOOKS.guitarist, x, z, yawToward(lookAt.x - x, lookAt.z - z), GUITAR_STATE);
      ids.push('guitarist');
    }
    this._active.set(group, ids);
  }

  private _hide(group: Group) {
    for (const id of this._active.get(group) ?? []) this._characters.removeNpc(id);
    this._active.delete(group);
    if (group === 'kiteFlyers') this._walkers = [];
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
  }

  private _updateKites(dt: number, player: CharacterLocal) {
    if (!this._walkers.length) return;
    const { cx, cz, rx, rz } = SPOT.kites;
    const walkSpeed = 1.1; // m/s
    const radius = Math.sqrt((rx * rx + rz * rz) / 2);
    for (const w of this._walkers) {
      // 12 s cycle: stroll for 7 s, stop and fly the kite for 5 s
      const walking = (this._time + w.schedule) % 12 < 7;
      w.speed += ((walking ? walkSpeed : 0) - w.speed) * Math.min(1, dt * 2.5);
      w.u += (w.speed * dt) / radius;
      const x = cx + rx * Math.cos(w.u);
      const z = cz + rz * Math.sin(w.u);
      if (w.speed > 0.05) w.yaw = yawToward(-rx * Math.sin(w.u), rz * Math.cos(w.u));
      w.npc.position.set(x, this._ground(x, z), z);
      w.npc.quaternion.setFromAxisAngle(UP, w.yaw);
      w.npc.velocityHorizontal = w.speed / 60; // the engine measures speed per 60 fps frame
    }
    // laughter: now and then, one of them laughs ("ha ha!" + optional sound)
    if (this._time >= this._nextLaugh) {
      this._nextLaugh = this._time + 5 + Math.random() * 6;
      const w = this._walkers[Math.floor(Math.random() * this._walkers.length)];
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
    this._guitarLoop?.setVolume(0.8 * Math.max(0, 1 - d / GUITAR_RANGE));
  }

  /** A floating text sprite above a character (notes, laughter). */
  private _float(at: Vector3, text: string, color: string, font: string, height: number, size: number, drift = 0) {
    const key = `${text}|${color}|${font}`;
    let texture = this._textures.get(key);
    if (!texture) this._textures.set(key, (texture = textTexture(text, color, font)));
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
      },
    });
  }
}
