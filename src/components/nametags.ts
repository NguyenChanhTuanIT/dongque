// Name tags and speech bubbles over characters: plain DOM elements placed
// every frame by projecting each character's head into screen space.

import { Vector3, type Camera, type Object3D } from 'three';
import { events } from '../core/events';
import { displayName } from '../social/presence';

/** Beyond these camera distances (world units) tags / bubbles are hidden. */
const NAME_DISTANCE = 28;
const BUBBLE_DISTANCE = 45;
const BUBBLE_MIN_MS = 4_000;
const BUBBLE_MS_PER_CHAR = 70;
const BUBBLE_MAX_MS = 10_000;

interface Tag {
  el: HTMLDivElement;
  name: HTMLDivElement;
  bubble: HTMLDivElement;
  bubbleUntil: number;
  shown: boolean;
}

export interface CharacterSource {
  forEachCharacter(cb: (id: string, object: Object3D) => void): void;
}

export class NameTags {
  private readonly root: HTMLDivElement;
  private readonly tags = new Map<string, Tag>();
  private readonly seen = new Set<string>();
  private readonly v = new Vector3();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.id = 'nametags';
    parent.append(this.root);
    events.on('mp_chat', (id: string, text: string) => this.say(id, text));
    // Emitted by scene/characters.ts every frame, right after characters move.
    events.on('webgl_characters_updated', (camera: Camera, characters: CharacterSource, headHeight: number) =>
      this.update(camera, characters, headHeight),
    );
    events.on('social_names_changed', () => {
      for (const [id, tag] of this.tags) tag.name.textContent = displayName(id);
    });
  }

  private tag(id: string): Tag {
    let tag = this.tags.get(id);
    if (!tag) {
      const el = document.createElement('div');
      el.className = 'nametag';
      el.style.display = 'none'; // until update() places it
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = displayName(id);
      if (id === 'local') el.classList.add('self');
      el.append(bubble, name);
      this.root.append(el);
      tag = { el, name, bubble, bubbleUntil: 0, shown: false };
      this.tags.set(id, tag);
    }
    return tag;
  }

  private say(id: string, text: string) {
    const tag = this.tag(id);
    tag.bubble.textContent = text;
    tag.bubbleUntil = performance.now() + Math.min(BUBBLE_MAX_MS, BUBBLE_MIN_MS + [...text].length * BUBBLE_MS_PER_CHAR);
    tag.el.classList.add('talking');
  }

  /** Once per frame; `headHeight` = world units from a character's origin to just above its head. */
  update(camera: Camera, characters: CharacterSource, headHeight: number) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const now = performance.now();
    this.seen.clear();
    characters.forEachCharacter((id, object) => {
      this.seen.add(id);
      const tag = this.tag(id);
      if (tag.bubbleUntil && now >= tag.bubbleUntil) {
        tag.bubbleUntil = 0;
        tag.el.classList.remove('talking');
      }
      const distance = camera.position.distanceTo(object.position);
      const talking = tag.bubbleUntil > 0;
      let visible = distance <= (talking ? BUBBLE_DISTANCE : NAME_DISTANCE) && object.scale.y > 0.5;
      if (visible) {
        this.v.copy(object.position);
        this.v.y += headHeight;
        this.v.project(camera);
        visible = this.v.z < 1 && Math.abs(this.v.x) < 1.2 && Math.abs(this.v.y) < 1.2;
      }
      if (visible !== tag.shown) {
        tag.shown = visible;
        tag.el.style.display = visible ? '' : 'none';
      }
      if (!visible) return;
      const x = ((this.v.x + 1) / 2) * w;
      const y = ((1 - this.v.y) / 2) * h;
      tag.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      tag.el.style.opacity = String(Math.min(1, Math.max(0.35, 1.4 - distance / NAME_DISTANCE)));
      tag.el.style.zIndex = String(1000 - Math.round(distance * 10));
    });
    for (const [id, tag] of this.tags) {
      if (!this.seen.has(id)) {
        tag.el.remove();
        this.tags.delete(id);
      }
    }
  }
}
