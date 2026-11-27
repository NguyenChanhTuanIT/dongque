// Runtime scene configuration: the shape stored in Firestore (`config/scene`),
// its defaults (the values the scene shipped with), and a tolerant merge that
// keeps defaults for any field that is missing or has the wrong type.

import { DEFAULT_PRICE, SHOP_ITEMS } from '../shop/catalog';

export type Vec3 = [number, number, number];

/** Scene modules that can be switched off (reload required). */
export const TOGGLEABLE_MODULES = [
  'birds', 'trees', 'bushes', 'lightposts', 'palmtrees', 'houses', 'warehouses',
  'machines', 'rocks1', 'rocks2', 'parasols', 'castles', 'grass', 'blockers',
  'ufo', 'alien', 'sign', 'cats', 'sloth', 'gossip', 'forestCat',
] as const;
export type ToggleableModule = (typeof TOGGLEABLE_MODULES)[number];

/** Set pieces that carry a hidden secret (easter egg). */
export const SECRET_PIECES = ['ufo', 'alien', 'cats', 'sloth', 'gossip', 'forestCat'] as const;
export type SecretPiece = (typeof SECRET_PIECES)[number];

export interface SecretPieceConfig {
  /** Modal text shown when the player gets close. */
  text: string;
  /** Trigger distance in scene units. */
  distance: number;
  position: Vec3;
  /** Euler rotation in degrees. */
  rotation: Vec3;
  scale: number;
}

export interface SceneConfig {
  ui: {
    /** Loader title; line breaks become <br>. */
    loaderTitle: string;
    aboutTitle: string;
    aboutParagraphs: string[];
    congratsTitle: string;
    congratsParagraphs: string[];
  };
  features: {
    multiplayer: boolean;
    /** ws(s):// URL of the multiplayer server; empty = same host, path /mp. */
    multiplayerUrl: string;
    /** Client-side NPC groups (scene/npcs.ts), shown / hidden live. */
    npcs: {
      /** Two kids sitting arm in arm on the beach, watching the sea. */
      seaCouple: boolean;
      /** Two kids flying kites, strolling on the beach, laughing. */
      kiteFlyers: boolean;
      /** A kid playing guitar and singing at the far end of the road. */
      guitarist: boolean;
      /** A kid fishing at the end of the pier (bites, fights, catches like players). */
      fisher: boolean;
      /** A kid feeding the hens at the first chicken coop (the hens come running). */
      henFeeder: boolean;
      /** A kid carrying water on a shoulder pole between the well and the coop. */
      waterCarrier: boolean;
      /** Two kids running after butterflies with nets on the butterfly meadow by the beach. */
      butterflyKids: boolean;
    };
    modules: Record<ToggleableModule, boolean>;
  };
  player: {
    spawn: Vec3;
    spawnRadius: number;
    moveForce: number;
    jumpForce: number;
    /** Speed multiplier while sprinting (Shift / RB / full joystick); 1 = off. */
    sprintMultiplier: number;
    /** Seconds standing still before the automatic bored pose; 0 = never. */
    idleEmoteSeconds: number;
  };
  audio: {
    volume: number;
  };
  /** Final-pass grade (the toon ramp shader ignores light color/intensity). */
  lighting: {
    /** Color multiplied over the whole frame (#ffffff = none). */
    tint: string;
    /** Overall brightness multiplier (1 = original). */
    brightness: number;
    /** Strength of the original color-grading LUT (0 = off, 1 = original). */
    gradeIntensity: number;
  };
  terrain: {
    grassColor1: string;
    grassColor2: string;
  };
  secrets: Record<SecretPiece, SecretPieceConfig>;
  /** Shop (src/shop/catalog.ts): price in flowers and on/off per item id. */
  shop: {
    items: Record<string, ShopItemConfig>;
  };
}

export interface ShopItemConfig {
  /** Whole flowers; 0 = free to claim. */
  price: number;
  /** false = no longer sold (owners keep it). */
  enabled: boolean;
}

export const DEFAULT_CONFIG: SceneConfig = {
  ui: {
    loaderTitle: 'Một góc quê\nđể thư giãn',
    aboutTitle: 'Một góc quê để thư giãn',
    aboutParagraphs: [
      'Đây là một góc quê nhỏ trên mạng để bạn ghé chơi mỗi khi muốn sống chậm lại: đồng cỏ, rặng cây, bãi biển và những buổi chiều chẳng có gì phải vội.',
      'Ở đây bạn gặp những người chơi khác, trò chuyện, tặng hoa, nắm tay đi dạo hay ngồi ghế đá ngắm trời. Thích làm việc tay chân thì ra chuồng gà vãi thóc, lên cầu câu ngồi chờ phao chìm, hoặc dạo cùng các bạn nhỏ đang thả diều, gánh nước.',
      'Điểm danh mỗi ngày để nhận hoa, rồi dùng hoa đổi quần áo, cần câu hay lúa trong cửa hàng. Đâu đó vẫn còn vài bí mật nhỏ đang chờ bạn tìm ra.',
      'Không có nhiệm vụ, không có thắng thua. Chỉ cần ghé qua, đi chậm một chút, và thấy lòng nhẹ hơn khi ra về. 🌾',
    ],
    congratsTitle: 'Bạn đã tìm ra tất cả bí mật!',
    congratsParagraphs: [
      'Mong là chuyến đi tìm ấy không quá vất vả.',
      'Cảm ơn bạn đã kiên nhẫn ghé qua từng góc nhỏ. Không có phần thưởng nào lớn lao đâu, chỉ mong bạn mang theo chút bình yên của làng quê này về với một ngày bận rộn. 🌾',
    ],
  },
  features: {
    multiplayer: true,
    multiplayerUrl: '',
    npcs: { seaCouple: true, kiteFlyers: true, guitarist: true, fisher: true, henFeeder: true, waterCarrier: true, butterflyKids: true },
    modules: Object.fromEntries(TOGGLEABLE_MODULES.map((m) => [m, true])) as Record<ToggleableModule, boolean>,
  },
  player: {
    spawn: [12.2, 2.25, -58],
    spawnRadius: 4,
    moveForce: 0.005,
    jumpForce: 0.2,
    sprintMultiplier: 1.6,
    idleEmoteSeconds: 60,
  },
  audio: {
    volume: 0.25,
  },
  lighting: {
    tint: '#ffffff',
    brightness: 1,
    gradeIntensity: 1,
  },
  terrain: {
    grassColor1: '#558f6e',
    grassColor2: '#9bc2a4',
  },
  secrets: {
    ufo: {
      text: 'Một chú chó con đang ngồi chờ ai đó. Có lẽ nó cũng muốn được đi dạo cùng bạn.',
      distance: 3,
      position: [-56.9402, 2.6553, 22.7015],
      rotation: [0, 0, 0],
      scale: 1,
    },
    // The "Oiiai" cat hidden deep in the grove west of the spawn, behind the big
    // rock past the stone benches (setpieces.ts ForestCat).
    forestCat: {
      text: 'Một chú mèo mướp ngồi im lặng giữa rừng cây. Nó nhìn bạn như thể đã đợi ở đây rất lâu rồi.',
      distance: 3,
      position: [-60.5, 1.93, -64],
      rotation: [0, 120, 0],
      scale: 1,
    },
    alien: {
      text: "It's a very pale and strange looking man. He probably spends too much time on the computer.",
      distance: 3,
      position: [60.14, 0.1, 40.6],
      rotation: [-90, 87.1, 90],
      scale: 1,
    },
    cats: {
      text: "If these two white cats weren't next to each other it would seem like they were the same one.",
      distance: 2,
      position: [27.4644, 3.18224, -4.1086],
      rotation: [0, -106.078, 0],
      scale: 1,
    },
    sloth: {
      text: 'A sloth? That permanent smile it has is so creepy. What is it doing there?',
      distance: 3,
      position: [-8.38, 1.47, 46.16],
      rotation: [-30.8, -42.5, -25.7],
      scale: 0.8,
    },
    gossip: {
      text: 'These things look as if they have been taken out of a video game.',
      distance: 2,
      position: [-55.9016, 1.47639, -47.3277],
      rotation: [0, -87.0408, 0],
      scale: 1,
    },
  },
  shop: {
    items: Object.fromEntries(SHOP_ITEMS.map((it) => [it.id, { price: DEFAULT_PRICE, enabled: true }])),
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `input` onto `defaults`, accepting a value only when its type
 * matches the default's (numbers must be finite; arrays keep the default's
 * length when it is a fixed-size vector, i.e. a number array).
 */
export function mergeWithDefaults<T>(defaults: T, input: unknown): T {
  if (Array.isArray(defaults)) {
    if (!Array.isArray(input)) return structuredClone(defaults);
    const isVector = defaults.length > 0 && defaults.every((x) => typeof x === 'number');
    if (isVector) {
      if (input.length !== defaults.length || !input.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        return structuredClone(defaults);
      }
      return [...input] as T;
    }
    return input.filter((x) => typeof x === 'string') as T;
  }
  if (isPlainObject(defaults)) {
    const src = isPlainObject(input) ? input : {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(defaults)) {
      out[key] = mergeWithDefaults((defaults as Record<string, unknown>)[key], src[key]);
    }
    return out as T;
  }
  if (typeof defaults === 'number') {
    return (typeof input === 'number' && Number.isFinite(input) ? input : defaults) as T;
  }
  if (typeof defaults === typeof input) return input as T;
  return defaults;
}
