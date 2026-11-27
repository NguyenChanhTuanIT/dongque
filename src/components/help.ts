// Help panel ("Hướng dẫn chơi", from the help menu of the nav "?" button):
// how to move, every emote with its key (built from EMOTES, so new emotes show
// up by themselves), how flowers and the shop work, and places to explore.
// Four tabs in the same modal card as the other nav panels (overlay.ts).

import { events } from '../core/events';
import { EMOTES } from '../scene/emotes';
import { itemForEmote } from '../shop/catalog';
import { addPanelBar } from './panelBar';
import { mountPanelModal } from './overlay';

export const helpIcon =
  '<svg class="help" viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M10 0a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 13.6a1.4 1.4 0 1 0 0 2.8 1.4 1.4 0 0 0 0-2.8Zm.1-9.6c-2 0-3.6 1.2-3.9 3a1 1 0 0 0 2 .4c.1-.7.9-1.4 1.9-1.4 1.1 0 1.9.7 1.9 1.5 0 .6-.3 1-1.2 1.5-1.1.6-1.8 1.4-1.8 2.6v.3a1 1 0 0 0 2 0v-.3c0-.4.2-.7 1-1.1 1.2-.7 2-1.6 2-3 0-2-1.7-3.5-3.9-3.5Z" fill="#716C66"/></svg>';

type TabId = 'basics' | 'emotes' | 'flowers' | 'explore';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'basics', label: 'Điều khiển' },
  { id: 'emotes', label: 'Biểu cảm' },
  { id: 'flowers', label: 'Hoa & đồ' },
  { id: 'explore', label: 'Khám phá' },
];

const kbd = (k: string) => `<kbd>${k}</kbd>`;

/** Action | keyboard & mouse | touch screen. */
const CONTROLS: Array<[string, string, string]> = [
  ['Di chuyển', `${kbd('W')}${kbd('A')}${kbd('S')}${kbd('D')} / phím mũi tên, hoặc giữ chuột trái`, 'Kéo vòng tròn điều khiển'],
  ['Chạy nhanh', `Giữ ${kbd('Shift')}`, 'Đẩy vòng tròn ra sát mép'],
  ['Nhảy', `${kbd('Space')} hoặc nhấp nhanh chuột phải`, 'Chạm nhanh vào màn hình'],
  ['Chat', `${kbd('Enter')} mở / gửi, ${kbd('Esc')} đóng`, 'Chạm "💬 Chạm để chat" ở góc dưới trái'],
  ['Biểu cảm', `${kbd('E')} vẫy tay, phím số / chữ (tab Biểu cảm)`, 'Nút mặt cười'],
  ['Đóng bảng', kbd('Esc'), 'Nút ✕ hoặc chạm ra ngoài'],
];

const NAV_GUIDE: Array<[string, string]> = [
  ['⚙️ Cài đặt', 'Nhân vật & tủ đồ, Cửa hàng, bật / tắt âm thanh.'],
  ['🙂 Biểu cảm', 'Chọn động tác cho nhân vật.'],
  ['🌸 Quà mỗi ngày', 'Điểm danh và nhận hoa khi online. Chấm đỏ: có quà chưa nhận.'],
  ['📷 Chụp ảnh', 'Lưu lại khung cảnh (kèm lời chat đang hiện).'],
  ['❓ Trợ giúp', 'Hướng dẫn này, giới thiệu và góp ý.'],
];

function basicsHtml(): string {
  const rows = CONTROLS.map(([action, keys, touch]) => `<li><b>${action}</b><span>⌨️ ${keys}</span><span>📱 ${touch}</span></li>`).join('');
  const nav = NAV_GUIDE.map(([name, text]) => `<li><b>${name}</b><span>${text}</span></li>`).join('');
  return `<ul class="help-rows">${rows}</ul>
    <p class="rewards-note">Tay cầm: cần trái để đi, A / ✕ nhảy, RB / R1 chạy nhanh, Y / △ vẫy tay.</p>
    <div class="look-group"><span>Các nút góc phải</span></div>
    <ul class="help-rows help-nav">${nav}</ul>
    <div class="look-group"><span>Khung chat góc dưới trái</span></div>
    <p class="rewards-note">Ngoài tin nhắn, khung chat còn hiện thông báo của game (câu được cá, ghế đã có người…) và nút hành động khi bạn đứng ở một chỗ đặc biệt: cạnh ghế đá (ngồi / nằm), trên cầu câu (câu cá), bên chuồng gà (cho gà ăn).</p>`;
}

function emotesHtml(): string {
  const items = EMOTES.map((e) => {
    const item = itemForEmote(e.state);
    const key = e.key ? kbd(e.key) : '<kbd class="together">♥</kbd>';
    const need = item ? `<small>cần ${item.label}</small>` : '';
    return `<li>${key}<span>${e.label}</span>${need}</li>`;
  }).join('');
  return `<p class="rewards-note">Bấm phím hoặc chọn từ nút mặt cười. Đa số động tác kéo dài tới khi bạn di chuyển; bấm lại phím đó để dừng.</p>
    <ul class="help-emotes">${items}</ul>
    <p class="rewards-note"><kbd class="together">♥</kbd> Động tác đôi (tặng hoa, nắm tay, nhảy đôi…): đứng gần một người chơi khác rồi chọn trong menu, người kia cần đồng ý. Động tác "cần …" phải mua món đó trong Cửa hàng trước.</p>`;
}

function flowersHtml(): string {
  return `<ul class="help-rows help-nav">
      <li><b>🌸 Nhận hoa</b><span>Bấm nút Quà mỗi ngày (bông hoa): điểm danh mỗi ngày (cuối tuần được nhiều hơn) và nhận thêm hoa khi online đủ 10, 30, 60 phút.</span></li>
      <li><b>👜 Mua đồ</b><span>Cài đặt → Cửa hàng: quần áo, giày, phụ kiện và đồ dã ngoại (cần câu, đàn, diều, kem, lúa…). Bấm Mua rồi bấm lần nữa để xác nhận. Đồ đã mua dùng mãi mãi.</span></li>
      <li><b>👕 Mặc đồ</b><span>Cài đặt → Nhân vật & tủ đồ: chọn nam / nữ, kiểu tóc, màu áo; tab Tủ đồ chứa mọi món bạn đã có.</span></li>
      <li><b>🔐 Tài khoản</b><span>Chưa đăng nhập thì hoa và đồ chỉ lưu trong tab này. Đăng ký (trong Nhân vật & tủ đồ) để giữ lại và dùng trên mọi thiết bị.</span></li>
    </ul>
    <div class="look-group"><button type="button" class="primary" data-shop>Mở Cửa hàng</button></div>`;
}

function exploreHtml(): string {
  return `<ul class="help-rows help-nav">
      <li><b>🎣 Câu cá</b><span>Cầu câu ở bờ biển phía đông. Ra đoạn cầu ngoài biển, bấm ${kbd('6')} (hoặc nút trong khung chat) để thả câu. Phao chìm thì bấm ${kbd('Space')} để giật, giữ để kéo, thả ra khi cần cong nhiều kẻo đứt dây.</span></li>
      <li><b>🐔 Cho gà ăn</b><span>Chuồng gà trên bãi cỏ phía tây. Đứng cạnh hàng rào, bấm ${kbd('G')} để vãi thóc (cần Lúa).</span></li>
      <li><b>🪑 Ghế đá</b><span>Trong lùm cây phía tây. Đứng cạnh ghế, bấm ${kbd('F')} để ngồi hoặc ${kbd('L')} để nằm (nút hiện trong khung chat).</span></li>
      <li><b>🙌 Đập tay</b><span>Bấm ${kbd('H')} gần một người chơi khác; khi hai bàn tay chạm nhau sẽ có pháo tay 👏.</span></li>
      <li><b>✨ Bí mật</b><span>Làng có vài điều bí mật được giấu kỹ. Cứ đi dạo, ghé những góc lạ để tìm nhé.</span></li>
    </ul>`;
}

const RENDER: Record<TabId, () => string> = {
  basics: basicsHtml,
  emotes: emotesHtml,
  flowers: flowersHtml,
  explore: exploreHtml,
};

export class HelpPanel {
  private readonly panel: HTMLDivElement;
  private readonly showModal: (open: boolean) => void;
  private readonly tabs: HTMLButtonElement[];
  private readonly pane: HTMLDivElement;
  private tab: TabId = 'basics';

  constructor(host: HTMLElement, private readonly button: HTMLButtonElement) {
    this.panel = document.createElement('div');
    this.panel.className = 'look-menu help-menu';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', 'Hướng dẫn chơi');
    this.showModal = mountPanelModal(this.panel, host);
    const body = addPanelBar(this.panel, 'Hướng dẫn chơi', () => this.setOpen(false));

    const tabBar = document.createElement('div');
    tabBar.className = 'look-group character-tabs';
    tabBar.setAttribute('role', 'tablist');
    this.tabs = TABS.map(({ id, label }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.textContent = label;
      b.addEventListener('click', () => {
        this.tab = id;
        this.render();
      });
      tabBar.append(b);
      return b;
    });
    this.pane = document.createElement('div');
    this.pane.className = 'panel-content help-pane';
    this.pane.setAttribute('role', 'tabpanel');
    body.append(tabBar, this.pane);

    this.pane.addEventListener('click', (e) => {
      if (!(e.target as HTMLElement).closest('button[data-shop]')) return;
      this.setOpen(false);
      events.emit('shop_open');
    });
    button.setAttribute('aria-haspopup', 'dialog');
    button.addEventListener('click', () => this.setOpen(!this.isOpen));
    document.addEventListener('pointerdown', (e) => {
      if (!this.panel.contains(e.target as Node) && !button.contains(e.target as Node)) this.setOpen(false);
    });
    events.on('keyup', (e: KeyboardEvent) => {
      if (e.code === 'Escape') this.setOpen(false);
    });
    /** Open on a tab from elsewhere (e.g. a first-visit hint). */
    events.on('help_open', (tab?: TabId) => {
      if (tab && RENDER[tab]) this.tab = tab;
      this.setOpen(true);
    });
  }

  private get isOpen() {
    return this.panel.classList.contains('open');
  }

  private setOpen(open: boolean) {
    if (open === this.isOpen) return;
    this.panel.classList.toggle('open', open);
    this.showModal(open);
    this.button.setAttribute('aria-expanded', String(open));
    if (open) this.render();
  }

  private render() {
    this.tabs.forEach((b, i) => b.setAttribute('aria-selected', String(TABS[i].id === this.tab)));
    this.pane.innerHTML = RENDER[this.tab]();
    this.pane.scrollTop = 0;
  }
}
