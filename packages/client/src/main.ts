import { GameScene } from './scene';
import { Game } from './game';
import { LocalSession, RemoteSession } from './session';
import { Launch, showLobby, showMenu } from './menu';
import { showCorrespondence } from './correspondence';
import { loadPack } from './pack';
import { restore } from './account';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = document.getElementById('ui')!;
const scene = new GameScene(canvas);
if ((import.meta as any).env?.DEV) (window as any).__scene = scene; // dev-only handle for profiling

function start(l: Launch) {
  if (l.mode === 'correspondence') { showCorrespondence(scene, ui, l.code, menu); return; }
  if (l.mode === 'online') {
    const session = new RemoteSession(l.server, l.code, l.name, l.squad);
    let game: Game | null = null;
    session.onError(msg => { if (!game) { alert(msg); session.dispose(); menu(); } });
    showLobby(ui, session, l.code, () => { session.dispose(); menu(); });
    session.onUpdate(u => {
      if (game) return;
      game = new Game(scene, session, ui, menu);
      game.receive(u); // the Game subscribed after this first update arrived
    });
    return;
  }
  const session = l.mode === 'bot'
    ? new LocalSession(l.squads, [l.name || 'Commander', `${l.bot.difficulty![0].toUpperCase()}${l.bot.difficulty!.slice(1)} AI`], l.bot)
    : new LocalSession(l.squads, ['Player 1', 'Player 2'], null);
  new Game(scene, session, ui, menu);
}

function menu() { scene.setHolo(true); showMenu(ui, start); }

const photo = (import.meta as any).env?.DEV ? new URLSearchParams(location.search).get('photo') : null;
const deepLink = new URLSearchParams(location.search).get('corr');
void Promise.all([loadPack(), restore()]).finally(() =>
  deepLink ? showCorrespondence(scene, ui, deepLink.toUpperCase(), menu) : (photo ? import('./photo').then(m => m.runPhoto(scene, photo)) : menu()));
