// DOM helpers and the pieces of HUD that are pure functions of the view.
import { CONTENT, dialFor, pilotDef, shipDef } from '@holotable/rules';
import type { Bearing, DialEntry, Face, GameState, ShipState } from '@holotable/rules';
import { term } from './pack';

type Child = Node | string | null | undefined | false;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, any> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, val] of Object.entries(attrs)) {
    if (val === undefined || val === null || val === false) continue;
    if (k === 'class') el.className = val;
    else if (k === 'html') el.innerHTML = val;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), val);
    else if (k === 'style' && typeof val === 'object') Object.assign(el.style, val);
    else el.setAttribute(k, String(val));
  }
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

// ---------- glyphs (original artwork, simple on purpose) ----------

const FACE_SVG: Record<Face, string> = {
  hit: '<path d="M12 2l2.4 6.2L21 6l-3.4 5.8L22 16l-6.6.4L14 22l-2-5.6L6 20l2-6.2L2 10l6.4-.6z" fill="currentColor"/>',
  crit: '<path d="M12 1l2.6 6.4L21 5l-3 6.2L23 16l-7 .2L14 23l-2-6-6 3.4 2.2-6.6L1 10l7-.4z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
  focus: '<path d="M2 12c3-5 6.5-7 10-7s7 2 10 7c-3 5-6.5 7-10 7s-7-2-10-7z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  evade: '<path d="M4 18c2-9 8-13 16-12M20 6l-5-2.5M20 6l-2.5 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
  blank: '',
};
export const faceIcon = (f: Face) => `<svg viewBox="0 0 24 24" width="100%" height="100%">${FACE_SVG[f]}</svg>`;

const ARROWS: Record<Bearing, string> = {
  F: 'M12 21V6M12 3l-4 5h8z', K: 'M9 21V9a4 4 0 018 0v6M17 19l-3.5-4.5h7z',
  B: 'M15 21v-6q0-5-6-9M7 4l1.2 6 4.3-4.2z', N: 'M9 21v-6q0-5 6-9M17 4l-1.2 6-4.3-4.2z',
  T: 'M16 21v-9q0-3-3-3H8M4 9l5-4v8z', Y: 'M8 21v-9q0-3 3-3h5M20 9l-5-4v8z',
  L: 'M16 21v-5q0-5-6-8M10 8q-4-1-4 5M6 16l-3-4.5h6z', P: 'M8 21v-5q0-5 6-8M14 8q4-1 4 5M18 16l3-4.5h-6z',
  E: 'M17 21v-9q0-3-3-3H8v5M8 17l-3.5-4.5h7z', R: 'M7 21v-9q0-3 3-3h6v5M16 17l3.5-4.5h-7z',
  O: 'M8 8h8v8H8z', S: 'M12 3v15M12 21l-4-5h8z',
  A: 'M15 3v6q0 5-6 9M7 20l1.2-6 4.3 4.2z', D: 'M9 3v6q0 5 6 9M17 20l-1.2-6-4.3 4.2z',
};
export const arrowIcon = (b: Bearing) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="${ARROWS[b]}" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" fill-rule="evenodd"/></svg>`;

const DIFF_CLASS = { B: 'blue', W: 'white', R: 'red' } as const;
const BEARING_NAME: Record<Bearing, string> = { F: 'straight', K: 'K-turn', B: 'bank left', N: 'bank right', T: 'turn left', Y: 'turn right', L: 'loop left', P: 'loop right', E: 'roll left', R: 'roll right', O: 'stop', S: 'reverse', A: 'reverse left', D: 'reverse right' };
export const maneuverName = (e: { maneuver: { speed: number; bearing: Bearing } }) => `${e.maneuver.speed} ${BEARING_NAME[e.maneuver.bearing]}`;

// ---------- polar maneuver dial ----------

const ANGLE: Record<Bearing, number> = { T: -72, B: -36, F: 0, N: 36, Y: 72, E: -112, R: 112, L: -148, P: 148, K: 180, S: 180, A: -160, D: 160, O: 0 };

export function dialWheel(ship: ShipState, selected: number, onHover: (e: DialEntry | null) => void, onPick: (e: DialEntry) => void): HTMLElement {
  const entries = dialFor(ship);
  const maxSpeed = Math.max(...entries.map(e => e.maneuver.speed));
  const size = 150 + maxSpeed * 64;
  const wheel = h('div', { class: 'dial', style: { width: `${size}px`, height: `${size}px` } });
  for (let sp = 1; sp <= maxSpeed; sp++) {
    const r = 30 + sp * 32;
    wheel.append(h('div', { class: 'dial-ring', style: { width: `${r * 2}px`, height: `${r * 2}px` } }));
  }
  wheel.append(h('div', { class: 'dial-hub', html: `<b>${ship.label}</b>` }));
  for (const e of entries) {
    const b = e.maneuver.bearing;
    const r = b === 'O' ? 0 : 30 + e.maneuver.speed * 32, a = (ANGLE[b] * Math.PI) / 180;
    const btn = h('button', {
      class: `dial-btn ${DIFF_CLASS[e.difficulty]}${e.index === selected ? ' selected' : ''}`, disabled: !e.allowed, title: `${maneuverName(e)}${e.allowed ? '' : ' — stressed'}`,
      style: { left: `${size / 2 + Math.sin(a) * r}px`, top: `${size / 2 - Math.cos(a) * r}px` }, html: `${arrowIcon(b)}<i>${e.maneuver.speed}</i>`,
      onmouseenter: () => onHover(e), onmouseleave: () => onHover(null), onclick: () => onPick(e),
    });
    wheel.append(btn);
  }
  return wheel;
}

// ---------- ship cards ----------

const pips = (n: number, max: number, cls: string) => h('span', { class: 'pips' }, ...Array.from({ length: max }, (_, i) => h('i', { class: `${cls}${i < n ? '' : ' off'}` })));
const TOKEN_LABEL: Record<string, string> = { focus: 'Focus', evade: 'Evade', calculate: 'Calc', stress: 'Stress', strain: 'Strain', ion: 'Ion', disarm: 'Disarm' };

export function shipCard(G: GameState, s: ShipState, mine: boolean, draftDial: number | undefined, handlers: { click: () => void; enter: () => void; leave: () => void }): HTMLElement {
  const p = pilotDef(s), d = shipDef(s);
  const hull = s.hull - s.damage.length;
  const dead = s.removed || s.destroyed;
  const card = h('div', { class: `card ${mine ? 'mine' : 'foe'}${dead ? ' dead' : ''}`, onclick: handlers.click, onmouseenter: handlers.enter, onmouseleave: handlers.leave });
  card.append(
    h('div', { class: 'card-head' }, h('span', { class: 'init' }, String(s.initiative)), h('span', { class: 'name' }, p.name), h('span', { class: 'tag' }, s.label)),
    h('div', { class: 'card-sub' }, `${d.name} · ${s.cost} pts${p.caption ? ' · ' + p.caption : ''}`),
  );
  if (dead) { card.append(h('div', { class: 'card-sub' }, s.fled ? 'Fled the battle' : 'Destroyed')); return card; }
  card.append(h('div', { class: 'stats' },
    h('span', { class: 'stat atk', title: 'Attack' }, String(d.attack)), h('span', { class: 'stat agi', title: 'Agility' }, String(d.agility)),
    pips(hull, s.hull, 'hull'), s.shieldsMax ? pips(s.shields, s.shieldsMax, 'shield') : null,
    s.forceMax ? h('span', { class: 'force', title: term('force') }, pips(s.force, s.forceMax, 'forcepip')) : null,
  ));
  const tokens = h('div', { class: 'tokens' });
  for (const [k, n] of Object.entries(s.tokens)) if (n > 0) tokens.append(h('span', { class: `tok ${k}` }, `${TOKEN_LABEL[k]}${n > 1 ? ' ×' + n : ''}`));
  if (s.lock) tokens.append(h('span', { class: 'tok lock' }, `Lock → ${G.ships[s.lock] ? pilotDef(G.ships[s.lock]).name : '?'}`));
  for (const o of Object.values(G.ships)) if (o.lock === s.id && !o.removed) tokens.append(h('span', { class: 'tok locked' }, `Locked by ${o.label}`));
  if (s.turret) tokens.append(h('span', { class: 'tok turret' }, `Turret: ${s.turret}`));
  if (tokens.childElementCount) card.append(tokens);
  if (p.text && p.ability) card.append(h('div', { class: 'ability', title: p.text }, p.text));
  if (d.shipAbility) card.append(h('div', { class: 'ability ship', title: d.shipAbility.text }, h('b', {}, d.shipAbility.name + ': '), d.shipAbility.text));
  if (s.upgrades.length) card.append(h('div', { class: 'upgrades' }, ...s.upgrades.map(u => {
    const def = CONTENT.upgrades[u.id];
    return h('span', { class: 'upg', title: def.text }, def.name, def.charges ? h('em', {}, ` ${u.charges}/${def.charges.value}`) : null);
  })));
  const up = s.damage.filter(c => c.faceup), down = s.damage.length - up.length;
  if (s.damage.length) card.append(h('div', { class: 'damage' },
    ...up.map(c => { const def = CONTENT.damageDeck.find(x => x.id === c.cardId); return h('span', { class: 'crit', title: def?.text ?? '' }, def?.name ?? c.cardId); }),
    down ? h('span', { class: 'facedown' }, `${down} damage`) : null));
  const entries = dialFor(s);
  let dialText = '';
  if (s.dialRevealed && s.dial >= 0) dialText = `Dial: ${maneuverName(entries[s.dial])}`;
  else if (draftDial !== undefined) dialText = `Planned: ${maneuverName(entries[draftDial])}`;
  else if (s.dial === -2 || s.dial >= 0) dialText = 'Dial set';
  if (dialText) card.append(h('div', { class: 'dialline' }, dialText));
  return card;
}

export function diceRow(dice: Face[], pool: 'attack' | 'defense', selected: Set<number> | null, onToggle?: (i: number) => void): HTMLElement {
  return h('div', { class: `dice ${pool}` }, ...dice.map((f, i) => h('button', { class: `die ${f}${selected?.has(i) ? ' picked' : ''}`, html: faceIcon(f), title: f, onclick: onToggle ? () => onToggle(i) : undefined, disabled: !onToggle })));
}
