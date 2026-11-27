// Playing together. Two kinds of things:
//
// 1. Sitting side by side (no network logic): when two players sit cross-legged
//    next to each other, or on the two seats of a stone bench, every client
//    shows them with an arm around each other (a local display pose,
//    userData.pose, see engine/characters.ts).
//
// 2. Invitations through the relay (server/realm.mjs SOCIAL): the player picks
//    an activity in the emote menu, it goes to the nearest player, who sees an
//    invitation (a line with two buttons in the chat box) and accepts or declines. The relay checks the invitation and
//    confirms the acceptance to both, then each client plays its part:
//      flower      the giver holds a flower out; the receiver then carries it
//      ice cream   same with an ice cream (the giver needs the ice cream item)
//      hand in hand the inviter leads (walks freely), the partner walks at its
//                  right side, holding hands; moving yourself lets go
//      dance       face to face, hands joined, in step on the shared clock
//    Ending: moving / another emote ends it on that side, and an END message
//    (or seeing the partner's pose gone for a while) ends it on the other.

import { CanvasTexture, Raycaster, Sprite, SpriteMaterial, Vector3, type Mesh, type Object3D } from 'three';
import { gsap } from 'gsap';
import { events } from '../core/events';
import type { Characters } from '../engine/characters';
import { canUseEmote } from '../shop/inventory';
import { displayName } from '../social/presence';
import {
  BENCH_SIT_STATE,
  HAND_GAP,
  HAND_LEFT_STATE,
  HAND_RIGHT_STATE,
  HOLD_FLOWER_STATE,
  ICECREAM_STATE,
  OFFER_FLOWER_STATE,
  OFFER_ICECREAM_STATE,
  PAIR_DANCE_GAP,
  PAIR_DANCE_STATE,
  PAIR_POSES,
  TREAT_ICECREAM_STATE,
} from './emotes';

/** Relay message kinds (server/realm.mjs SOCIAL_*). */
const KIND = { invite: 1, accept: 2, decline: 3, end: 4, cancel: 5 } as const;
/** Activities (server/realm.mjs: 2 = ice cream is checked). */
const FLOWER = 1;
const ICECREAM = 2;
const HANDS = 3;
const DANCE = 4;
/** Menu entry (its animation state) → activity. */
const MENU: Record<number, number> = {
  [OFFER_FLOWER_STATE]: FLOWER,
  [OFFER_ICECREAM_STATE]: ICECREAM,
  [HAND_RIGHT_STATE]: HANDS,
  [PAIR_DANCE_STATE]: DANCE,
};
/** Text for HTML (player names are user input). */
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const INVITE_TEXT: Record<number, string> = {
  [FLOWER]: 'muốn tặng bạn một bông hoa',
  [ICECREAM]: 'mời bạn ăn kem',
  [HANDS]: 'rủ bạn nắm tay đi dạo',
  [DANCE]: 'mời bạn nhảy đôi',
};
const ACTIVITY_NAME: Record<number, string> = {
  [FLOWER]: 'tặng hoa',
  [ICECREAM]: 'mời ăn kem',
  [HANDS]: 'nắm tay đi dạo',
  [DANCE]: 'nhảy đôi',
};
/** Invite the nearest player within this distance (the relay allows 8). */
const INVITE_RANGE = 4;
const INVITE_TIMEOUT = 25;
/** How long a received gift stays in the hand (seconds). */
const GIFT_SECONDS = 60;
/** The partner's pose may be missing this long (network hiccup) before we stop. */
const PARTNER_GRACE = 2.5;
/** Sitting side by side: partners closer than this (and not on top of each other). */
const PAIR_MAX = 0.95;
const PAIR_MIN = 0.25;
const SIT_CROSS_LEGGED = 6;

const UP = new Vector3(0, 1, 0);
const now = () => performance.now() / 1000;

interface Partner {
  id: string;
  activity: number;
  /** The animation state we play while together. */
  myState: number;
  /** The one the partner should show. */
  theirState: number;
  /** Since when the partner's pose is missing (0 = present). */
  lostAt: number;
}

function heartTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.font = '84px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('💞', 64, 70);
  return new CanvasTexture(canvas);
}

export class Together {
  private _outgoing: { target: string; activity: number; at: number } | null = null;
  private _incoming: { from: string; activity: number; at: number } | null = null;
  /** We pressed "accept" and wait for the relay's confirmation. */
  private _accepting: { from: string; activity: number } | null = null;
  private _partner: Partner | null = null;
  private _heart: CanvasTexture | null = null;
  private _rc = new Raycaster();
  private _v = new Vector3();
  private _v2 = new Vector3();
  private _target = new Vector3();

  constructor(private _scene: Object3D, private _characters: Characters) {
    (this._rc as any).firstHitOnly = true;
    _characters.emoteInterceptors.push(this._onEmote);
    _characters.onDriveBreak = () => this._end(true);
    events.on('mp_social', this._onSocial);
    events.on('mp_disconnected', () => {
      this._outgoing = this._incoming = this._accepting = null;
      this._end(false);
      this._renderPrompt();
    });
    // The invitation is a line of the chat box with its two buttons (chat.ts).
    events.on('together_answer', (answer: string) => this._answer(answer === 'yes'));
  }

  // ---------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------

  private get _local() {
    return this._characters.local;
  }

  private _find(id: string): Object3D | null {
    let found: Object3D | null = null;
    this._characters.forEachCharacter((cid, obj) => {
      if (cid === id) found = obj;
    });
    return found;
  }

  private _nearest(range: number): { id: string; obj: Object3D } | null {
    const p = this._local.position;
    let best: { id: string; obj: Object3D } | null = null;
    let bestD = range;
    this._characters.forEachCharacter((id, obj) => {
      if (id === 'local') return;
      const d = obj.position.distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = { id, obj };
      }
    });
    return best;
  }

  private _send(kind: number, id: string, activity: number) {
    events.emit('mp_social_send', kind, id, activity);
  }

  private _hint(text: string) {
    events.emit('game_hint', text);
  }

  private _setState(state: number) {
    this._local.userData.a = state;
  }

  // ---------------------------------------------------------------------------
  // Inviting (emote menu)
  // ---------------------------------------------------------------------------

  private _onEmote = (state: number): boolean => {
    const activity = MENU[state];
    if (!activity) return false;
    // The same entry again stops / withdraws.
    if (this._partner?.activity === activity) {
      this._end(true);
      return true;
    }
    if (this._outgoing?.activity === activity) {
      this._cancelOutgoing();
      return true;
    }
    if (!this._characters.selfId) {
      this._hint('Cần kết nối máy chủ để chơi cùng bạn khác.');
      return true;
    }
    if (activity === ICECREAM && !canUseEmote(ICECREAM_STATE)) {
      events.emit('webgl_emote_locked', ICECREAM_STATE);
      return true;
    }
    if (this._local.userData.a === 1) return true; // airborne
    const target = this._nearest(INVITE_RANGE);
    if (!target) {
      this._hint(`Không có ai ở gần (trong ${INVITE_RANGE} m) để ${ACTIVITY_NAME[activity]}.`);
      return true;
    }
    this._end(true);
    if (this._outgoing) this._cancelOutgoing();
    this._characters.leaveSeat();
    this._characters.faceTowards(target.obj.position.x, target.obj.position.z);
    this._send(KIND.invite, target.id, activity);
    this._outgoing = { target: target.id, activity, at: now() };
    if (activity === FLOWER) this._setState(OFFER_FLOWER_STATE);
    else if (activity === ICECREAM) this._setState(OFFER_ICECREAM_STATE);
    this._hint(`Đã rủ ${displayName(target.id)} ${ACTIVITY_NAME[activity]}, chờ bạn ấy trả lời…`);
    return true;
  };

  private _cancelOutgoing(notify = true) {
    const out = this._outgoing;
    if (!out) return;
    this._outgoing = null;
    if (notify) this._send(KIND.cancel, out.target, out.activity);
    const a = this._local.userData.a;
    if (a === OFFER_FLOWER_STATE || a === OFFER_ICECREAM_STATE) this._setState(0);
  }

  // ---------------------------------------------------------------------------
  // Relay messages
  // ---------------------------------------------------------------------------

  private _onSocial = (kind: number, id: string, activity: number) => {
    if (kind === KIND.invite) {
      this._incoming = { from: id, activity, at: now() };
      this._renderPrompt();
    } else if (kind === KIND.accept) {
      if (this._outgoing && this._outgoing.target === id && this._outgoing.activity === activity) {
        this._outgoing = null;
        this._start(activity, id, true);
      } else if (this._accepting && this._accepting.from === id && this._accepting.activity === activity) {
        this._accepting = null;
        this._start(activity, id, false);
      }
    } else if (kind === KIND.decline) {
      if (this._outgoing?.target === id) {
        this._cancelOutgoing(false);
        this._hint(`${displayName(id)} đã từ chối lời rủ ${ACTIVITY_NAME[activity]}.`);
      }
    } else if (kind === KIND.cancel) {
      if (this._incoming?.from === id) {
        this._incoming = null;
        this._renderPrompt();
      }
    } else if (kind === KIND.end) {
      if (this._partner?.id === id) this._end(false);
    }
  };

  /** The prompt's buttons. */
  private _answer(yes: boolean) {
    const inc = this._incoming;
    if (!inc) return;
    this._incoming = null;
    this._renderPrompt();
    if (yes) {
      this._accepting = { from: inc.from, activity: inc.activity };
      this._send(KIND.accept, inc.from, inc.activity);
    } else {
      this._send(KIND.decline, inc.from, inc.activity);
    }
  }

  /** The invitation as a chat line (chat.ts `chat_action`), gone once answered or expired. */
  private _renderPrompt() {
    const inc = this._incoming;
    if (!inc) {
      events.emit('chat_action', 'together', '');
      return;
    }
    const gift = inc.activity === FLOWER || inc.activity === ICECREAM;
    const html =
      `<span>💞 <b>${escapeHtml(displayName(inc.from))}</b> ${escapeHtml(INVITE_TEXT[inc.activity])}</span>` +
      `<button type="button" class="primary" data-emit="together_answer" data-arg="yes">${gift ? 'Nhận' : 'Đồng ý'}</button>` +
      `<button type="button" data-emit="together_answer" data-arg="no">Thôi</button>`;
    events.emit('chat_action', 'together', html);
  }

  // ---------------------------------------------------------------------------
  // Together
  // ---------------------------------------------------------------------------

  /** Both sides got the relay's confirmation: play our part. */
  private _start(activity: number, otherId: string, inviter: boolean) {
    const other = this._find(otherId);
    const chars = this._characters;
    const local = this._local;
    if (other) this._celebrate(this._v.addVectors(local.position, other.position).multiplyScalar(0.5));
    const name = displayName(otherId);
    if (activity === FLOWER || activity === ICECREAM) {
      if (inviter) {
        this._setState(0);
        this._hint(activity === FLOWER ? `${name} đã nhận hoa của bạn 🌸` : `${name} đã nhận kem của bạn 🍦`);
      } else {
        chars.leaveSeat();
        this._setState(activity === FLOWER ? HOLD_FLOWER_STATE : TREAT_ICECREAM_STATE);
        chars.endEmoteIn(GIFT_SECONDS);
        if (other) chars.faceTowards(other.position.x, other.position.z);
      }
      return;
    }
    if (!other) return;
    this._end(true);
    if (activity === HANDS) {
      chars.leaveSeat();
      // The inviter leads; the partner walks at its right side.
      const myState = inviter ? HAND_RIGHT_STATE : HAND_LEFT_STATE;
      this._partner = { id: otherId, activity, myState, theirState: inviter ? HAND_LEFT_STATE : HAND_RIGHT_STATE, lostAt: 0 };
      this._setState(myState);
      this._hint(inviter ? `Đang nắm tay ${name}. Cứ đi, bạn ấy sẽ đi cùng.` : `Đang nắm tay ${name}. Di chuyển để buông tay.`);
      return;
    }
    // Dance: the inviter stays, the partner steps in front of it.
    const inviterPos = inviter ? local.position : other.position;
    const partnerPos = inviter ? other.position : local.position;
    const dir = this._v2.subVectors(partnerPos, inviterPos).setY(0);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1).applyQuaternion(inviter ? local.quaternion : other.quaternion).setY(0);
    dir.normalize();
    const spot = inviter ? local.position.clone() : inviterPos.clone().addScaledVector(dir, PAIR_DANCE_GAP).setY(local.position.y);
    const face = inviter ? dir : dir.clone().negate();
    chars.seatAt(spot, face.x, face.z, PAIR_DANCE_STATE, spot);
    this._partner = { id: otherId, activity, myState: PAIR_DANCE_STATE, theirState: PAIR_DANCE_STATE, lostAt: 0 };
    this._hint(`Đang nhảy đôi với ${name}. Di chuyển để dừng.`);
  }

  /** Stop playing together (notify = tell the partner). */
  private _end(notify: boolean) {
    const p = this._partner;
    if (!p) return;
    this._partner = null;
    if (notify) this._send(KIND.end, p.id, p.activity);
    if (this._characters.driving) this._characters.setDrive(null);
    if (this._characters.seated && this._local.userData.a === p.myState) this._characters.leaveSeat();
    if (this._local.userData.a === p.myState) this._setState(0);
  }

  private _ground(x: number, y: number, z: number): number {
    const collider = (this._characters as any)._collisionPhysics?.collider as Mesh | undefined;
    if (!collider) return y;
    this._rc.set(this._v.set(x, y + 1.5, z), this._v2.set(0, -1, 0));
    this._rc.far = 3.5;
    return this._rc.intersectObject(collider, false)[0]?.point.y ?? y;
  }

  /** Per frame, after the characters updated. */
  update() {
    const t = now();
    // Invitations time out.
    if (this._outgoing && t - this._outgoing.at > INVITE_TIMEOUT) {
      const target = this._outgoing.target;
      this._cancelOutgoing();
      this._hint(`${displayName(target)} chưa trả lời, đã huỷ lời rủ.`);
    }
    if (this._incoming && t - this._incoming.at > INVITE_TIMEOUT) {
      this._incoming = null;
      this._renderPrompt();
    }
    // A gift offer ends when we do something else.
    const out = this._outgoing;
    if (out && (out.activity === FLOWER || out.activity === ICECREAM)) {
      const offering = out.activity === FLOWER ? OFFER_FLOWER_STATE : OFFER_ICECREAM_STATE;
      if (this._local.userData.a !== offering) this._cancelOutgoing();
    }
    this._updatePartner(t);
    this._updatePairPoses();
  }

  private _updatePartner(t: number) {
    const p = this._partner;
    if (!p) return;
    if (this._local.userData.a !== p.myState) return this._end(true);
    const other = this._find(p.id);
    if (!other) return this._end(false);
    if ((other.userData as { a?: number }).a !== p.theirState) {
      if (!p.lostAt) p.lostAt = t;
      else if (t - p.lostAt > PARTNER_GRACE) return this._end(true);
    } else p.lostAt = 0;
    if (p.myState === HAND_LEFT_STATE && p.lostAt === 0) {
      // Walk at the leader's right side, facing where it faces.
      const right = this._v.set(-1, 0, 0).applyQuaternion(other.quaternion).setY(0).normalize();
      const forward = this._v2.set(0, 0, 1).applyQuaternion(other.quaternion).setY(0).normalize();
      this._target.copy(other.position).addScaledVector(right, HAND_GAP);
      this._target.y = this._ground(this._target.x, other.position.y, this._target.z);
      if (this._target.distanceTo(this._local.position) > 6) this._characters.snap(this._target.toArray());
      this._characters.setDrive(this._target, forward.x, forward.z);
    }
  }

  /** Arm around the partner for players sitting side by side. */
  private _updatePairPoses() {
    const sitters: Array<{ obj: Object3D; a: number }> = [];
    this._characters.forEachCharacter((_, obj) => {
      const ud = obj.userData as { a?: number; pose?: number };
      if (ud.a === SIT_CROSS_LEGGED || ud.a === BENCH_SIT_STATE) sitters.push({ obj, a: ud.a });
      else if (ud.pose !== undefined) delete ud.pose;
    });
    for (const me of sitters) {
      const right = this._v.set(-1, 0, 0).applyQuaternion(me.obj.quaternion);
      const forward = this._v2.set(0, 0, 1).applyQuaternion(me.obj.quaternion);
      let best: Object3D | null = null;
      let bestD = PAIR_MAX;
      let side = 0;
      for (const other of sitters) {
        if (other === me || other.a !== me.a) continue;
        const d = this._target.subVectors(other.obj.position, me.obj.position);
        if (Math.abs(d.y) > 0.4) continue;
        d.y = 0;
        const dist = d.length();
        if (dist < PAIR_MIN || dist >= bestD) continue;
        const lateral = d.dot(right);
        const otherForward = new Vector3(0, 0, 1).applyQuaternion(other.obj.quaternion);
        if (Math.abs(lateral) < 0.7 * dist || otherForward.dot(forward) < 0.6) continue;
        best = other.obj;
        bestD = dist;
        side = lateral > 0 ? 1 : -1; // +1: the partner is on the right
      }
      const ud = me.obj.userData as { pose?: number };
      if (!best) delete ud.pose;
      else if (me.a === BENCH_SIT_STATE) ud.pose = side > 0 ? PAIR_POSES.benchArmR : PAIR_POSES.benchArmL;
      else ud.pose = side > 0 ? PAIR_POSES.sitArmR : PAIR_POSES.sitArmL;
    }
  }

  /** 💞 between the two. */
  private _celebrate(at: Vector3) {
    this._heart ??= heartTexture();
    const material = new SpriteMaterial({ map: this._heart, transparent: true, depthWrite: false });
    const sprite = new Sprite(material);
    sprite.position.copy(at).addScaledVector(UP, 1.8);
    sprite.scale.setScalar(0.01);
    sprite.renderOrder = 10;
    this._scene.add(sprite);
    events.emit('webgl_audio_play_sound', 'click1');
    gsap.to(sprite.scale, { x: 0.8, y: 0.8, z: 0.8, duration: 0.35, ease: 'back.out(2.5)' });
    gsap.to(sprite.position, { y: sprite.position.y + 0.6, duration: 1.4, ease: 'power1.out' });
    gsap.to(material, {
      opacity: 0,
      delay: 0.9,
      duration: 0.5,
      onComplete: () => {
        this._scene.remove(sprite);
        material.dispose();
      },
    });
  }
}
