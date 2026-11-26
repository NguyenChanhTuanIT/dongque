// Modal overlays shared by the nav panels (character, rewards, shop) and the
// sign-in dialog. They look and behave like the info ("i") modal: a card
// (dark + light layers, `modalpop`) centred on a washed-out scene, quieter
// audio, character controls off and the corner nav hidden.
//
// Several overlays may be open at once (sign-in over the character panel);
// the scene comes back only when the last one closes.

import { events } from '../core/events';

const openOverlays = new Set<string>();

/** Mark overlay `key` open / closed; scene, audio, controls and nav follow. */
export function setOverlay(key: string, open: boolean) {
  const before = openOverlays.size > 0;
  if (open) openOverlays.add(key);
  else openOverlays.delete(key);
  const after = openOverlays.size > 0;
  if (before === after) return;
  events.emit('webgl_overlay_animation', after ? 1 : 0);
  events.emit('webgl_overlay_volume', after ? 0.4 : 1);
  events.emit('webgl_character_controls_enable', !after);
  events.emit('ui_overlay', after); // ui.ts hides / shows the nav
}

let ids = 0;

/**
 * Wrap a nav panel in a centred modal card (like #info) appended to `host`.
 * The panel keeps its own `open` class; call the returned function with the
 * same value whenever it changes.
 */
export function mountPanelModal(panel: HTMLElement, host: HTMLElement): (open: boolean) => void {
  const key = `panel-${++ids}`;
  const root = document.createElement('div');
  root.className = 'nav-modal';
  root.innerHTML = '<div class="close-hit"></div><div class="modal-card"><div class="bg-dark"></div><div class="bg-light"></div></div>';
  (root.querySelector('.modal-card') as HTMLElement).append(panel);
  host.append(root);
  return (open: boolean) => {
    root.classList.toggle('visible', open);
    setOverlay(key, open);
  };
}
