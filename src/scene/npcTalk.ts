// NPC small talk: the existing NPCs (npcs.ts) chat with each other in speech
// bubbles (components/nametags.ts, event 'npc_say'), calm everyday lines.
//
// Each zone has its own conversations; every TALK_SLOT seconds of the shared
// clock a zone picks one (deterministic hash), so every client shows the same
// lines at the same moment. A conversation only plays when all its speakers
// are on the map (admin toggles). Separately: a few event lines (the fisher's
// catch or snapped line) and a hello to a player who walks up close (local,
// once per NPC per visit).

import type { Object3D, Vector3 } from 'three';
import { events } from '../core/events';

export type Speaker =
  | 'coupleBoy'
  | 'coupleGirl'
  | 'kiteGirl'
  | 'kiteBoy'
  | 'guitarist'
  | 'fisher'
  | 'henFeeder'
  | 'waterCarrier'
  | 'butterflyGirl'
  | 'butterflyBoy';

type Line = [Speaker, string];

/** Conversations per zone (speakers close to each other). */
const ZONES: Record<string, Line[][]> = {
  beach: [
    [
      ['coupleGirl', 'Cảnh đẹp quá anh nhỉ…'],
      ['coupleBoy', 'Ừ, ngồi nghe sóng thế này là quên hết mệt.'],
      ['coupleGirl', 'Ước gì chiều nào cũng như chiều nay.'],
    ],
    [
      ['coupleBoy', 'Gió biển mát ghê.'],
      ['coupleGirl', 'Mai mình lại ra đây ngắm hoàng hôn nhé?'],
      ['coupleBoy', 'Ừ, hẹn em đó.'],
    ],
    [
      ['coupleGirl', 'Nhìn kìa, mây trôi chậm chưa.'],
      ['coupleBoy', 'Ở đây cái gì cũng chậm, dễ chịu thật.'],
    ],
    [
      ['kiteBoy', 'Diều của tớ bay cao hơn rồi!'],
      ['kiteGirl', 'Gió đang lên đó, thả thêm dây đi!'],
      ['kiteBoy', 'Ha ha, đẹp quá trời!'],
    ],
    [
      ['kiteGirl', 'Chạy chậm thôi, kẻo vấp đó!'],
      ['kiteBoy', 'Bãi cát rộng thế này, chạy hoài không chán.'],
    ],
    [
      ['kiteGirl', 'Ê, con diều đỏ của cậu giống con cá ghê.'],
      ['kiteBoy', 'Thì nó đang bơi trên trời mà!'],
    ],
    [
      ['fisher', 'Ở đây cá nhiều thế, câu hoài không hết!'],
      ['coupleBoy', 'Câu được con nào to chưa bạn ơi?'],
      ['fisher', 'Chờ chút, phao đang động kìa!'],
    ],
    [
      ['coupleGirl', 'Bạn câu cá kia kiên nhẫn ghê.'],
      ['coupleBoy', 'Ngồi câu cả buổi chắc cũng thư giãn lắm.'],
    ],
    [
      ['fisher', 'Ngồi câu thế này thấy lòng nhẹ hẳn.'],
      ['kiteGirl', 'Lát nữa cho tớ câu thử một con nha!'],
      ['fisher', 'Được thôi, cá ở đây hiền lắm.'],
    ],
  ],
  farm: [
    [
      ['henFeeder', 'Gà ơi, ra ăn thóc nè!'],
      ['waterCarrier', 'Để tớ đổ thêm nước vào máng nhé.'],
      ['henFeeder', 'Cảm ơn nha, hôm nay gà ăn khỏe ghê.'],
    ],
    [
      ['waterCarrier', 'Nước giếng mát lạnh luôn!'],
      ['henFeeder', 'Lát nữa cho tớ rửa mặt với.'],
    ],
    [
      ['henFeeder', 'Con mái nâu lại tranh ăn rồi kìa.'],
      ['waterCarrier', 'Ha ha, đứa nào cũng háu ăn.'],
    ],
    [
      ['waterCarrier', 'Gánh nước nặng mà vui ghê.'],
      ['henFeeder', 'Ở quê, việc gì làm chậm cũng thấy vui.'],
    ],
    [
      ['henFeeder', 'Nghe gà kêu là biết sắp chiều rồi.'],
      ['waterCarrier', 'Chiều nay trời đẹp, làm xong ra biển chơi nhé!'],
      ['henFeeder', 'Ừ, rủ cả mấy bạn thả diều nữa.'],
    ],
  ],
  meadow: [
    [
      ['butterflyGirl', 'Con bướm vàng đẹp quá!'],
      ['butterflyBoy', 'Chạy nhanh lên, nó bay mất kìa!'],
      ['butterflyGirl', 'Chờ tớ với, hì hì!'],
    ],
    [
      ['butterflyBoy', 'Gần bắt được rồi… hụt mất!'],
      ['butterflyGirl', 'Bướm khôn ghê, cứ bay trước mặt mình hoài.'],
    ],
    [
      ['butterflyGirl', 'Bắt được thì mình thả nó đi nha.'],
      ['butterflyBoy', 'Ừ, để nó bay về với hoa.'],
    ],
    [
      ['butterflyBoy', 'Ở đây bướm nhiều ghê, đủ màu luôn!'],
      ['butterflyGirl', 'Con màu xanh kia kìa, đẹp nhất!'],
      ['butterflyBoy', 'Đuổi theo nó đi!'],
    ],
    [
      ['butterflyGirl', 'Chạy mệt quá, nghỉ chút đã.'],
      ['butterflyBoy', 'Gió mát thế này chạy cả ngày cũng được.'],
    ],
  ],
  road: [
    [['guitarist', 'Hát tặng mọi người một bài nhé ♪']],
    [['guitarist', 'Chiều nay êm quá, đàn thêm bài nữa ♫']],
    [['guitarist', 'Ai đi ngang thì ngồi nghe một chút nha.']],
  ],
};

/** Every slot each zone may start one conversation; lines LINE_GAP s apart. */
const TALK_SLOT = 26;
const LINE_GAP = 3.8;
/** A zone stays quiet in this share of slots (not chatting non-stop). */
const QUIET = 0.25;

const HELLO: Partial<Record<Speaker, string[]>> = {
  coupleGirl: ['Chào bạn! Ngồi ngắm biển cùng tụi mình không?'],
  kiteBoy: ['Chào cậu! Thả diều chung không?'],
  guitarist: ['Chào bạn, nghe tớ đàn một bài nha ♪'],
  fisher: ['Suỵt… nói nhỏ thôi kẻo cá chạy mất!'],
  henFeeder: ['Chào bạn! Cho gà ăn cùng tớ không?'],
  waterCarrier: ['Chào bạn! Nước giếng mát lắm đó.'],
  butterflyGirl: ['Chào bạn! Bắt bướm chung không? Bấm I đó!'],
};
/** Hello when the player comes this close (m); once per NPC per visit. */
const HELLO_RANGE = 4;

export const CATCH_LINES = ['Cá ở đây nhiều thế!', 'Lại dính một con nữa rồi!', 'Hôm nay trúng mánh ghê!', 'Con này nướng là ngon nè.'];
export const SNAP_LINES = ['Ôi, đứt dây rồi…', 'Con này khỏe quá trời!', 'Thôi, để mai câu tiếp vậy.'];

function hash01(a: number, b: number): number {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

export class NpcTalk {
  private _speakers = new Map<Speaker, Object3D>();
  /** Last line said per zone: "slot:index". */
  private _said = new Map<string, string>();
  private _greeted = new Set<Speaker>();

  set(speaker: Speaker, npc: Object3D | null) {
    if (npc) this._speakers.set(speaker, npc);
    else this._speakers.delete(speaker);
  }

  say(speaker: Speaker, text: string) {
    const npc = this._speakers.get(speaker);
    if (npc) events.emit('npc_say', `npc-talk:${speaker}`, npc, text);
  }

  /** A line from `lines` for event `n` (the same on every client). */
  pick(lines: string[], n: number): string {
    return lines[Math.floor(hash01(n, 77) * lines.length)];
  }

  /** Per frame: the zones' conversations on the shared clock, hellos near the player. */
  update(sharedTime: number, player: Vector3) {
    const slot = Math.floor(sharedTime / TALK_SLOT);
    const u = sharedTime - slot * TALK_SLOT;
    Object.entries(ZONES).forEach(([zone, talks], z) => {
      if (hash01(slot, 900 + z) < QUIET) return;
      const talk = talks[Math.floor(hash01(slot, 500 + z) * talks.length)];
      if (!talk.every(([who]) => this._speakers.has(who))) return;
      // The line due now (zones start a little apart so they don't all speak at once).
      const k = Math.floor((u - 1.5 - z * 1.3) / LINE_GAP);
      if (k < 0 || k >= talk.length) return;
      const key = `${slot}:${k}`;
      if (this._said.get(zone) === key) return;
      this._said.set(zone, key);
      this.say(...talk[k]);
    });
    // A hello to a player walking up (this client only).
    for (const [who, npc] of this._speakers) {
      if (this._greeted.has(who) || !HELLO[who]) continue;
      if (npc.position.distanceTo(player) < HELLO_RANGE) {
        this._greeted.add(who);
        this.say(who, HELLO[who]![0]);
      }
    }
  }
}
