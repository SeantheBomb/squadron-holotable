// Correspondence screen: fetch your turn, fill it in, submit, close the tab.
//
// Nothing here waits on the opponent. Every stage asks for all of your ships at once, so a turn is
// one sitting: place the whole squadron, set every dial, choose every action, declare every attack.
import { Color3 } from '@babylonjs/core';
import {
  CONTENT, PLAY_AREA, activeShips, attackOptions, deploymentValid, dialFor, isStressed, offeredActions,
  pilotDef, previewManeuver, shipDef,
} from '@holotable/rules';
import type { DialEntry, GameEvent, GameState, Option, PlayerId, Pose, ShipState } from '@holotable/rules';
import type { GameScene } from './scene';
import { dialWheel, h, shipCard } from './hud';
import { getTurn, postTurn, serverUrl, socketAuth } from './account';
import { allSquads } from './menu';
import { sfx } from './audio';
import { settings } from './settings';

interface TurnView {
  you: number; started: boolean; stage: string; waitingOn: number | null; yourTurn: boolean;
  seats: { name: string; squad: string | null; faction: string | null; ready: boolean }[];
  view: GameState | null; since: any[]; error?: string;
}

const STAGE_TITLE: Record<string, string> = {
  deploy: 'Deploy your squadron', dials: 'Set your dials',
  actions: 'Choose your actions', attacks: 'Declare your attacks', decision: 'Your move',
};

export function showCorrespondence(scene: GameScene, ui: HTMLElement, code: string, onExit: () => void) {
  let turn: TurnView | null = null;
  let error = '', busy = false;
  // local draft for this sitting
  let deploy: Record<string, Pose> = {};
  let dials: Record<string, number> = {};
  let choices: { kind: string; shipId?: string; option: string }[] = [];
  let selected: string | null = null;
  let placingIdx = 0;
  let squadPick = 0;
  let camDone = false;
  // A read marks events seen server-side, so polling would wipe the summary a few seconds after it
  // appeared. Hold on to it until the player actually takes their turn.
  let summary: any[] = [];
  let replaying = false, skipReplay = false;

  const root = h('div', { class: 'game corr' });
  const els = {
    top: h('div', { class: 'topbar' }), left: h('div', { class: 'column left' }), right: h('div', { class: 'column right' }),
    panel: h('div', { class: 'corrpanel' }), centre: h('div', { class: 'center' }),
    log: h('div', { class: 'log' }),
  };
  root.append(els.top, els.left, els.right, els.log, els.centre, els.panel);
  ui.replaceChildren(root);

  const me = () => (turn?.you ?? 0) as PlayerId;
  const G = () => turn!.view!;
  const myShips = () => activeShips(G()).filter(s => s.owner === me());
  /** Deployment happens before any ship is on the board, so activeShips() would be empty. */
  const mySquadron = () => Object.values(G().ships).filter(s => s.owner === me() && !s.removed);

  // ---------- board ----------
  const syncBoard = () => {
    if (!turn?.view) return;
    scene.setViewer(me());
    scene.setHolo(turn.stage === 'dials' || turn.stage === 'deploy');
    scene.sync(turn.view);
    scene.clearOverlay();
    if (turn.stage === 'deploy' && turn.yourTurn) {
      scene.showZones(true);
      for (const [id, pose] of Object.entries(deploy)) scene.showPlacement(pose, new Color3(0.4, 1, 0.8), id);
      if (!camDone) { camDone = true; void scene.deployCamera(me()); }
    } else scene.showZones(false);
  };

  // ---------- keeping up to date without being asked ----------
  // A socket, not a poll. The server sends a nudge when the match actually moves on, so this sits
  // silent and costs nothing while you are waiting. If the connection drops it reconnects and
  // catches up; there is no interval guessing and nothing to give up on.
  let socket: WebSocket | null = null;
  let reconnectTimer = 0, reconnectIn = 1000, disposed = false, pendingCatchUp = false;
  let connected = false;
  const pageTitle = document.title;

  function listen() {
    if (disposed) return;
    try {
      socket = new WebSocket(`${serverUrl().replace(/^http/, 'ws')}/api/rooms/${code}/ws${socketAuth()}`);
    } catch { return retry(); }
    socket.onopen = () => {
      connected = true; reconnectIn = 1000;
      socket?.send(JSON.stringify({ type: 'watch' }));
      void catchUp();                       // anything that happened while we were away
      render();
    };
    socket.onmessage = e => {
      try { if (JSON.parse(e.data).type !== 'turn') return; } catch { return; }
      void catchUp();
    };
    socket.onclose = () => { connected = false; socket = null; render(); retry(); };
    socket.onerror = () => { try { socket?.close(); } catch { /* already gone */ } };
  }

  function retry() {
    if (disposed) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectIn = Math.min(30_000, reconnectIn * 2); listen(); }, reconnectIn) as unknown as number;
  }

  /** Fetch the authoritative turn. Held back during a replay so playback is never interrupted. */
  async function catchUp() {
    if (disposed) return;
    if (replaying) { pendingCatchUp = true; return; }
    const wasMine = !!turn?.yourTurn;
    try {
      const next = await getTurn(code);
      if (disposed) return;
      if (!wasMine && next.yourTurn) announce();
      await replay(next, (next.since ?? []) as GameEvent[]);
    } catch { /* the socket will reconnect and try again */ }
  }

  /** It just became your move and you may not be looking at this tab. */
  function announce() {
    sfx.phase();
    document.title = `● Your turn · ${pageTitle}`;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('Your turn', { body: `${turn?.seats[1 - (turn?.you ?? 0)]?.name ?? 'Your opponent'} has moved.`, tag: `holotable-${code}` });
      }
    } catch { /* notifications are a courtesy, never a requirement */ }
  }

  // Coming back to the tab is a good moment to make sure nothing was missed.
  const onVisibility = () => { if (!document.hidden) void catchUp(); };
  document.addEventListener('visibilitychange', onVisibility);

  const dispose = () => {
    disposed = true;
    clearTimeout(reconnectTimer);
    document.removeEventListener('visibilitychange', onVisibility);
    try { socket?.close(); } catch { /* already gone */ }
    document.title = pageTitle;
  };

  // ---------- watching what happened ----------

  /**
   * Correspondence would otherwise teleport every ship to its new spot, which makes a round
   * impossible to follow. The scene already knows how to fly a maneuver, so wind the board back to
   * where the ships started and play the round through.
   */
  function rewind(view: GameState, events: GameEvent[]): GameState {
    const start = structuredClone(view);
    const moved = new Set<string>();
    for (const e of events as any[]) {
      if (e.t === 'move' && !moved.has(e.shipId)) {
        moved.add(e.shipId);
        const s = start.ships[e.shipId];
        if (s) { s.pose = e.from; s.placed = true; }
      }
      // A ship that died this round has to be on the board again for us to watch it die.
      if ((e.t === 'removed' || e.t === 'destroyed') && start.ships[e.shipId]) {
        start.ships[e.shipId].removed = false;
        start.ships[e.shipId].destroyed = false;
      }
    }
    return start;
  }

  async function replay(next: TurnView, events: GameEvent[]) {
    // Movement is the obvious one, but an exchange of fire is worth watching too — the engagement
    // resolves on the actions submission, with no movement in that batch at all.
    const WATCH = new Set(['move', 'attackResult', 'destroyed', 'obstacle']);
    const worthWatching = events.some(e => WATCH.has((e as any).t));
    if (!worthWatching || document.hidden || !next.view) { turn = next; syncBoard(); render(); return; }

    replaying = true; skipReplay = false;
    turn = next;
    render();                                   // shows the replay banner and a Skip button
    scene.showGhost(null);
    scene.clearOverlay();
    scene.setHolo(false);                       // out of the planning hologram, into the real thing
    scene.sync(rewind(next.view, events));
    void scene.cinematicCamera();
    try {
      for (const ev of events) {
        if (skipReplay) break;
        await scene.play(ev as any, next.view);
      }
    } catch { /* a replay is a courtesy; never let it strand the turn */ }
    await scene.endAttack();
    replaying = false;
    syncBoard(); render();
    if (pendingCatchUp) { pendingCatchUp = false; void catchUp(); }
  }

  // ---------- stage panels ----------
  function deployPanel(): HTMLElement {
    const ships = mySquadron().filter(s => !s.placed);
    const pending = ships.filter(s => !deploy[s.id]);
    const next = pending[0];
    placingIdx = ships.length - pending.length;
    scene.onGroundMove = (x, y) => {
      if (!next) return;
      const pose = snap(x, y);
      scene.showGhost(next, pose, deploymentValid(G(), next, pose) && !overlapsDraft(next, pose));
    };
    scene.onGroundClick = (x, y) => {
      if (!next) return;
      const pose = snap(x, y);
      if (!deploymentValid(G(), next, pose) || overlapsDraft(next, pose)) { error = 'Cannot deploy there.'; render(); return; }
      deploy[next.id] = pose; sfx.click(); render(); syncBoard();
    };
    return h('div', {},
      h('p', { class: 'hint' }, next
        ? `Click inside the glowing strip to place ${pilotDef(next).name} (${placingIdx + 1} of ${ships.length}).`
        : 'All ships placed. Submit when you are happy.'),
      h('div', { class: 'chips' }, ...ships.map(s => h('button', {
        class: `chip${deploy[s.id] ? ' on' : ''}`,
        onclick: () => { delete deploy[s.id]; render(); syncBoard(); },
      }, `${pilotDef(s).name}${deploy[s.id] ? ' ✓' : ''}`))),
      ships.some(s => deploy[s.id]) ? h('p', { class: 'hint' }, 'Click a placed ship above to move it.') : h('span', {}));
  }

  const snap = (x: number, y: number): Pose => {
    const cx = Math.max(22, Math.min(PLAY_AREA - 22, x));
    return me() === 0
      ? { x: cx, y: Math.max(22, Math.min(78, y)), r: Math.PI / 2 }
      : { x: cx, y: Math.min(PLAY_AREA - 22, Math.max(PLAY_AREA - 78, y)), r: -Math.PI / 2 };
  };
  const overlapsDraft = (ship: ShipState, pose: Pose) =>
    Object.entries(deploy).some(([id, p]) => id !== ship.id && Math.hypot(p.x - pose.x, p.y - pose.y) < 44);

  function dialsPanel(): HTMLElement {
    const ships = myShips();
    if (!selected || !ships.some(s => s.id === selected)) selected = ships.find(s => dials[s.id] === undefined)?.id ?? ships[0]?.id ?? null;
    const ship = ships.find(s => s.id === selected);
    if (ship) {
      const wheel = dialWheel(ship, dials[ship.id] ?? -1,
        e => previewDial(ship, e ?? (dials[ship.id] !== undefined ? dialFor(ship)[dials[ship.id]] : null)),
        e => {
          sfx.click(); dials[ship.id] = e.index;
          selected = ships.find(s => dials[s.id] === undefined)?.id ?? ship.id;
          render();
        });
      els.centre.replaceChildren(h('div', { class: 'dialwrap' },
        h('div', { class: 'dialtitle' }, `${pilotDef(ship).name} · ${shipDef(ship).name}`), wheel));
      previewDial(ship, dials[ship.id] !== undefined ? dialFor(ship)[dials[ship.id]] : null);
    }
    const left = ships.filter(s => dials[s.id] === undefined).length;
    return h('div', {}, h('p', { class: 'hint' }, left ? `${left} ship${left > 1 ? 's' : ''} still need a maneuver.` : 'Every dial is set.'));
  }

  const previewDial = (s: ShipState, e: DialEntry | null) => {
    scene.clearOverlay();
    scene.highlight(s.id, new Color3(0.4, 1, 0.8));
    if (!e || !settings.assist) { scene.showGhost(null); return; }
    const pose = previewManeuver(s, e.maneuver);
    scene.showTemplate(s.pose, e.maneuver.speed, e.maneuver.bearing,
      e.difficulty === 'R' ? new Color3(1, 0.3, 0.25) : e.difficulty === 'B' ? new Color3(0.3, 0.6, 1) : new Color3(0.85, 0.9, 1));
    scene.showGhost(s, pose);
    scene.showArc(pose, 'front', new Color3(0.4, 1, 0.8));
  };

  /**
   * One row per ship, every round, for the whole squadron — orders for all of them in a single pass.
   *
   * The engine clears a ship's owed action the moment it raises that ship's prompt, so the ship
   * being asked about looks like it has nothing to offer. Its real options are on the pending
   * decision, so take them from there; otherwise the player never sees that ship at all.
   */
  function choicePanel(kind: 'action' | 'attack'): HTMLElement {
    const P = G().pending;
    const promptedId = P && P.type === 'choice' && P.player === me() && P.kind === kind ? P.shipId : null;
    const optionsFor = (s: ShipState): Option[] =>
      s.id === promptedId && P && P.type === 'choice'
        ? P.options.filter(o => o.id !== 'pass')
        : (kind === 'action' ? offeredActions(G(), s) : attackOptions(G(), s));

    const rows = myShips().map(s => ({ s, options: optionsFor(s) }));
    const live = rows.filter(r => r.options.length);
    if (!live.length) {
      return h('div', {},
        h('p', { class: 'hint' }, kind === 'action'
          ? 'No ship can act this round. Submit to move on.'
          : 'No ship has a target in arc. Submit to hold fire.'));
    }
    for (const { s: ship } of live) if (!choices.some(c => c.kind === kind && c.shipId === ship.id)) choices.push({ kind, shipId: ship.id, option: 'pass' });
    const chosen = (id: string) => choices.find(c => c.kind === kind && c.shipId === id)?.option;
    const set = (id: string, option: string) => {
      // 'pass' is a real option on the prompt. Recording it explicitly is what stops the assistant
      // from deciding you must have wanted something after all.
      choices = choices.filter(c => !(c.kind === kind && c.shipId === id));
      choices.push({ kind, shipId: id, option });
      sfx.click(); render();
    };
    const why = (s: ShipState) => kind === 'action'
      ? (isStressed(s) ? 'Stressed — cannot act' : 'Nothing to do this round')
      : 'No target in arc';

    return h('div', { class: 'choicerows' }, ...rows.map(({ s, options }) => h('div', { class: `choicerow${options.length ? '' : ' idle'}` },
      h('div', { class: 'choicewho' }, h('b', {}, pilotDef(s).name), h('small', {}, ` ${shipDef(s).name}`)),
      options.length
        ? h('div', { class: 'choiceopts' },
          ...options.map(o => h('button', {
            class: chosen(s.id) === o.id ? 'primary' : (o.red ? 'danger' : ''),
            onmouseenter: () => previewOption(s, o), onmouseleave: () => syncBoard(),
            onclick: () => set(s.id, o.id),
          }, label(o, kind))),
          h('button', { class: chosen(s.id) === 'pass' ? 'primary' : 'ghostbtn', onclick: () => set(s.id, 'pass') },
            kind === 'action' ? 'No action' : 'Hold fire'))
        : h('div', { class: 'choiceopts' }, h('span', { class: 'dim' }, why(s))))));
  }

  const label = (o: Option, kind: string) => {
    if (kind === 'attack' && o.targetId) {
      const t = G().ships[o.targetId];
      const w = o.weapon === 'primary' ? 'Primary' : (CONTENT.upgrades[G().ships[o.shipId!].upgrades[Number(o.weapon!.slice(2))]?.id]?.name ?? 'Weapon');
      return `${w} → ${pilotDef(t).name} · R${o.range}${o.obstructed ? ' ·obs' : ''}`;
    }
    return o.label;
  };

  const previewOption = (s: ShipState, o: Option) => {
    scene.clearOverlay();
    if (o.pose) { scene.showGhost(s, o.pose); scene.showArc(o.pose, 'front', new Color3(0.4, 1, 0.8)); }
    if (o.targetId) { scene.highlight(o.targetId, new Color3(1, 0.3, 0.2)); if (o.arc) scene.showArc(s.pose, o.arc); }
  };


  /** Before the match starts: choose a squadron and ready up, each side at their own pace. */
  function lobbyPanel(): HTMLElement {
    const t = turn!;
    const sq = allSquads();
    const mine = t.seats[t.you], theirs = t.seats[1 - t.you];
    const clash = !!(mine?.faction && theirs?.faction && mine.faction === theirs.faction);
    const send = async (body: any) => {
      busy = true; render();
      try { turn = await postTurn(code, body); error = ''; } catch (e: any) { error = e.message; }
      busy = false; syncBoard(); render();
    };
    return h('div', { class: 'lobbybody' },
      h('div', { class: 'seats' },
        ...[t.you, 1 - t.you].map(i => {
          const s = t.seats[i];
          return h('div', { class: `seat${s?.ready ? ' ready' : ''}` },
            h('div', { class: 'seat-who' }, h('b', {}, s?.name ?? 'Waiting for a pilot…'), h('small', {}, i === t.you ? 'you' : 'opponent')),
            h('div', { class: 'seat-squad' }, s?.squad
              ? h('span', {}, s.squad, h('em', {}, ` ${s.faction ? CONTENT.factions[s.faction]?.name ?? s.faction : ''}`))
              : h('span', { class: 'dim' }, i === t.you ? 'Choose a squadron' : 'Choosing…')),
            h('div', { class: 'seat-state' }, s ? (s.ready ? 'READY' : 'Not ready') : ''));
        })),
      clash ? h('p', { class: 'warn-line' }, `Both squadrons are ${CONTENT.factions[mine!.faction!]?.name ?? mine!.faction}. Legal, but the two sides will look alike.`) : h('span', {}),
      h('label', {}, 'Your squadron', h('select', {
        disabled: !!mine?.ready,
        onchange: (e: Event) => { squadPick = Number((e.target as HTMLSelectElement).value); void send({ squad: sq[squadPick] }); },
      }, ...sq.map((x, i) => h('option', { value: i, selected: i === squadPick }, `${x.name} — ${CONTENT.factions[x.faction]?.name ?? x.faction}`)))),
      h('div', { class: 'rowgap' },
        h('button', { class: mine?.ready ? 'primary on' : 'primary', disabled: busy || !mine?.squad, onclick: () => send({ ready: !mine?.ready }) },
          mine?.ready ? 'Ready — waiting for them' : 'Ready up'),
        h('button', { onclick: () => refresh() }, 'Refresh')),
      h('p', { class: 'hint' }, theirs ? 'The match starts when you are both ready.' : `Send them the room code ${code} — they can join whenever.`),
      liveLine());
  }

  /** Says whether the page is watching for the opponent, and offers a way back if it gave up. */
  function liveLine(): HTMLElement {
    return h('div', { class: 'liveline' },
      h('span', { class: `livedot${connected ? '' : ' off'}` }),
      h('span', { class: 'dim' }, connected ? 'Listening for their move' : 'Reconnecting…'),
      h('button', { class: 'chip', onclick: () => refresh() }, 'Check now'),
      'Notification' in window && Notification.permission === 'default'
        ? h('button', { class: 'chip', onclick: () => void Notification.requestPermission().then(() => render()) }, 'Alert me')
        : h('span', {}));
  }

  // ---------- submit ----------
  const ready = (): boolean => {
    if (!turn?.yourTurn) return false;
    if (turn.stage === 'deploy') { const sq = mySquadron().filter(s => !s.placed); return sq.length > 0 && sq.every(s => deploy[s.id]); }
    if (turn.stage === 'dials') return myShips().every(s => dials[s.id] !== undefined);
    return true; // actions and attacks may legitimately be empty
  };

  const submit = async () => {
    if (busy || !ready()) return;
    busy = true; error = ''; render();
    const packet: any = { policy: { dice: 'assist', abilities: 'assist' } };
    packet.stage = turn!.stage;
    if (turn!.stage === 'deploy') packet.deploy = deploy;
    else if (turn!.stage === 'dials') packet.dials = dials;
    else packet.choices = choices;
    try {
      const next = await postTurn(code, { packet });
      deploy = {}; dials = {}; choices = []; selected = null; summary = [];
      sfx.confirm();
      busy = false;
      await replay(next, (next.since ?? []) as GameEvent[]);
      return;
    } catch (e: any) { error = e.message; }
    busy = false;
    syncBoard(); render();
  };

  // ---------- chrome ----------

  function renderTop(t: TurnView) {
    els.top.replaceChildren(
      h('div', { class: 'score' }, h('span', { class: `p${t.you}` }, t.seats[t.you]?.name ?? 'You'),
        h('span', { class: 'vs' }, ' vs '), h('span', { class: `p${1 - t.you}` }, t.seats[1 - t.you]?.name ?? 'waiting…')),
      h('div', { class: 'phase' }, replaying ? 'Playing back the round'
        : t.view ? `Round ${Math.max(1, t.view.round)} · ${t.yourTurn ? STAGE_TITLE[t.stage] ?? t.stage : 'their turn'}` : 'Getting ready'),
      h('div', { class: 'tools' },
        h('button', { class: 'chip', onclick: () => refresh() }, 'Refresh'),
        h('button', { class: 'chip', onclick: () => { dispose(); onExit(); } }, 'Back')));
  }

  function render() {
    if (!turn) { els.panel.replaceChildren(h('div', { class: 'waiting' }, 'Loading your turn…')); return; }
    const t = turn;
    document.title = t.yourTurn ? `● Your turn · ${pageTitle}` : pageTitle;

    if (replaying) {
      els.centre.replaceChildren();
      els.panel.replaceChildren(
        h('div', { class: 'title' }, 'Playing back the round'),
        h('p', { class: 'hint' }, 'Watch where everyone ended up.'),
        h('button', { class: 'chip', onclick: () => { skipReplay = true; } }, 'Skip to the end'));
      renderTop(t);
      return;
    }
    const them = t.seats[1 - t.you];
    renderTop(t);

    if (t.view) {
      const theirs = Object.values(t.view.ships).filter(s => s.owner !== t.you);
      els.left.replaceChildren(
        h('h3', { class: `p${t.you}` }, 'Your squadron'),
        ...(t.stage === 'deploy' ? mySquadron() : myShips()).map(s => shipCard(t.view!, s, true, dials[s.id], {
          click: () => { selected = s.id; render(); }, enter: () => {}, leave: () => {},
        })));
      // Their cards come from the same redacted view the board does: hidden dials stay hidden and
      // facedown damage stays facedown, so there is nothing here you are not allowed to know.
      els.right.replaceChildren(
        h('h3', { class: `p${1 - t.you}` }, t.seats[1 - t.you]?.name ?? 'Opponent'),
        ...theirs.map(s => shipCard(t.view!, s, false, undefined, {
          click: () => {}, enter: () => { scene.clearOverlay(); if (s.placed && !s.removed) scene.highlight(s.id, new Color3(1, 0.35, 0.2)); },
          leave: () => syncBoard(),
        })));
    }

    if (t.since?.length) summary = t.since;
    const lines = summary.length ? summarise(summary, t.view) : [];
    els.log.innerHTML = lines.length ? `<div class="sep">Since your last turn</div>${lines.map(l => `<div>${l}</div>`).join('')}` : '';

    if (!t.started) {
      els.centre.replaceChildren();
      els.panel.replaceChildren(h('div', { class: 'title' }, `Room ${code}`), lobbyPanel());
      return;
    }

    if (!t.yourTurn) {
      els.centre.replaceChildren();
      els.panel.replaceChildren(
        h('div', { class: 'title' }, `Waiting for ${them?.name ?? 'your opponent'}`),
        h('p', { class: 'hint' }, 'Nothing to do right now — this page updates itself when they move.'),
        liveLine());
      return;
    }

    if (t.stage !== 'dials') els.centre.replaceChildren();
    const body = t.stage === 'deploy' ? deployPanel()
      : t.stage === 'dials' ? dialsPanel()
      : t.stage === 'actions' ? choicePanel('action')
      : t.stage === 'attacks' ? choicePanel('attack')
      : h('p', { class: 'hint' }, 'Nothing to decide.');

    // replaceChildren is native DOM and will not take a null, unlike our own h() helper.
    els.panel.replaceChildren(...[
      h('div', { class: 'title' }, STAGE_TITLE[t.stage] ?? t.stage),
      body,
      error ? h('p', { class: 'err' }, error) : null,
      h('button', { class: 'primary big', disabled: busy || !ready(), onclick: submit }, busy ? 'Sending…' : 'Submit turn'),
    ].filter((n): n is HTMLElement => !!n));
  }

  async function refresh() {
    if (replaying) return;
    error = '';
    await catchUp();
  }

  scene.onShipClick = id => { if (turn?.view?.ships[id]?.owner === me()) { selected = id; render(); } };
  render();
  listen();          // opens the socket, which fetches the current turn once connected
  void catchUp();    // ...and do not wait on the handshake to show something
}

/** A short, readable account of what the opponent did while you were away. */
function summarise(events: any[], G: GameState | null): string[] {
  const name = (id: string) => (G?.ships[id] ? pilotDef(G.ships[id]).name : id);
  const out: string[] = [];
  for (const e of events) {
    if (e.t === 'attackResult') out.push(e.hit ? `<b>${name(e.attacker)}</b> hit <b>${name(e.defender)}</b> for ${e.hits + e.crits}` : `${name(e.attacker)} missed ${name(e.defender)}`);
    else if (e.t === 'destroyed') out.push(`<span class="kill">${name(e.shipId)} was destroyed</span>`);
    else if (e.t === 'removed' && e.reason === 'fled') out.push(`<span class="kill">${name(e.shipId)} fled the battlefield</span>`);
    else if (e.t === 'crit') out.push(`<span class="warn">Critical: ${e.name}</span>`);
    else if (e.t === 'obstacle') out.push(`${name(e.shipId)} clipped ${e.kind === 'gas' ? 'a gas cloud' : e.kind}`);
  }
  return out.slice(-14);
}
