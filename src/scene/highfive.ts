// High five: pressing H turns the kid toward the nearest player and raises a
// hand (emote state 13). Whenever two characters in that state stand close
// together, every client sees the same thing — a 👏 burst between them and a
// clap sound — and the local player lowers the hand. No server logic needed:
// each client checks the pairs it can see.

import { CanvasTexture, Object3D, Sprite, SpriteMaterial, Vector3 } from 'three';
import { gsap } from 'gsap';
import { events } from '../core/events';
import type { Characters } from '../engine/characters';
import { HIGHFIVE_SLOT, HIGHFIVE_STATE } from './emotes';

/** Look for a partner within this distance when pressing H. */
const SEARCH_RADIUS = 4;
/** Two raised hands closer than this connect. */
const CONNECT_DISTANCE = 2.3;

function burstTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = 'rgba(255, 246, 214, 0.95)';
  for (let k = 0; k < 10; k++) {
    // a soft star behind the emoji
    const a = (k / 10) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(64, 64);
    ctx.lineTo(64 + Math.cos(a - 0.12) * 60, 64 + Math.sin(a - 0.12) * 60);
    ctx.lineTo(64 + Math.cos(a + 0.12) * 60, 64 + Math.sin(a + 0.12) * 60);
    ctx.fill();
  }
  ctx.font = '64px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('👏', 64, 68);
  return new CanvasTexture(canvas);
}

export class HighFive {
  private _texture: CanvasTexture | null = null;
  /** Pairs already celebrated, until one of them lowers the hand. */
  private _done = new Set<string>();
  private _raised: Array<[string, Object3D]> = [];

  constructor(private _scene: Object3D, private _characters: Characters) {
    events.on('webgl_character_emote', this._onEmote);
  }

  /** H: face the nearest player before the engine raises the hand. */
  private _onEmote = (slot = 1) => {
    if (slot !== HIGHFIVE_SLOT) return;
    const local = (this._characters as any)._localObject as Object3D;
    let best: Object3D | null = null;
    let bestD = SEARCH_RADIUS;
    this._characters.forEachCharacter((id, obj) => {
      if (id === 'local') return;
      const d = obj.position.distanceTo(local.position);
      if (d < bestD) {
        bestD = d;
        best = obj;
      }
    });
    if (best) this._characters.faceTowards((best as Object3D).position.x, (best as Object3D).position.z);
  };

  /** Per frame, after the characters updated. */
  update() {
    this._raised.length = 0;
    this._characters.forEachCharacter((id, obj) => {
      if ((obj.userData as any).a === HIGHFIVE_STATE) this._raised.push([id, obj]);
    });
    // Forget pairs where someone lowered the hand.
    for (const key of this._done) {
      const [a, b] = key.split('|');
      if (!this._raised.some(([id]) => id === a) || !this._raised.some(([id]) => id === b)) this._done.delete(key);
    }
    for (let i = 0; i < this._raised.length; i++) {
      for (let j = i + 1; j < this._raised.length; j++) {
        const [ida, a] = this._raised[i];
        const [idb, b] = this._raised[j];
        const key = ida < idb ? `${ida}|${idb}` : `${idb}|${ida}`;
        if (this._done.has(key) || a.position.distanceTo(b.position) > CONNECT_DISTANCE) continue;
        this._done.add(key);
        this._celebrate(a.position.clone().add(b.position).multiplyScalar(0.5));
        if (ida === 'local' || idb === 'local') {
          const other = ida === 'local' ? b : a;
          this._characters.faceTowards(other.position.x, other.position.z);
          this._characters.endEmoteIn(0.8);
        }
      }
    }
  }

  private _celebrate(at: Vector3) {
    this._texture ??= burstTexture();
    const material = new SpriteMaterial({ map: this._texture, transparent: true, depthWrite: false });
    const sprite = new Sprite(material);
    sprite.position.copy(at).add(new Vector3(0, 1.75, 0));
    sprite.scale.setScalar(0.01);
    sprite.renderOrder = 10;
    this._scene.add(sprite);
    events.emit('webgl_audio_play_sound', 'click1');
    gsap.to(sprite.scale, { x: 0.9, y: 0.9, z: 0.9, duration: 0.35, ease: 'back.out(2.5)' });
    gsap.to(sprite.position, { y: sprite.position.y + 0.5, duration: 1.1, ease: 'power1.out' });
    gsap.to(material, {
      opacity: 0,
      delay: 0.6,
      duration: 0.5,
      onComplete: () => {
        this._scene.remove(sprite);
        material.dispose();
      },
    });
  }
}
