import { GameScene } from './scene';
import { Game } from './game';
import { LocalSession, RemoteSession } from './session';
import { Launch, showMenu } from './menu';
import { loadPack } from './pack';
import { h } from './hud';

const canvas = document.getElementById('scene') as HTMLCanvasElement;
const ui = document.getElementById('ui')!;
const scene = new GameScene(canvas);

function start(l: Launch) {
  if (l.mode === 'online') {
    const session = new RemoteSession(l.server, l.code, l.name, l.squad);
    let game: Game | null = null;
    ui.replaceChildren(h('div', { class: 'menu' }, h('div', { class: 'menu-card' },
      h('h2', {}, 'Room ' + l.code), h('p', {}, 'Share this code with your opponent. The battle starts when they join.'),
      h('div', { class: 'bigcode' }, l.code),
      h('button', { onclick: () => { session.dispose(); menu(); } }, 'Cancel'))));
    session.onError(msg => { if (!game) { alert(msg); session.dispose(); menu(); } });
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

void loadPack().finally(menu);
