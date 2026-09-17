// Match controller: feeds session updates through the animation queue, then turns the pending
// decision into interactive HUD + scene affordances.
import { Color3 } from '@babylonjs/core';
import { CONTENT, PLAY_AREA, activeShips, deploymentValid, dialFor, measureArc, pilotDef, previewManeuver, shipDef, shipPoly, weaponsOf } from '@holotable/rules';
import type { Command, DialEntry, Face, GameEvent, GameState, Option, PlayerId, Pose, ShipState } from '@holotable/rules';
import type { GameScene } from './scene';
import type { Session, Update } from './session';
import { diceRow, dialWheel, h, maneuverName, shipCard } from './hud';
import { settings, saveSettings } from './settings';
import { setTension, setVolume, sfx, startDrone } from './audio';

const PHASE_NAME: Record<string, string> = { setup: 'Deployment', planning: 'Planning', system: 'System', activation: 'Activation', engagement: 'Engagement', end: 'End Phase', over: 'Battle Over' };

export class Game {
  private view!: GameState;
  private queue: Update[] = [];
  private busy = false;
  private draft: Record<string, number> = {};
  private submitted = false;
  private selectedShip: string | null = null;
  private picked = new Set<number>();
  private attackDice: Face[] = []; private defenseDice: Face[] = [];
  private attackInfo = '';
  private showDice = false;
  private handoffFor: PlayerId | null = null;
  private lastPlanner: PlayerId | null = null;
  private labels = new Map<string, HTMLElement>();
  private root: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private logLines: string[] = [];
  private hoverShip: string | null = null;
  private shownPhase: string | null = null;

  constructor(private scene: GameScene, private session: Session, private ui: HTMLElement, private onExit: () => void) {
    this.root = h('div', { class: 'game' });
    ui.replaceChildren(this.root);
    this.buildChrome();
    startDrone();
    session.onUpdate(u => this.receive(u));
    session.onError(msg => this.toast(msg));
    scene.onShipClick = id => this.clickShip(id);
    scene.onShipHover = id => { this.hoverShip = id; this.refreshOverlay(); };
    scene.onGroundMove = (x, y) => this.groundMove(x, y);
    scene.onGroundClick = (x, y) => this.groundClick(x, y);
    scene.scene.onBeforeRenderObservable.add(() => this.updateLabels());
  }

  receive(u: Update) { this.queue.push(u); void this.pump(); }

  // ---------- chrome ----------

  private buildChrome() {
    const e = this.els;
    e.top = h('div', { class: 'topbar' });
    e.left = h('div', { class: 'column left' }); e.right = h('div', { class: 'column right' });
    e.prompt = h('div', { class: 'prompt' }); e.dice = h('div', { class: 'dicetray' });
    e.center = h('div', { class: 'center' }); e.banner = h('div', { class: 'banner' });
    e.log = h('div', { class: 'log' }); e.labels = h('div', { class: 'labels' }); e.toast = h('div', { class: 'toast' });
    this.root.append(e.labels, e.top, e.left, e.right, e.log, e.center, e.dice, e.prompt, e.banner, e.toast);
  }

  private toast(msg: string) {
    sfx.deny();
    this.els.toast.textContent = msg; this.els.toast.classList.add('show');
    setTimeout(() => this.els.toast.classList.remove('show'), 3200);
  }

  private async banner(text: string, sub = '') {
    const b = this.els.banner;
    b.replaceChildren(h('div', {}, h('h2', {}, text), sub ? h('p', {}, sub) : null));
    b.classList.add('show');
    await this.scene.wait(900);
    b.classList.remove('show');
  }

  private log(text: string, cls = '') {
    this.logLines.push(`<div class="${cls}">${text}</div>`);
    if (this.logLines.length > 80) this.logLines.shift();
    this.els.log.innerHTML = this.logLines.join('');
    this.els.log.scrollTop = this.els.log.scrollHeight;
  }

  // ---------- update pump ----------

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const u = this.queue.shift()!;
      const first = !this.view;
      if (first) { this.view = u.view; this.scene.setViewer(this.session.viewer()); this.scene.sync(u.view); }
      this.hideInteractive();
      for (const ev of u.events) await this.playEvent(ev, u.view);
      if (u.view.pending?.type !== 'choice' || !u.view.pending.kind.startsWith('modify')) { if (!u.view.attack) { this.showDice = false; await this.scene.endAttack(); } }
      this.view = u.view;
      this.scene.sync(u.view);
    }
    this.busy = false;
    this.render();
  }

  private name(id: string, G = this.view): string { const s = G.ships[id]; return s ? `<b class="p${s.owner}">${pilotDef(s).name} (${s.label})</b>` : id; }

  private async playEvent(ev: GameEvent, G: GameState) {
    switch (ev.t) {
      case 'phase':
        this.shownPhase = ev.phase; this.renderTop(G);
        if (ev.phase === 'planning') { this.draft = {}; this.submitted = false; this.scene.setHolo(true); void this.scene.tacticalCamera(); setTension(0.1); await this.banner(`Round ${G.round || 1}`, 'Planning Phase'); }
        if (ev.phase === 'activation') { this.scene.showGhost(null); this.scene.clearOverlay(); this.scene.setHolo(false); void this.scene.cinematicCamera(); setTension(0.5); await this.banner('Activation Phase'); }
        if (ev.phase === 'engagement') { setTension(1); await this.banner('Engagement Phase'); }
        if (ev.phase === 'setup') { this.scene.setHolo(true); }
        break;
      case 'round': this.log(`— Round ${ev.round} · first player: <b class="p${ev.firstPlayer}">${G.players[ev.firstPlayer].name}</b> —`, 'sep'); break;
      case 'reveal': { const s = G.ships[ev.shipId]; const e = dialFor(s).find(d => d.code === ev.code); this.log(`${this.name(ev.shipId, G)} reveals <i>${e ? maneuverName(e) : ev.code}</i>`); break; }
      case 'move': if (ev.kind === 'ion') this.log(`${this.name(ev.shipId, G)} drifts on an ion maneuver`); if (!ev.full && ev.kind === 'maneuver') this.log(`${this.name(ev.shipId, G)} cannot complete the maneuver`); break;
      case 'bump': this.log(`${this.name(ev.shipId, G)} bumps ${this.name(ev.otherId, G)}`); break;
      case 'obstacle': this.log(`${this.name(ev.shipId, G)} hits ${ev.kind === 'gas' ? 'a gas cloud' : ev.kind === 'debris' ? 'debris' : 'an asteroid'}!`, 'warn'); break;
      case 'action': this.log(`${this.name(ev.shipId, G)}: ${ev.label}`); sfx.click(); break;
      case 'ability': this.log(`${this.name(ev.shipId, G)} uses <i>${ev.name}</i>`); break;
      case 'token': if (ev.delta > 0 && ['stress', 'ion', 'strain', 'disarm'].includes(ev.token)) this.log(`${this.name(ev.shipId, G)} gains ${ev.delta} ${ev.token}`); break;
      case 'lock': if (ev.targetId) this.log(`${this.name(ev.shipId, G)} locks ${this.name(ev.targetId, G)}`); break;
      case 'attack':
        this.attackDice = []; this.defenseDice = []; this.showDice = true;
        this.attackInfo = `${pilotDef(G.ships[ev.attacker]).name} → ${pilotDef(G.ships[ev.defender]).name} · ${ev.weaponName} · range ${ev.range}${ev.obstructed ? ' · obstructed' : ''}`;
        this.log(`${this.name(ev.attacker, G)} attacks ${this.name(ev.defender, G)} with ${ev.weaponName} (range ${ev.range}${ev.obstructed ? ', obstructed' : ''})`, 'atk');
        this.renderDice(null);
        break;
      case 'dice':
        if (ev.pool === 'attack') this.attackDice = ev.dice; else this.defenseDice = ev.dice;
        sfx.dice(); this.renderDice(null);
        if (ev.cause !== 'roll') this.log(`&nbsp;&nbsp;${ev.cause}`);
        await this.scene.wait(ev.cause === 'roll' ? 650 : 450);
        break;
      case 'attackResult': this.log(ev.hit ? `&nbsp;&nbsp;<b>Hit!</b> ${ev.hits} hit${ev.hits === 1 ? '' : 's'}, ${ev.crits} crit${ev.crits === 1 ? '' : 's'}` : '&nbsp;&nbsp;Miss.', ev.hit ? 'hit' : ''); break;
      case 'damage': { const parts = []; if (ev.shields) parts.push(`${ev.shields} shield${ev.shields > 1 ? 's' : ''}`); if (ev.facedown) parts.push(`${ev.facedown} hull`); if (ev.faceup.length) parts.push(`${ev.faceup.length} critical`); this.log(`&nbsp;&nbsp;${this.name(ev.shipId, G)} loses ${parts.join(', ')}`); break; }
      case 'crit': this.log(`&nbsp;&nbsp;Critical: <i>${ev.name}</i>`, 'warn'); break;
      case 'roll': this.log(`&nbsp;&nbsp;${ev.cause} roll: ${ev.die}`); break;
      case 'destroyed': this.log(`${this.name(ev.shipId, G)} is destroyed!`, 'kill'); break;
      case 'removed': if (ev.reason === 'fled') this.log(`${this.name(ev.shipId, G)} flees the battlefield!`, 'kill'); break;
      case 'score': this.renderTop(G); break;
      case 'gameOver': {
        const mine = this.session.local.includes(ev.winner as PlayerId);
        if (ev.winner === 'draw') sfx.phase(); else if (mine) sfx.win(); else sfx.lose();
        break;
      }
    }
    await this.scene.play(ev, G);
  }

  // ---------- rendering ----------

  private me(): PlayerId { return this.session.viewer(); }
  private iControl(p: PlayerId) { return this.session.local.includes(p); }

  private hideInteractive() {
    this.els.prompt.replaceChildren(); this.els.center.replaceChildren();
    this.scene.showGhost(null); this.scene.clearOverlay(); this.scene.showZones(false);
  }

  private render() {
    const G = this.view; if (!G) return;
    this.scene.setViewer(this.me());
    this.renderTop(G); this.renderColumns(); this.renderPrompt(); this.refreshOverlay();
    if (!this.showDice) this.els.dice.replaceChildren();
  }

  private renderTop(G: GameState) {
    const s = settings;
    const btn = (label: string, title: string, fn: () => void, on = false) => h('button', { class: `chip${on ? ' on' : ''}`, title, onclick: () => { sfx.click(); fn(); saveSettings(); this.renderTop(this.view); this.refreshOverlay(); } }, label);
    this.els.top.replaceChildren(
      h('div', { class: 'score' }, h('span', { class: 'p0' }, `${G.players[0].name} · ${G.players[0].score}`), h('span', { class: 'vs' }, `/ ${G.options.targetScore}`), h('span', { class: 'p1' }, `${G.players[1].score} · ${G.players[1].name}`)),
      h('div', { class: 'phase' }, G.phase === 'over' && !this.busy ? 'Battle Over' : `Round ${Math.max(1, G.round)} of ${G.options.maxRounds} · ${PHASE_NAME[this.busy && this.shownPhase ? this.shownPhase : G.phase]}`),
      h('div', { class: 'tools' },
        btn('Tabletop Truth', 'Show bases, templates and firing arcs', () => (s.truth = !s.truth), s.truth),
        btn(`Assist: ${s.assist ? 'On' : 'Pure'}`, 'Ghost preview of your own maneuver while planning', () => (s.assist = !s.assist), s.assist),
        btn(`Action cam: ${s.actionCam}`, 'Cinematic attack camera frequency', () => (s.actionCam = s.actionCam === 'off' ? 'sometimes' : s.actionCam === 'sometimes' ? 'always' : 'off')),
        btn(`${s.speed}×`, 'Animation speed', () => (s.speed = s.speed === 1 ? 2 : 1)),
        btn(s.volume > 0 ? 'Sound on' : 'Muted', 'Toggle sound', () => { s.volume = s.volume > 0 ? 0 : 0.6; setVolume(); }, s.volume > 0),
        h('button', { class: 'chip', onclick: () => { if (this.view.phase === 'over' || confirm('Leave this battle?')) this.exit(); } }, 'Exit'),
      ));
  }

  private exit() { this.session.dispose(); this.scene.reset(); this.labels.forEach(l => l.remove()); this.onExit(); }

  private renderColumns() {
    const G = this.view, me = this.me();
    const col = (p: PlayerId, el: HTMLElement) => el.replaceChildren(
      h('h3', { class: `p${p}` }, `${G.players[p].name}`, h('small', {}, ` ${G.players[p].squadName}${G.firstPlayer === p && G.round > 0 ? ' · first player' : ''}`)),
      ...G.shipOrder.map(id => G.ships[id]).filter(s => s.owner === p).map(s => shipCard(G, s, p === me, p === me ? this.draft[s.id] : undefined, {
        click: () => this.clickShip(s.id), enter: () => { this.hoverShip = s.id; this.refreshOverlay(); }, leave: () => { this.hoverShip = null; this.refreshOverlay(); },
      })));
    col(me, this.els.left); col((1 - me) as PlayerId, this.els.right);
  }

  private send(cmd: Command) { sfx.confirm(); this.hideInteractive(); this.session.send(cmd); }

  private renderPrompt() {
    const G = this.view, P = G.pending, el = this.els.prompt;
    el.replaceChildren(); this.els.center.replaceChildren();
    if (G.phase === 'over') {
      const w = G.winner;
      const title = w === 'draw' ? 'Stalemate' : this.iControl(w as PlayerId) && this.session.local.length === 1 ? 'Victory' : this.session.local.length === 2 ? `${G.players[w as PlayerId].name} wins` : 'Defeat';
      this.els.center.append(h('div', { class: 'panel over' }, h('h1', {}, title), h('p', {}, `${G.players[0].name} ${G.players[0].score} — ${G.players[1].score} ${G.players[1].name}`), h('button', { class: 'primary', onclick: () => this.exit() }, 'Return to hangar')));
      return;
    }
    if (!P) return;

    if (P.type === 'placeShip') {
      if (!this.iControl(P.player)) return void el.append(h('div', { class: 'waiting' }, `${G.players[P.player].name} is deploying…`));
      const s = G.ships[P.shipId];
      this.scene.showZones(true);
      el.append(h('div', { class: 'title' }, `Deploy ${pilotDef(s).name} (${s.label})`), h('div', { class: 'hint' }, 'Click inside your deployment zone. Lowest initiative deploys first.'));
      return;
    }

    if (P.type === 'planning') {
      const me = this.me();
      if (!P.players.includes(me) || !this.iControl(me)) return void el.append(h('div', { class: 'waiting' }, 'Dials locked. Waiting for your opponent…'));
      if (this.session.local.length === 2 && this.lastPlanner !== me && P.players.length === 1 && this.handoffFor !== me) {
        // Hotseat: hide the table hand-off so the second player can't see the first player's ghosts.
        this.handoffFor = me; this.draft = {};
        this.els.center.append(h('div', { class: 'panel' }, h('h2', {}, `Pass to ${G.players[me].name}`), h('p', {}, 'Planning is secret. Hand over the controls.'), h('button', { class: 'primary', onclick: () => { this.lastPlanner = me; this.render(); } }, 'Ready')));
        return;
      }
      this.lastPlanner = me;
      const mine = activeShips(G).filter(s => s.owner === me);
      const missing = mine.filter(s => this.draft[s.id] === undefined);
      el.append(
        h('div', { class: 'title' }, 'Set your dials'),
        h('div', { class: 'hint' }, missing.length ? `Select a ship, then choose its maneuver. ${missing.length} remaining.` : 'All dials set.'),
        h('button', { class: 'primary', disabled: missing.length > 0, onclick: () => { this.handoffFor = null; this.selectedShip = null; this.send({ type: 'setDials', player: me, dials: { ...this.draft } }); this.draft = {}; } }, 'Lock in maneuvers'),
      );
      if (!this.selectedShip || !mine.some(s => s.id === this.selectedShip)) this.selectedShip = missing[0]?.id ?? null;
      if (this.selectedShip) this.openDial(G.ships[this.selectedShip]);
      return;
    }

    if (!this.iControl(P.player)) return void el.append(h('div', { class: 'waiting' }, `${G.players[P.player].name} is deciding…`));
    const ship = P.shipId ? G.ships[P.shipId] : null;
    el.append(h('div', { class: 'title' }, P.prompt));
    const isMod = P.kind === 'modifyAttack' || P.kind === 'modifyDefense';
    if (isMod) { this.showDice = true; this.renderDice(P.kind === 'modifyAttack' ? 'attack' : 'defense'); }
    const row = h('div', { class: 'options' });
    P.options.forEach((o, i) => {
      const cls = o.id === 'pass' || o.id === 'done' || o.id === 'no' || o.id === 'none' ? 'ghostbtn' : o.red ? 'danger' : '';
      row.append(h('button', {
        class: cls, title: o.detail ?? '',
        onmouseenter: () => this.previewOption(o, ship), onmouseleave: () => { this.scene.showGhost(null); this.refreshOverlay(); },
        onclick: () => this.choose(i, o),
      }, this.optionLabel(o)));
    });
    el.append(row);
    if (isMod && P.options.some(o => o.pickDice)) el.append(h('div', { class: 'hint' }, 'Click dice to choose which to reroll (blanks are chosen for you if you pick none).'));
  }

  private optionLabel(o: Option): string {
    const G = this.view;
    if (o.weapon && o.targetId) {
      const t = G.ships[o.targetId], w = o.shipId ? weaponsOf(G.ships[o.shipId]).find(x => x.id === o.weapon) : null;
      const name = w && !w.primary ? CONTENT.upgrades[G.ships[o.shipId!].upgrades[w.upgradeIdx].id].name : 'Primary';
      return `${name} → ${pilotDef(t).name} (${t.label}) · R${o.range}${o.obstructed ? ' · obstructed' : ''}`;
    }
    if (o.action === 'lock' && o.targetId) return `${o.red ? 'Red ' : ''}Lock → ${pilotDef(G.ships[o.targetId]).name} (${G.ships[o.targetId].label})`;
    if (!o.action && o.shipId && G.ships[o.id]) return `${pilotDef(G.ships[o.id]).name} (${G.ships[o.id].label})`;
    return o.label;
  }

  private choose(i: number, o: Option) {
    const P = this.view.pending;
    if (!P || P.type !== 'choice') return;
    let dice: number[] | undefined;
    if (o.pickDice) {
      const pool = P.kind === 'modifyAttack' ? this.view.attack!.attackDice : this.view.attack!.defenseDice;
      const rerolled = P.kind === 'modifyAttack' ? this.view.attack!.attackRerolled : this.view.attack!.defenseRerolled;
      dice = [...this.picked].filter(k => !rerolled[k]);
      if (!dice.length) dice = pool.map((f, k) => ({ f, k })).filter(x => !rerolled[x.k] && x.f === 'blank').map(x => x.k);
      if (!dice.length) dice = pool.map((f, k) => ({ f, k })).filter(x => !rerolled[x.k] && x.f === 'focus').map(x => x.k);
      dice = dice.slice(0, o.pickDice.max);
      if (!dice.length) return this.toast('Select at least one die to reroll.');
    }
    this.picked.clear();
    this.send({ type: 'choose', player: P.player, option: i, dice });
  }

  private renderDice(interactive: 'attack' | 'defense' | null) {
    const A = this.view?.attack;
    if (interactive && A) { this.attackDice = A.attackDice; this.defenseDice = A.defenseDice; }
    if (!this.showDice) return void this.els.dice.replaceChildren();
    const toggle = (i: number) => { if (this.picked.has(i)) this.picked.delete(i); else this.picked.add(i); sfx.click(); this.renderDice(interactive); };
    const canPick = !!interactive && this.view.pending?.type === 'choice' && this.view.pending.options.some(o => o.pickDice);
    this.els.dice.replaceChildren(h('div', { class: 'dicetray-inner' },
      h('div', { class: 'dice-info' }, this.attackInfo),
      diceRow(this.attackDice, 'attack', interactive === 'attack' ? this.picked : null, canPick && interactive === 'attack' ? toggle : undefined),
      this.defenseDice.length ? diceRow(this.defenseDice, 'defense', interactive === 'defense' ? this.picked : null, canPick && interactive === 'defense' ? toggle : undefined) : null,
    ));
  }

  // ---------- planning dial ----------

  private openDial(s: ShipState) {
    const wheel = dialWheel(s, this.draft[s.id] ?? -1,
      e => this.previewDial(s, e ?? (this.draft[s.id] !== undefined ? dialFor(s)[this.draft[s.id]] : null)),
      e => {
        sfx.click(); this.draft[s.id] = e.index;
        const mine = activeShips(this.view).filter(x => x.owner === s.owner);
        this.selectedShip = mine.find(x => this.draft[x.id] === undefined)?.id ?? s.id;
        this.render();
      });
    this.els.center.append(h('div', { class: 'dialwrap' }, h('div', { class: 'dialtitle' }, `${pilotDef(s).name} (${s.label}) · ${shipDef(s).name}`), wheel));
    this.previewDial(s, this.draft[s.id] !== undefined ? dialFor(s)[this.draft[s.id]] : null);
  }

  private previewDial(s: ShipState, e: DialEntry | null) {
    this.scene.clearOverlay();
    this.scene.highlight(s.id, new Color3(0.4, 1, 0.8));
    if (!e || !settings.assist) { this.scene.showGhost(null); return; }
    const pose = previewManeuver(s, e.maneuver);
    this.scene.showTemplate(s.pose, e.maneuver.speed, e.maneuver.bearing, e.difficulty === 'R' ? new Color3(1, 0.3, 0.25) : e.difficulty === 'B' ? new Color3(0.3, 0.6, 1) : new Color3(0.85, 0.9, 1));
    this.scene.showGhost(s, pose, !offTable(pose));
    this.scene.showArc(pose, 'front', new Color3(0.4, 1, 0.8));
  }

  // ---------- scene interaction ----------

  private previewOption(o: Option, ship: ShipState | null) {
    this.scene.clearOverlay();
    if (o.pose && ship) { this.scene.showGhost(ship, o.pose); this.scene.showArc(o.pose, 'front', new Color3(0.4, 1, 0.8)); }
    if (o.targetId) {
      this.scene.highlight(o.targetId, new Color3(1, 0.3, 0.2));
      if (ship && o.arc) { this.scene.showArc(ship.pose, o.arc); const m = measureArc(ship.pose, shipDef(ship).size, o.arc, shipPoly(this.view.ships[o.targetId])); if (m.inArc) this.scene.showLine(m.from, m.to, o.obstructed ? new Color3(1, 0.8, 0.2) : new Color3(1, 0.3, 0.2)); }
    }
    if (!o.action && !o.weapon && this.view.ships[o.id]) this.scene.highlight(o.id, new Color3(0.4, 1, 0.8));
  }

  private refreshOverlay() {
    if (this.busy || !this.view) return;
    const P = this.view.pending;
    if (P?.type === 'planning' && this.selectedShip && this.els.center.childElementCount) return; // dial preview owns the overlay
    this.scene.clearOverlay();
    const focusId = this.hoverShip ?? (P?.type === 'choice' ? P.shipId : null);
    const s = focusId ? this.view.ships[focusId] : null;
    if (s && s.placed && !s.removed) {
      const color = s.owner === 0 ? new Color3(1, 0.45, 0.25) : new Color3(0.3, 1, 0.55);
      for (const w of weaponsOf(s)) this.scene.showArc(s.pose, w.arc, color);
      if (settings.truth) this.scene.showRangeRings(s.pose);
      this.scene.highlight(s.id, color);
    }
  }

  private clickShip(id: string) {
    const G = this.view, P = G?.pending;
    if (this.busy || !P) return;
    if (P.type === 'planning') {
      const s = G.ships[id];
      if (s.owner === this.me() && this.iControl(s.owner) && !s.removed && !s.destroyed) { sfx.click(); this.selectedShip = id; this.render(); }
      return;
    }
    if (P.type !== 'choice' || !this.iControl(P.player)) return;
    const i = P.options.findIndex(o => o.id === id || o.targetId === id);
    if (i >= 0 && !P.options[i].pickDice) this.choose(i, P.options[i]);
  }

  private deployPose(x: number, y: number): Pose {
    const me = (this.view.pending as any).player as PlayerId;
    const cx = Math.max(20, Math.min(PLAY_AREA - 20, x));
    return me === 0 ? { x: cx, y: Math.max(20, Math.min(80, y)), r: Math.PI / 2 } : { x: cx, y: Math.min(PLAY_AREA - 20, Math.max(PLAY_AREA - 80, y)), r: -Math.PI / 2 };
  }

  private groundMove(x: number, y: number) {
    const P = this.view?.pending;
    if (this.busy || P?.type !== 'placeShip' || !this.iControl(P.player)) return;
    const s = this.view.ships[P.shipId], pose = this.deployPose(x, y);
    this.scene.showGhost(s, pose, deploymentValid(this.view, s, pose));
  }

  private groundClick(x: number, y: number) {
    const P = this.view?.pending;
    if (this.busy || P?.type !== 'placeShip' || !this.iControl(P.player)) return;
    const s = this.view.ships[P.shipId], pose = this.deployPose(x, y);
    if (!deploymentValid(this.view, s, pose)) return this.toast('Cannot deploy there.');
    this.send({ type: 'placeShip', player: P.player, shipId: s.id, pose });
  }

  // ---------- floating labels ----------

  private updateLabels() {
    const G = this.view; if (!G) return;
    const seen = new Set<string>();
    for (const s of Object.values(G.ships)) {
      const pos = s.placed && !s.removed ? this.scene.screenPos(s.id) : null;
      if (!pos || !pos.visible) continue;
      seen.add(s.id);
      let el = this.labels.get(s.id);
      if (!el) { el = h('div', { class: `shiplabel p${s.owner}` }); this.els.labels.append(el); this.labels.set(s.id, el); }
      const tok = Object.entries(s.tokens).filter(([, n]) => n > 0).map(([k, n]) => `<i class="t-${k}" title="${k}">${n > 1 ? n : ''}</i>`).join('');
      const html = `<b>${s.label}</b><span>${s.hull - s.damage.length}${s.shieldsMax ? `<em>+${s.shields}</em>` : ''}</span>${tok}${s.lock ? '<i class="t-lock" title="has lock"></i>' : ''}`;
      if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
      el.style.transform = `translate(${pos.x}px, ${pos.y}px) translate(-50%, -100%)`;
    }
    for (const [id, el] of this.labels) if (!seen.has(id)) { el.remove(); this.labels.delete(id); }
  }
}

function offTable(p: Pose): boolean { return p.x < 20 || p.y < 20 || p.x > PLAY_AREA - 20 || p.y > PLAY_AREA - 20; }
