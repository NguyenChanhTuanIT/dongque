// Player character controls: keyboard (WASD/arrows/space, Shift sprint,
// E / 1..9 / 0 Q H C M emotes), mouse drag, touch joystick (the on-screen circles UI; full push
// sprints), tap/double-tap jump, gamepad (stick, A jump, RB/L3 sprint, Y emote).
// Port of the original `controls` + `circles` classes.

import { Group, Mesh, PlaneGeometry, ShaderMaterial, Vector2, Vector3 } from 'three';
import { gsap } from 'gsap';
import { ticker } from '../core/ticker';
import { ease, fit, lerpCoefFPS, lerpFPS, smoothstep } from '../core/math';
import { events } from '../core/events';
import { client } from '../core/client';
import { textureLoader } from './loaders/textures';
import { globalUBO, globalUniforms } from './globals';
import { type Touch } from './input';
import type { CharacterInstance } from './characters';
import { globalUBODeclaration } from '../scene/materials';
import blendmodesGLSL from '../scene/glsl/blendmodes.glsl?raw';

// ---------------------------------------------------------------------------
// The "circles" UI, an on-screen joystick rendered with a custom shader
// ---------------------------------------------------------------------------


const planeGeometry = new PlaneGeometry();

/**
 * On-screen sizes in CSS pixels. The shaders used to size the circles from the
 * canvas resolution, which follows the adaptive DPR, so on phones (low DPR) the
 * joystick grew to ~320px, nearly the whole screen width.
 */
const MOVE_CIRCLE_CSS = 150;
const JUMP_CIRCLE_CSS = 110;
/** UV offset of the inner knob at full deflection (see the move shader). */
const KNOB_TRAVEL = 0.35;
/** Finger drag (CSS px) for full deflection: matches the knob's on-screen travel. */
const TOUCH_FULL_DRAG = Math.round(MOVE_CIRCLE_CSS * KNOB_TRAVEL);

/** Device pixels per CSS pixel of the canvas (tracks the adaptive DPR). */
const canvasDpr = () => globalUniforms.resolution.value.y / Math.max(1, client.screen.h);

export class Circles extends Group {
  moveCircle!: Mesh;
  jumpCircle!: Mesh;
  readonly isCharacterControls = true;

  private _touchPosition = new Vector2();
  private _touchActive = 0;
  private _jumpAnimVar = { value: 0 };

  constructor() {
    super();
    this.name = 'PlayerControls UI';
    this._createMoveCircle();
    this._createJumpCircle();
  }

  private _createMoveCircle() {
    const material = new ShaderMaterial({
      uniformsGroups: [globalUBO],
      uniforms: {
        tCircles: { value: textureLoader.load('controls/circles.png') },
        uInnerPos: { value: new Vector2() },
        uScale: { value: 1 },
        uSize: { value: MOVE_CIRCLE_CSS },
        uAlpha: { value: 1 },
      },
      vertexShader: `
        ${globalUBODeclaration}
        uniform float uScale;
        uniform float uSize; // diameter in device pixels
        varying vec2 vUv;

        void main() {
          vUv = uv;
          vec3 pos = position;
          pos.x /= resolution.x / resolution.y;
          pos /= resolution.y / (2.0 * uSize * uScale);
          gl_Position = modelMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        ${blendmodesGLSL}
        uniform sampler2D tCircles;
        uniform vec2 uInnerPos;
        uniform float uAlpha;
        varying vec2 vUv;

        void main() {
          vec2 bg = texture2D(tCircles, vUv).rg;
          vec4 color = vec4(vec3(mix(vec3(0.0), vec3(1.0), bg.x)), bg.y);
          vec2 inner = texture2D(tCircles, vUv + uInnerPos).ba;
          color.rgb = blendScreen(color.rgb, vec3(mix(vec3(0.0), vec3(1.0), inner.x)));
          color.a = max(color.a, inner.y);
          gl_FragColor = color;
          gl_FragColor.a *= uAlpha;
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.moveCircle = new Mesh(planeGeometry, material);
    this.moveCircle.name = 'Move Circle';
    this.moveCircle.frustumCulled = false;
    this.moveCircle.renderOrder = 99999;
    this.moveCircle.castShadow = false;
    this.moveCircle.receiveShadow = false;
    this.moveCircle.visible = false;
    this.add(this.moveCircle);
  }

  private _createJumpCircle() {
    const material = new ShaderMaterial({
      uniformsGroups: [globalUBO],
      uniforms: {
        uScale: { value: 1 },
        uSize: { value: JUMP_CIRCLE_CSS },
        uAlpha: { value: 1 },
      },
      vertexShader: `
        ${globalUBODeclaration}
        uniform float uScale;
        uniform float uSize; // diameter in device pixels
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 pos = position;
          pos.x /= resolution.x / resolution.y;
          pos /= resolution.y / (2.0 * uSize * uScale);
          gl_Position = modelMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uAlpha;
        varying vec2 vUv;

        void main() {
          float dist = length(vUv - 0.5);
          float margin = fwidth(vUv.x);
          float d = smoothstep(0.4 + margin, 0.4, dist);

          gl_FragColor.rgb = vec3(1.0);
          gl_FragColor.a = 0.15 * d * uAlpha;
        }
      `,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    });
    this.jumpCircle = new Mesh(planeGeometry, material);
    this.jumpCircle.name = 'Jump Circle';
    this.jumpCircle.frustumCulled = false;
    this.jumpCircle.renderOrder = 99999;
    this.jumpCircle.castShadow = false;
    this.jumpCircle.receiveShadow = false;
    this.jumpCircle.visible = false;
    this.add(this.jumpCircle);
  }

  /** Called every frame by the controls. */
  update(touchDelta: Vector2, touching: boolean) {
    const move = this.moveCircle.material as ShaderMaterial;
    const jump = this.jumpCircle.material as ShaderMaterial;
    this._touchActive = touching ? 1 : lerpFPS(this._touchActive, 0, 0.25);
    if (!touching && this._touchActive < 0.001) this._touchActive = 0;
    this._touchPosition.lerp(touchDelta, lerpCoefFPS(0.2));
    const dpr = canvasDpr();
    move.uniforms.uSize.value = MOVE_CIRCLE_CSS * dpr;
    jump.uniforms.uSize.value = JUMP_CIRCLE_CSS * dpr;
    move.uniforms.uInnerPos.value.copy(this._touchPosition).multiplyScalar(KNOB_TRAVEL);
    move.uniforms.uInnerPos.value.y *= -1;
    this.moveCircle.visible = this._touchActive !== 0;
    move.uniforms.uScale.value = fit(this._touchActive, 0, 1, 0.75, 1);
    move.uniforms.uAlpha.value = ease(this._touchActive, 'power3.out');
    this.jumpCircle.visible = this._jumpAnimVar.value > 0;
    jump.uniforms.uScale.value = 1 - this._jumpAnimVar.value;
    jump.uniforms.uAlpha.value = ease(this._jumpAnimVar.value, 'power3.out');
  }

  /** Jump pulse at a screen position (second-finger tap). */
  animateJump(touch: Touch) {
    this.jumpCircle.position.x = touch.position11.x;
    this.jumpCircle.position.y = touch.position11.y;
    this.jumpCircle.visible = true;
    this._jumpAnimVar.value = 1;
    gsap.to(this._jumpAnimVar, {
      value: 0,
      duration: 0.5,
      ease: 'power2.out',
    });
  }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Default emote keys (KeyboardEvent.code → slot) until setEmoteKeys() gives the menu order. */
const DEFAULT_EMOTE_KEYS: Record<string, number> = { Digit0: 10, KeyQ: 11, KeyH: 12, KeyC: 13, KeyM: 14 };

/** Key label ('V', '2'…) → KeyboardEvent.code. */
const keyCode = (key: string) => (/^[0-9]$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`);

export interface ControlsOptions {
  mouseCenter?: Vector2;
  mouseToggleCb?: (active: boolean) => void;
  controlTouchAmount?: number;
  controlMouseAmount?: number;
}

export class Controls {
  readonly circles: Circles;

  private _characters: CharacterInstance;
  private _moveKeysPressed = [false, false, false, false];
  private _jumpKeyLocked = false;
  private _jumpRequestGamepad = false;
  private _isDragging = false;
  private _isTouching = false;
  private _touchDelta = new Vector2();
  private _mouseCenter: Vector2;
  private _mouseToggleCb: ((active: boolean) => void) | undefined;
  private _mouseRightButtonTime = 0;
  private _controlTouchAmount: number;
  private _controlMouseAmount: number;
  private _browserActive = validFocus();
  private _enabled = false;
  private _v = new Vector3();
  private _sprintKey = false;
  private _sprintMultiplier = 1.6;
  private _emoteGamepadLatch = false;
  /** KeyboardEvent.code → emote slot (1-based); WASD / E / Space stay reserved. */
  private _emoteKeys: Record<string, number> = { ...DEFAULT_EMOTE_KEYS };
  /** True while the player holds a sprint input and is moving (read by the engine). */
  sprinting = false;

  constructor(characters: CharacterInstance, options: ControlsOptions = {}) {
    this._characters = characters;
    this._mouseCenter = options.mouseCenter ?? new Vector2(0, -0.45);
    this._mouseToggleCb = options.mouseToggleCb;
    this._controlTouchAmount = options.controlTouchAmount ?? TOUCH_FULL_DRAG;
    this._controlMouseAmount = options.controlMouseAmount ?? 200;
    this.circles = new Circles();
  }

  private _onActiveChange = () => {
    this._browserActive = validFocus();
    if (!this._browserActive) this._endInteraction();
  };

  private _onKey = (e: KeyboardEvent) => {
    const down = e.type === 'keydown';
    switch (e.code) {
      case 'KeyW':
      case 'ArrowUp':
        this._moveKeysPressed[0] = down;
        break;
      case 'KeyS':
      case 'ArrowDown':
        this._moveKeysPressed[1] = down;
        break;
      case 'KeyA':
      case 'ArrowLeft':
        this._moveKeysPressed[2] = down;
        break;
      case 'KeyD':
      case 'ArrowRight':
        this._moveKeysPressed[3] = down;
        break;
      case 'Space':
        this._requestJump(down);
        break;
      case 'ShiftLeft':
      case 'ShiftRight':
        this._sprintKey = down;
        break;
      case 'KeyE':
        if (down && !e.repeat) events.emit('webgl_character_emote', 1);
        break;
      default: {
        // Emote slots (scene/emotes.ts EMOTES order, see setEmoteKeys).
        if (!down || e.repeat) break;
        const slot = this._emoteKeys[e.code] ?? (/^Digit[1-9]$/.test(e.code) ? Number(e.code.slice(5)) : undefined);
        if (slot) events.emit('webgl_character_emote', slot);
      }
    }
  };

  /** Emote key labels in slot order (slot n = keys[n - 1]). */
  setEmoteKeys(keys: readonly string[]) {
    const reserved = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyE']);
    this._emoteKeys = {};
    keys.forEach((key, i) => {
      if (!key) return; // menu only
      const code = keyCode(key);
      if (!reserved.has(code)) this._emoteKeys[code] = i + 1;
    });
  }

  /** Move-force multiplier while sprinting (1 = sprint disabled). */
  setSprintMultiplier(multiplier: number) {
    this._sprintMultiplier = Math.max(1, multiplier);
  }

  private _requestJump(down: boolean) {
    if (down) {
      if (this._jumpKeyLocked) return;
      this._jumpKeyLocked = true;
      this._characters._localObject.jumpRequested = true;
      setTimeout(() => {
        this._characters._localObject.jumpRequested = false;
      }, 75);
    } else {
      this._jumpKeyLocked = false;
    }
  }

  private _onTouchStart = (e: Touch) => {
    if (!validInitialEvent(e)) return;
    if (e.currentInput === 'mouse') {
      this._mouseToggleCb?.(true);
    } else {
      this._isTouching = true;
      this.circles.moveCircle.position.x = e.position11.x;
      this.circles.moveCircle.position.y = e.position11.y;
    }
    this._isDragging = true;
    this._onTouchDrag(e);
  };

  private _onTouchDrag = (e: Touch) => {
    if (!this._isDragging) return;
    if (e.currentInput === 'mouse') {
      this._touchDelta.copy(e.position11).sub(this._mouseCenter);
      this._touchDelta.x *= -client.screen.w * 0.5;
      this._touchDelta.y *= client.screen.h * 0.5;
      this._touchDelta.divideScalar(this._controlMouseAmount).clampLength(-1, 1);
    } else {
      this._touchDelta.set(-e.dragged.x, -e.dragged.y).divideScalar(this._controlTouchAmount).clampLength(-1, 1);
    }
  };

  private _onTouchEnd = () => {
    this._isTouching = false;
    this._isDragging = false;
    this._mouseToggleCb?.(false);
    this._touchDelta.setScalar(0);
  };

  private _onTouchClick = (e: Touch) => {
    if (e.currentInput === 'mouse') return;
    this._requestJump(true);
    this._requestJump(false);
    if (e.finger !== 0) this.circles.animateJump(e);
  };

  private _onMouseDown = (e: MouseEvent) => {
    if (e.button === 2) this._mouseRightButtonTime = ticker.time;
  };

  private _onMouseUp = (e: MouseEvent) => {
    if (e.button === 2 && Math.max(0.001, ticker.time - this._mouseRightButtonTime) < 0.5) {
      this._requestJump(true);
      this._requestJump(false);
    }
  };

  /** Compute the current move input vector (called each physics frame). */
  update(): Vector3 {
    this.circles.update(this._touchDelta, this._isTouching);
    this._v.setScalar(0);
    if (!this._browserActive) return this._v;

    if (this._moveKeysPressed.includes(true)) {
      if (this._moveKeysPressed[0]) this._v.z += 1;
      if (this._moveKeysPressed[1]) this._v.z -= 1;
      if (this._moveKeysPressed[2]) this._v.x += 1;
      if (this._moveKeysPressed[3]) this._v.x -= 1;
      this._v.normalize();
    }
    this._v.x += this._touchDelta.x;
    this._v.z += this._touchDelta.y;

    const pad = navigator.getGamepads?.()[0];
    let padSprint = false;
    if (this._enabled && pad) {
      if (pad.axes.length > 0) {
        this._v.x += gamepadAxisNormalize(pad.axes[0], -1);
        this._v.z += gamepadAxisNormalize(pad.axes[1], -1);
      }
      if (pad.buttons[0]?.pressed) {
        this._jumpRequestGamepad = true;
        this._requestJump(true);
      } else if (this._jumpRequestGamepad) {
        this._jumpRequestGamepad = false;
        this._requestJump(false);
      }
      // RB / R1 or left-stick click sprints; Y / △ toggles the emote.
      padSprint = Boolean(pad.buttons[5]?.pressed || pad.buttons[10]?.pressed);
      const emote = Boolean(pad.buttons[3]?.pressed);
      if (emote && !this._emoteGamepadLatch) events.emit('webgl_character_emote', 1);
      this._emoteGamepadLatch = emote;
    }

    this._v.clampLength(-1, 1);
    // Touch: pushing the joystick to the rim sprints.
    const touchSprint = this._isTouching && this._touchDelta.length() > 0.97;
    this.sprinting =
      this._sprintMultiplier > 1 &&
      (this._sprintKey || padSprint || touchSprint) &&
      this._v.lengthSq() > 1e-6;
    return this.sprinting ? this._v.multiplyScalar(this._sprintMultiplier) : this._v;
  }

  private _endInteraction() {
    this._moveKeysPressed.fill(false);
    this._sprintKey = false;
    this.sprinting = false;
    this._requestJump(false);
    this._jumpRequestGamepad = false;
    this._onTouchEnd();
  }

  enable(interactionNode: HTMLElement = document.body) {
    if (this._enabled) return;
    this._enabled = true;
    this._browserActive = validFocus();
    if (interactionNode) {
      interactionNode.addEventListener('mousedown', this._onMouseDown);
      interactionNode.addEventListener('mouseup', this._onMouseUp);
      interactionNode.addEventListener('mouseout', this._onMouseUp);
    }
    events.on('keydown', this._onKey);
    events.on('keyup', this._onKey);
    events.on('touch_start', this._onTouchStart);
    events.on('touch_drag', this._onTouchDrag);
    events.on('touch_end', this._onTouchEnd);
    events.on('touch_click', this._onTouchClick);
    events.on('touch2_click', this._onTouchClick);
    events.on('visibility_change', this._onActiveChange);
    events.on('focus_change', this._onActiveChange);
  }

  disable(interactionNode: HTMLElement = document.body) {
    if (!this._enabled) return;
    this._enabled = false;
    if (interactionNode) {
      interactionNode.removeEventListener('mousedown', this._onMouseDown);
      interactionNode.removeEventListener('mouseup', this._onMouseUp);
      interactionNode.removeEventListener('mouseout', this._onMouseUp);
    }
    events.off('keydown', this._onKey);
    events.off('keyup', this._onKey);
    events.off('touch_start', this._onTouchStart);
    events.off('touch_drag', this._onTouchDrag);
    events.off('touch_end', this._onTouchEnd);
    events.off('touch_click', this._onTouchClick);
    events.off('touch2_click', this._onTouchClick);
    events.off('visibility_change', this._onActiveChange);
    events.off('focus_change', this._onActiveChange);
    this._endInteraction();
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function validInitialEvent(e: Touch): boolean {
  return (
    (e.currentInput === 'mouse' && e.button === 0) ||
    (e.currentInput === 'touch' && e.finger === 0)
  );
}

function gamepadAxisNormalize(value: number, direction: number): number {
  return value * smoothstep(0.15, 0.25, Math.abs(value)) * direction;
}

function validFocus(): boolean {
  return client.device === 'desktop' ? client.visible && client.focused : client.visible;
}
