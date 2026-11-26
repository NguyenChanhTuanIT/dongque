import { CustomEase } from 'gsap/CustomEase';
import { client } from './core/client';
import { events } from './core/events';
import { MainController } from './scene/mainController';
import { engine } from './engine/globals';
import { clock } from './engine/clock';
import { UiController } from './components/ui';
import { loadConfig, watchConfig } from './config/store';
import './styles.css';

const ui = new UiController(document.getElementById('app') ?? document.body);

CustomEase.create('inOut1', 'M0,0 C0.5,0 0.1,1 1,1');
CustomEase.create('inOut2', 'M0,0 C0.56,0 0,1 1,1');
CustomEase.create('inOut3', 'M0,0 C0.6,0 0,1 1,1');
CustomEase.create('inOut4', 'M0,0 C0.4,0 -0.06,1 1,1');

async function start() {
  if (!client.capabilities.webgl) {
    ui.showUnsupported();
    return;
  }

  const webglContainer = ui.webglContainer;
  const isSafariDesktop = client.browser.name === 'safari' && client.device === 'desktop';
  engine.init({
    webglContainer,
    fingers: 2,
    contextMenu: false,
    DPR: isSafariDesktop ? 1 : Math.min(window.devicePixelRatio, 1.5) || 1,
    adaptiveDPR: true,
  });
  engine.active = true;

  const onEasterEgg = () => ui.incrementEasterEggs();
  const onSecret = (message: string) => ui.showSecret(message);
  const onTip = (message: string) => ui.showTip(message);
  const onMute = (muted: boolean) => ui.setMuted(muted);
  const onColor = (color: string) => ui.setCharacterColor(color);
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === 'Escape') ui.closeOverlay();
  };

  events.on('webgl_increase_easer_count', onEasterEgg);
  events.on('webgl_show_modal', onSecret);
  events.on('webgl_show_tip', onTip);
  events.on('webgl_audio_update_mute', onMute);
  events.on('webgl_character_update_color', onColor);
  events.on('keyup', onKeyUp);

  // Remote config (Firestore) must be in before the scene modules read it;
  // the loader stays on screen meanwhile and defaults apply on any failure.
  await loadConfig();
  watchConfig((config) => ui.applyConfig(config));

  const controller = new MainController();
  if (new URLSearchParams(window.location.search).has('audit')) {
    (window as any).__relaxAudit = { engine, controller };
  }
  const stopClock = clock.start((time, delta) => engine.render(time, delta));

  controller.ready.then(() => {
    ui.showExperience();
    engine.initialSceneLoaded.resolve();
  });

  window.addEventListener('beforeunload', () => {
    stopClock();
    events.off('webgl_increase_easer_count', onEasterEgg);
    events.off('webgl_show_modal', onSecret);
    events.off('webgl_show_tip', onTip);
    events.off('webgl_audio_update_mute', onMute);
    events.off('webgl_character_update_color', onColor);
    events.off('keyup', onKeyUp);
  }, { once: true });
}

void start();
