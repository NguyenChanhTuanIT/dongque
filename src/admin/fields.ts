// Form description of the admin panel: one entry per editable config field,
// grouped in sections. `reload: true` marks fields the game only reads at
// boot (players see them after reloading the page); the rest apply live.

import { SECRET_PIECES, TOGGLEABLE_MODULES } from '../config/schema';
import { CATEGORIES, SHOP_ITEMS } from '../shop/catalog';
import type { IconName } from './icons';

export type FieldKind = 'text' | 'multiline' | 'paragraphs' | 'number' | 'color' | 'bool' | 'vec3' | 'shopItem';

export interface Field {
  path: string;
  label: string;
  kind: FieldKind;
  step?: number;
  min?: number;
  max?: number;
  reload?: boolean;
  hint?: string;
  /** shopItem: emoji shown before the label. */
  icon?: string;
}

export interface Section {
  /** URL slug used by the admin menu (#/<id>). */
  id: string;
  /** Menu group heading the section is listed under. */
  group: string;
  icon: IconName;
  title: string;
  /** Shorter label for the menu; defaults to `title`. */
  navLabel?: string;
  description?: string;
  fields: Field[];
}

const MODULE_LABELS: Record<(typeof TOGGLEABLE_MODULES)[number], string> = {
  birds: 'Chim',
  trees: 'Cây',
  bushes: 'Bụi cây',
  lightposts: 'Cột đèn',
  palmtrees: 'Cây dừa',
  houses: 'Nhà',
  warehouses: 'Nhà kho',
  machines: 'Máy móc',
  rocks1: 'Đá (loại 1)',
  rocks2: 'Đá (loại 2)',
  parasols: 'Dù bãi biển',
  castles: 'Lâu đài cát',
  grass: 'Cỏ',
  blockers: 'Rào chắn đường',
  ufo: 'UFO',
  alien: 'Người ngoài hành tinh',
  sign: 'Biển báo',
  cats: 'Mèo',
  sloth: 'Con lười',
  gossip: 'Gossip (máy chơi game)',
};

const PIECE_LABELS: Record<(typeof SECRET_PIECES)[number], string> = {
  ufo: 'UFO',
  alien: 'Người ngoài hành tinh',
  cats: 'Mèo',
  sloth: 'Con lười',
  gossip: 'Gossip',
};

export const SECTIONS: Section[] = [
  {
    id: 'ui',
    group: 'Cấu hình chung',
    icon: 'layout',
    title: 'Giao diện',
    description: 'Chữ hiển thị trên màn hình tải, bảng giới thiệu và bảng chúc mừng.',
    fields: [
      { path: 'ui.loaderTitle', label: 'Tiêu đề màn hình tải', kind: 'multiline', hint: 'Xuống dòng để ngắt dòng.' },
      { path: 'ui.aboutTitle', label: 'Tiêu đề bảng giới thiệu', kind: 'text' },
      { path: 'ui.aboutParagraphs', label: 'Nội dung bảng giới thiệu', kind: 'paragraphs', hint: 'Mỗi dòng là một đoạn. Link credit tác giả gốc luôn được giữ ở cuối.' },
      { path: 'ui.congratsTitle', label: 'Tiêu đề khi tìm đủ bí mật', kind: 'text' },
      { path: 'ui.congratsParagraphs', label: 'Nội dung khi tìm đủ bí mật', kind: 'paragraphs', hint: 'Mỗi dòng là một đoạn.' },
    ],
  },
  {
    id: 'player',
    group: 'Cấu hình chung',
    icon: 'user',
    title: 'Nhân vật',
    description: 'Điểm xuất phát và lực di chuyển của người chơi.',
    fields: [
      { path: 'player.spawn', label: 'Điểm xuất phát (x, y, z)', kind: 'vec3', step: 0.1, reload: true },
      { path: 'player.spawnRadius', label: 'Bán kính xuất phát ngẫu nhiên', kind: 'number', step: 0.5, min: 0, reload: true },
      { path: 'player.moveForce', label: 'Lực chạy', kind: 'number', step: 0.0005, min: 0, hint: 'Mặc định 0.005' },
      { path: 'player.jumpForce', label: 'Lực nhảy', kind: 'number', step: 0.01, min: 0, hint: 'Mặc định 0.2' },
      { path: 'player.sprintMultiplier', label: 'Hệ số chạy nhanh', kind: 'number', step: 0.1, min: 1, hint: 'Shift / RB / đẩy hết joystick. 1 = tắt chạy nhanh. Mặc định 1.6' },
      { path: 'player.idleEmoteSeconds', label: 'Đứng yên bao lâu thì tự "chán" (giây)', kind: 'number', step: 5, min: 0, hint: '0 = không bao giờ. Mặc định 60' },
    ],
  },
  {
    id: 'colors',
    group: 'Cấu hình chung',
    icon: 'sun',
    title: 'Màu sắc',
    description: 'Ánh sáng, chỉnh màu toàn cảnh và màu cỏ.',
    fields: [
      { path: 'lighting.tint', label: 'Màu phủ toàn cảnh', kind: 'color', hint: '#ffffff = giữ nguyên màu gốc.' },
      { path: 'lighting.brightness', label: 'Độ sáng', kind: 'number', step: 0.05, min: 0, hint: '1 = gốc' },
      { path: 'lighting.gradeIntensity', label: 'Cường độ chỉnh màu (LUT)', kind: 'number', step: 0.05, min: 0, max: 1, hint: '0 = tắt, 1 = gốc' },
      { path: 'terrain.grassColor1', label: 'Màu cỏ 1', kind: 'color' },
      { path: 'terrain.grassColor2', label: 'Màu cỏ 2', kind: 'color' },
    ],
  },
  {
    id: 'audio',
    group: 'Cấu hình chung',
    icon: 'volume',
    title: 'Âm thanh',
    fields: [{ path: 'audio.volume', label: 'Âm lượng tổng (0 – 1)', kind: 'number', step: 0.05, min: 0, max: 1 }],
  },
  ...SECRET_PIECES.map((piece): Section => ({
    id: `secret-${piece}`,
    group: 'Bí mật',
    icon: 'sparkle',
    title: `Bí mật: ${PIECE_LABELS[piece]}`,
    navLabel: PIECE_LABELS[piece],
    description: 'Lời thoại, vùng kích hoạt và vị trí đặt vật thể bí mật trong cảnh.',
    fields: [
      { path: `secrets.${piece}.text`, label: 'Lời thoại', kind: 'multiline' },
      { path: `secrets.${piece}.distance`, label: 'Khoảng cách kích hoạt', kind: 'number', step: 0.5, min: 0 },
      { path: `secrets.${piece}.position`, label: 'Vị trí (x, y, z)', kind: 'vec3', step: 0.1 },
      { path: `secrets.${piece}.rotation`, label: 'Góc xoay (độ)', kind: 'vec3', step: 1 },
      { path: `secrets.${piece}.scale`, label: 'Kích thước', kind: 'number', step: 0.05, min: 0.01 },
    ],
  })),
  {
    id: 'npcs',
    group: 'Cấu hình chung',
    icon: 'user',
    title: 'NPC',
    description: 'Nhân vật do máy tự điều khiển; mọi người chơi đều thấy giống nhau. Bật/tắt áp dụng ngay.',
    fields: [
      { path: 'features.npcs.seaCouple', label: 'Hai bạn ngồi ngắm biển (nam ôm eo nữ)', kind: 'bool' },
      { path: 'features.npcs.kiteFlyers', label: 'Hai bạn thả diều trên bãi biển', kind: 'bool' },
      { path: 'features.npcs.guitarist', label: 'Bạn đàn hát cuối con đường', kind: 'bool' },
      { path: 'features.npcs.fisher', label: 'Bạn câu cá trên cầu câu', kind: 'bool' },
      { path: 'features.npcs.henFeeder', label: 'Bạn cho gà ăn ở chuồng gà', kind: 'bool' },
      { path: 'features.npcs.waterCarrier', label: 'Bạn gánh nước từ giếng ra chuồng gà', kind: 'bool' },
      { path: 'features.npcs.butterflyKids', label: 'Hai bạn bắt bướm trên bãi bướm ven biển', kind: 'bool' },
    ],
  },
  {
    id: 'shop',
    group: 'Cấu hình chung',
    icon: 'bag',
    title: 'Cửa hàng',
    description:
      'Giá (số hoa 🌸) và trạng thái bán của từng món. 0 = nhận miễn phí. Tắt "Đang bán" thì món biến khỏi cửa hàng, người đã mua vẫn giữ. Đổi giá không ảnh hưởng đồ đã mua; server áp dụng giá mới trong vòng 30 giây.',
    fields: SHOP_ITEMS.map((it): Field => ({
      path: `shop.items.${it.id}`,
      label: it.label,
      kind: 'shopItem',
      icon: it.icon,
      hint: `${CATEGORIES.find((c) => c.id === it.category)?.label ?? ''} · ${it.id}`,
    })),
  },
  {
    id: 'features',
    group: 'Hệ thống',
    icon: 'toggle',
    title: 'Tính năng',
    description: 'Tắt một nhóm vật thể thì game không tải nó. Tắt multiplayer thì game không mở kết nối mạng nào cho multiplayer.',
    fields: [
      { path: 'features.multiplayer', label: 'Multiplayer', kind: 'bool', reload: true },
      {
        path: 'features.multiplayerUrl',
        label: 'Địa chỉ server multiplayer',
        kind: 'text',
        reload: true,
        hint: 'Để trống = cùng host với trang, đường dẫn /mp. Ví dụ: wss://game.example.com/mp',
      },
      ...TOGGLEABLE_MODULES.map((m): Field => ({
        path: `features.modules.${m}`,
        label: MODULE_LABELS[m],
        kind: 'bool',
        reload: true,
      })),
    ],
  },
];
