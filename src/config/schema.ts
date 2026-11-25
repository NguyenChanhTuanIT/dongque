// Runtime scene configuration: the shape stored in Firestore (`config/scene`),
// its defaults (the values the scene shipped with), and a tolerant merge that
// keeps defaults for any field that is missing or has the wrong type.

export type Vec3 = [number, number, number];

/** Scene modules that can be switched off (reload required). */
export const TOGGLEABLE_MODULES = [
  'birds', 'trees', 'bushes', 'lightposts', 'palmtrees', 'houses', 'warehouses',
  'machines', 'rocks1', 'rocks2', 'parasols', 'castles', 'grass', 'blockers',
  'ufo', 'alien', 'sign', 'cats', 'sloth', 'gossip',
] as const;
export type ToggleableModule = (typeof TOGGLEABLE_MODULES)[number];

/** Set pieces that carry a hidden secret (easter egg). */
export const SECRET_PIECES = ['ufo', 'alien', 'cats', 'sloth', 'gossip'] as const;
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
}

export const DEFAULT_CONFIG: SceneConfig = {
  ui: {
    loaderTitle: 'Summer\nAfternoon',
    aboutTitle: 'SummerTime',
    aboutParagraphs: [
      'This is a web experiment I made to practice some procedural 3D art. There are 5 secrets hidden across it. I hope you can find them!',
      'Thanks to Ana and Michael for their tips.',
    ],
    congratsTitle: 'You found all 5 secrets!',
    congratsParagraphs: [
      "(I hope that didn't take too long)",
      "I don't have anything to give you other than my thanks for exploring this experiment, inspired by those calm summer days where life just passes by... ☀️",
    ],
  },
  features: {
    multiplayer: true,
    multiplayerUrl: '',
    npcs: { seaCouple: true, kiteFlyers: true, guitarist: true },
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
      text: "It's a big metallic object. You want to believe it's some kind of vehicle.",
      distance: 10,
      position: [-56.9402, 2.6553, 22.7015],
      rotation: [0, 0, 0],
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
