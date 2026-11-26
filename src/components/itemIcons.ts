// Picture icons for the character panel (Nhân vật tab): one small inline SVG
// per catalog item of the outfit slots, plus the boy / girl presets. Drawn in
// one flat style (dark outline, warm fills) on a 48×48 grid, so the panel
// shows pictures instead of item names; the name stays as tooltip / aria-label.

const INK = '#4d4945';
const SKIN = '#f2c7a5';
const HAIR = '#6b4a2f';
const LINE = `stroke="${INK}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"`;

const svg = (body: string) =>
  `<svg viewBox="0 0 48 48" width="36" height="36" aria-hidden="true" focusable="false">${body}</svg>`;
const path = (d: string, fill: string, extra = '') => `<path d="${d}" fill="${fill}" ${LINE} ${extra}/>`;
const circle = (cx: number, cy: number, r: number, fill: string, extra = LINE) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;

// ---- heads (face centred at 24,26, radius 12) ----
/** Head icons are drawn a bit larger than the 48 grid's centre circle. */
const bigHead = (head: string) => svg(`<g transform="translate(24 24) scale(1.12) translate(-24 -25)">${head}</g>`);
const face = () =>
  circle(24, 26, 12, SKIN) +
  circle(19.5, 27, 1.4, INK, '') +
  circle(28.5, 27, 1.4, INK, '') +
  `<path d="M21 31.5 Q24 33.5 27 31.5" fill="none" ${LINE}/>`;
const fringe = () => path('M12 25 C11 13 37 13 36 25 C33 19 27 17 24 19 C21 17 15 19 12 25 Z', HAIR);
const tie = (cx: number, cy: number) => circle(cx, cy, 2.2, '#d65a4a');

const HEADS: Record<string, string> = {
  default: face() + fringe(),
  pigtails: circle(9, 29, 5.5, HAIR) + circle(39, 29, 5.5, HAIR) + face() + fringe() + tie(13, 25) + tie(35, 25),
  ponytail: path('M33 15 C43.5 13 44.5 31 39 40 C39 31 37 25 33 22 Z', HAIR) + face() + fringe() + tie(35, 17),
  bob: path('M10 35 C8 16 16 11 24 11 C32 11 40 16 38 35 Z', HAIR) + face() + path('M12 24 C13 14 35 14 36 24 C30 20 18 20 12 24 Z', HAIR),
};

// ---- clothes ----
const TEE = 'M17 9 L10 12 L4 20 L10 25 L13 22 L13 40 L35 40 L35 22 L38 25 L44 20 L38 12 L31 9 C29 13 19 13 17 9 Z';
const tee = (fill: string) => path(TEE, fill);
/** Striped t-shirt (shop tops): white tee, coloured bands clipped to its shape. */
const stripedTee = (id: string, color: string) =>
  `<defs><clipPath id="${id}"><path d="${TEE}"/></clipPath></defs>` +
  path(TEE, '#ffffff', '') +
  `<g clip-path="url(#${id})" fill="${color}">${[12, 19, 26, 33].map((y) => `<rect x="0" y="${y}" width="48" height="3.6"/>`).join('')}</g>` +
  `<path d="${TEE}" fill="none" ${LINE}/>`;
const NONE = svg(
  `<circle cx="24" cy="24" r="14" fill="none" stroke="#a39d95" stroke-width="2.5"/><path d="M14 34 L34 14" stroke="#a39d95" stroke-width="2.5" stroke-linecap="round"/>`,
);
const lowShoe = (upper: string, toeCap: boolean) =>
  path('M5 33 L6 25 C12 25 16 22 18 20 L27 20 C30 25 37 26 42 28 C44 29 44 33 43 33 Z', upper) +
  (toeCap ? path('M36 26.5 C40 27.5 44 29.5 44 33 H35 C34.5 30.5 35 28.5 36 26.5 Z', '#ffffff') : '') +
  path('M4 33 H44 V36 C44 37.5 43 38.5 41.5 38.5 H6.5 C5 38.5 4 37.5 4 36 Z', '#ffffff');
const flower = (cx: number, cy: number, fill: string) => circle(cx, cy, 4.6, fill) + circle(cx, cy, 1.4, '#f7c948', '');

const ITEM_ICONS: Record<string, string> = {
  'hat.none': NONE,
  'hat.straw': svg(
    `<ellipse cx="24" cy="31" rx="20" ry="6" fill="#e8c77a" ${LINE}/>` +
      path('M13 31 C13 17 35 17 35 31 Z', '#f0d48f') +
      path('M13.4 26.5 C20 28.5 28 28.5 34.6 26.5 L35 30 C28 32 20 32 13 30 Z', '#d65a4a'),
  ),
  'hat.cap': svg(
    path('M9 31 C9 14 37 14 37 31 Z', '#4f86c6') +
      path('M31 31 C37 29.5 44 31 45.5 34.5 C40 36 33 35 28 33.5 Z', '#3b6aa3') +
      `<path d="M23 15 V31" fill="none" ${LINE}/>` +
      circle(23, 14.5, 2, '#3b6aa3'),
  ),
  'hair.default': bigHead(HEADS.default),
  'hair.pigtails': bigHead(HEADS.pigtails),
  'hair.ponytail': bigHead(HEADS.ponytail),
  'hair.bob': bigHead(HEADS.bob),
  // The plain t-shirt takes the clothes colour: shown as a rainbow-ish tee.
  'top.tshirt': svg(
    `<defs><linearGradient id="tee-any" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ef9ab5"/><stop offset="0.5" stop-color="#f7c948"/><stop offset="1" stop-color="#5b8fd1"/></linearGradient></defs>` + tee('url(#tee-any)'),
  ),
  'top.blue': svg(stripedTee('stripe-blue', '#5b8fd1')),
  'top.pink': svg(stripedTee('stripe-pink', '#ef9ab5')),
  'bottom.shorts': svg(path('M11 11 H37 L40 35 H27.5 L24 22 L20.5 35 H8 Z', '#ccb080') + `<path d="M11.5 15.5 H36.5" fill="none" ${LINE}/>`),
  'bottom.skirt': svg(
    path('M16 10 H32 L43 36 C34 40 14 40 5 36 Z', '#e57f8f') +
      `<path d="M15 14.5 H33 M20 15 L15 37 M24 15 V38.5 M28 15 L33 37" fill="none" ${LINE}/>`,
  ),
  'bottom.jeans': svg(
    path('M13 5 H35 L38 44 H27.5 L24 18 L20.5 44 H10 Z', '#4a72a8') +
      `<path d="M13.4 10 H34.6 M17 10 C17 14 19 15 21 15 M31 10 C31 14 29 15 27 15" fill="none" ${LINE}/>`,
  ),
  'shoes.sandals': svg(
    path('M24 4 C32 4 34 14 33 24 C32 34 32 44 24 44 C16 44 16 34 15 24 C14 14 16 4 24 4 Z', '#c98b4b') +
      `<path d="M24 9 L16.5 19.5 M24 9 L31.5 19.5" fill="none" stroke="#7a4f2a" stroke-width="3.5" stroke-linecap="round"/>` +
      circle(24, 9, 2.2, '#7a4f2a'),
  ),
  'shoes.barefoot': svg(
    path('M24 18 C30 18 32 24 31 31 C30 38 29 44 23 44 C17 44 17 38 17 31 C16 24 18 18 24 18 Z', SKIN) +
      circle(30.5, 12, 3.4, SKIN) +
      circle(25, 10, 2.6, SKIN) +
      circle(20.5, 11, 2.3, SKIN) +
      circle(17, 13.5, 2, SKIN) +
      circle(14.8, 17, 1.7, SKIN),
  ),
  'shoes.sneakers': svg(
    lowShoe('#6aa7d8', false) +
      `<path d="M20 22 L25 25 M23 20 L28 23.5" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`,
  ),
  'shoes.canvas': svg(lowShoe('#d6453d', true) + `<path d="M20.5 22 L25 24.5 M23.5 20.5 L27.5 23" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>`),
  'glasses.none': NONE,
  'glasses.sun': svg(
    `<rect x="7" y="18" width="15" height="11" rx="4.5" fill="#2f2b29" ${LINE}/><rect x="26" y="18" width="15" height="11" rx="4.5" fill="#2f2b29" ${LINE}/>` +
      `<path d="M22 21 Q24 19 26 21 M7 20.5 L3 18.5 M41 20.5 L45 18.5" fill="none" ${LINE}/>` +
      `<path d="M10.5 21.5 L13.5 20.5 M29.5 21.5 L32.5 20.5" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round"/>`,
  ),
  'glasses.round': svg(
    circle(15, 24, 7, '#e3f0f5') +
      circle(33, 24, 7, '#e3f0f5') +
      `<path d="M22 23 Q24 21 26 23 M8 23 L3.5 21 M40 23 L44.5 21" fill="none" ${LINE}/>`,
  ),
  'necklace.none': NONE,
  'necklace.shell': svg(
    `<path d="M8 8 C10 29 38 29 40 8" fill="none" stroke="#b08a5a" stroke-width="2" stroke-linecap="round"/>` +
      path('M24 41 L15.5 31 C17.5 24 30.5 24 32.5 31 Z', '#f6d6c4') +
      `<path d="M24 41 L20 27 M24 41 V26 M24 41 L28 27" fill="none" ${LINE}/>`,
  ),
  // picnic items (shop / wardrobe cards)
  'picnic.fishing': svg(
    `<path d="M7 43 L37 7" fill="none" stroke="#8a5a32" stroke-width="3.2" stroke-linecap="round"/>` +
      `<path d="M37 7 L39 30" fill="none" stroke="${INK}" stroke-width="1.2"/>` +
      circle(13, 36, 3.2, '#bab3a5') +
      path('M35.5 31 A3.5 3.5 0 0 1 42.5 31 Z', '#d65a4a') +
      path('M35.5 31 A3.5 3.5 0 0 0 42.5 31 Z', '#ffffff'),
  ),
  'picnic.guitar': svg(
    `<path d="M27 22 L40 9" fill="none" stroke="#6b4a2f" stroke-width="4.5" stroke-linecap="round"/>` +
      path('M38 6 L44 4 L45 10 L41 12 Z', '#6b4a2f') +
      path('M28 17 C33 17 35 21 32 25 C31 27 32 29 31 33 C29 41 17 45 10 38 C3 31 7 19 15 17 C19 16 21 17 23 16 C25 15.5 26 17 28 17 Z', '#e0954a') +
      circle(21, 28, 3, INK, '') +
      `<path d="M12 37 L16 33" fill="none" ${LINE}/>`,
  ),
  'picnic.kite': svg(
    path('M24 3 L38 17 L24 35 L10 17 Z', '#ef6f8a') +
      path('M24 3 L38 17 L24 17 Z', '#f7c948') +
      path('M10 17 L24 35 L24 17 Z', '#5b8fd1') +
      `<path d="M24 35 C19 39 29 41 24 46" fill="none" ${LINE}/>` +
      path('M21 38.5 L19 36.5 L19 40.5 Z', '#f7c948') +
      path('M26.5 42.5 L28.5 40.5 L28.5 44.5 Z', '#ef6f8a'),
  ),
  'picnic.icecream': svg(
    path('M15 24 H33 L24 45 Z', '#e0a965') +
      `<path d="M18 28 L28.5 34.5 M21.5 25 L30.5 30.5 M30 28 L19.5 34.5 M26.5 25 L17.5 30.5" fill="none" stroke="#b07a3c" stroke-width="1.4"/>` +
      path('M13.5 24 C12 15 17 10 24 10 C31 10 36 15 34.5 24 C32 25.5 30 23 28 25 C26 27 23 24 21 25.5 C18.5 27 16 24 13.5 24 Z', '#f6c5d3') +
      circle(25, 8, 2.6, '#d65a4a'),
  ),
  // ---- emote items: pets, hobby, farm (shop / wardrobe cards) ----
  'pet.dog': svg(
    path('M11 14 C6 16 6 28 11 30 C13 24 14 19 15 16 Z', '#7a5232') +
      path('M37 14 C42 16 42 28 37 30 C35 24 34 19 33 16 Z', '#7a5232') +
      path('M24 11 C33 11 37 18 37 26 C37 36 31 41 24 41 C17 41 11 36 11 26 C11 18 15 11 24 11 Z', '#c98b4b') +
      path('M24 27 C29 27 32 30 32 34 C32 38 28 40 24 40 C20 40 16 38 16 34 C16 30 19 27 24 27 Z', '#f4ead8') +
      circle(19, 23, 1.8, INK, '') + circle(29, 23, 1.8, INK, '') +
      path('M21 29 C21 27 27 27 27 29 C27 31 25 32 24 32 C23 32 21 31 21 29 Z', INK) +
      `<path d="M24 32 V35 M21 36 Q24 38 27 36" fill="none" ${LINE}/>`,
  ),
  'pet.cat': svg(
    path('M10 9 L19 15 L13 22 Z', '#d9893b') + path('M38 9 L29 15 L35 22 Z', '#d9893b') +
      path('M24 13 C33 13 39 19 39 27 C39 36 32 41 24 41 C16 41 9 36 9 27 C9 19 15 13 24 13 Z', '#d9893b') +
      `<path d="M20 15 L21 20 M24 14 V19 M28 15 L27 20" fill="none" stroke="#a2602a" stroke-width="2" stroke-linecap="round"/>` +
      path('M18.5 24 C19 21.5 21.5 21.5 22 24 C21.5 26.5 19 26.5 18.5 24 Z', '#a6c93a') + path('M26 24 C26.5 21.5 29 21.5 29.5 24 C29 26.5 26.5 26.5 26 24 Z', '#a6c93a') +
      path('M22.5 29 H25.5 L24 31 Z', '#e8949c') +
      `<path d="M24 31 Q22 34 20 33 M24 31 Q26 34 28 33 M8 28 L16 29 M8 32 L16 31 M40 28 L32 29 M40 32 L32 31" fill="none" ${LINE}/>`,
  ),
  'hobby.flute': svg(
    `<g transform="rotate(-35 24 24)">` +
      `<rect x="4" y="20.5" width="40" height="7" rx="3.5" fill="#d9b26a" ${LINE}/>` +
      `<path d="M12 21 V27 M33 21 V27" stroke="#a5813f" stroke-width="2"/>` +
      [16, 21, 26, 30, 38].map((x) => circle(x, 24, 1.4, INK, '')).join('') +
      '</g>',
  ),
  'hobby.fan': svg(
    [0, 1, 2, 3, 4, 5, 6].map((k) => {
      const a = (-150 + k * 20) * Math.PI / 180;
      const b = (-130 + k * 20) * Math.PI / 180;
      const cx = 24, cy = 40, r = 30;
      return path(`M${cx} ${cy} L${(cx + r * Math.cos(a)).toFixed(1)} ${(cy + r * Math.sin(a)).toFixed(1)} A${r} ${r} 0 0 1 ${(cx + r * Math.cos(b)).toFixed(1)} ${(cy + r * Math.sin(b)).toFixed(1)} Z`, k % 2 ? '#ef9ab5' : '#f7e3c4');
    }).join('') +
      circle(24, 40, 2.5, '#8a5a32'),
  ),
  'hobby.book': svg(
    path('M24 13 C19 10 11 10 6 12 V38 C11 36 19 36 24 39 Z', '#5b8fd1') +
      path('M24 13 C29 10 37 10 42 12 V38 C37 36 29 36 24 39 Z', '#5b8fd1') +
      path('M24 15 C20 12.5 13 12.5 9 14 V35 C13 34 20 34 24 36.5 Z', '#fffdf8') +
      path('M24 15 C28 12.5 35 12.5 39 14 V35 C35 34 28 34 24 36.5 Z', '#fffdf8') +
      `<path d="M12 19 H20 M12 23 H20 M12 27 H19 M28 19 H36 M28 23 H36 M28 27 H35" stroke="#bab3a5" stroke-width="1.5" stroke-linecap="round"/>`,
  ),
  'hobby.jumprope': svg(
    `<path d="M11 14 C6 38 42 38 37 14" fill="none" stroke="#ef6f8a" stroke-width="2.6" stroke-linecap="round"/>` +
      `<rect x="8" y="5" width="6" height="11" rx="2.5" fill="#f7c948" ${LINE}/>` +
      `<rect x="34" y="5" width="6" height="11" rx="2.5" fill="#f7c948" ${LINE}/>`,
  ),
  'hobby.shuttle': svg(
    path('M17 33 L10 9 L17 11 L21 7 L24 10 L27 7 L31 11 L38 9 L31 33 Z', '#f7f3ea') +
      `<path d="M17 33 L17 11 M24 33 V10 M31 33 L31 11" fill="none" stroke="#bab3a5" stroke-width="1.5"/>` +
      path('M15 33 H33 V37 C33 41 29 43 24 43 C19 43 15 41 15 37 Z', '#d65a4a'),
  ),
  'hobby.net': svg(
    `<path d="M8 42 L23 25" stroke="#8a6a45" stroke-width="3" stroke-linecap="round"/>` +
      `<ellipse cx="31" cy="16" rx="11" ry="9" fill="#e3f0f5" ${LINE}/>` +
      `<path d="M23 12 L39 20 M24 19 L37 10 M31 7 V25" stroke="#bab3a5" stroke-width="1.2"/>` +
      path('M36 31 C33 28 34 25 37 27 C40 25 41 28 38 31 Z', '#f2994a') + path('M36 31 C34 34 36 36 37 33 C38 36 40 34 38 31 Z', '#f7c948'),
  ),
  'farm.wateringcan': svg(
    path('M10 20 H30 V40 C30 41.5 29 42 28 42 H12 C11 42 10 41.5 10 40 Z', '#5ba57a') +
      path('M30 25 L42 15 L44 17 L32 31 Z', '#5ba57a') +
      path('M41 12 L46 17 L44 19 L39 14 Z', '#3e7d57') +
      `<path d="M12 20 C12 10 28 10 28 20" fill="none" ${LINE}/>` +
      `<path d="M46 22 L47 25 M43 23 L43 26 M45 27 L45 30" stroke="#5b8fd1" stroke-width="2" stroke-linecap="round"/>`,
  ),
  'farm.broom': svg(
    `<path d="M34 5 L22 27" stroke="#8a5a32" stroke-width="3" stroke-linecap="round"/>` +
      path('M19 25 L27 29 L26 33 C24 38 20 42 13 44 C12 39 13 32 17 28 Z', '#e8c77a') +
      `<path d="M17 31 L14 41 M20 32 L17 43 M23 33 L21 42" fill="none" stroke="#b08a3c" stroke-width="1.5"/>` +
      `<path d="M19 27 L26 30" stroke="#d65a4a" stroke-width="2.4"/>`,
  ),
  'farm.pole': svg(
    `<path d="M3 13 Q24 9 45 13" fill="none" stroke="#a27b45" stroke-width="3" stroke-linecap="round"/>` +
      `<path d="M8 13 L5 26 M8 13 L13 26 M40 13 L35 26 M40 13 L43 26" stroke="${INK}" stroke-width="1.3"/>` +
      path('M3 26 H15 L14 40 C14 41 13 42 12 42 H6 C5 42 4 41 4 40 Z', '#8a8a86') +
      path('M33 26 H45 L44 40 C44 41 43 42 42 42 H36 C35 42 34 41 34 40 Z', '#8a8a86') +
      `<path d="M4.5 29 H13.5 M34.5 29 H43.5" stroke="#5b8fd1" stroke-width="2.2"/>`,
  ),
  'necklace.lei': svg(
    [0, 1, 2, 3, 4, 5, 6, 7]
      .map((k) => {
        const a = (k / 8) * Math.PI * 2;
        return flower(24 + Math.cos(a) * 14, 24 + Math.sin(a) * 14, ['#ef6f8a', '#f39ac0', '#f2994a', '#ef6f8a'][k % 4]);
      })
      .join(''),
  ),
};

/** Boy / girl presets (PRESETS order in scene/appearance.ts): a portrait with shoulders. */
const portrait = (hair: string, shirt: string) =>
  svg(path('M7 47 C7 37 14 35 24 35 C34 35 41 37 41 47 Z', shirt) + `<g transform="translate(24 20) scale(0.92) translate(-24 -25)">${hair}</g>`);
export const PRESET_ICONS = [portrait(HEADS.default, '#5b8fd1'), portrait(HEADS.pigtails, '#ef9ab5')];

/** Shop / wardrobe card icon: the same picture as the character panel, else the catalog emoji. */
export function cardIcon(item: { id: string; icon?: string }): string {
  return ITEM_ICONS[item.id] ?? item.icon ?? '🎁';
}

/** Icon for a catalog item, or '' when there is none (the button keeps its text). */
export function itemIcon(id: string): string {
  return ITEM_ICONS[id] ?? '';
}
