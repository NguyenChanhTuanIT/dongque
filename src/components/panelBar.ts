// Title bar with a close button for the nav panels (character, rewards, shop).
// It stays pinned at the top while the panel scrolls, so touch screens (no
// Escape key, panel almost as wide as the screen) always have a way out.

const closeIcon =
  '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="m1.5 1.5 15 15m0-15-15 15" stroke="#716c66" stroke-width="2.4" stroke-linecap="round"/></svg>';

/** Add the bar to `panel` and return the container for the panel's content. */
export function addPanelBar(panel: HTMLElement, title: string, onClose: () => void): HTMLDivElement {
  const bar = document.createElement('div');
  bar.className = 'panel-bar';
  const heading = document.createElement('b');
  heading.textContent = title;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'panel-close';
  close.setAttribute('aria-label', 'Đóng');
  close.title = 'Đóng';
  close.innerHTML = closeIcon;
  close.addEventListener('click', (e) => {
    e.stopPropagation();
    onClose();
  });
  bar.append(heading, close);

  const content = document.createElement('div');
  content.className = 'panel-content';
  panel.append(bar, content);
  return content;
}
