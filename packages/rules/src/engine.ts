// Deterministic, serialisable rules engine. The game advances by itself until a player decision is
// required (`state.pending`); `applyCommand` validates the decision and resumes the flow stack.
import {
  ArcName, Bearing, Difficulty, Maneuver, Path, Poly, Pose, PLAY_AREA, RANGE_BAND,
  barrelRollPose, barrelRollTemplate, basePoly, buildPath, closestPoints, finalPose, measureArc,
  outsidePlayArea, parseManeuver, polysOverlap, poseAlong, rangeBand, segmentCrossesPoly, templateSlices, v,
} from './geometry';
import type {
  ActionDef, ActionType, AttackFace, AttackState, Command, Content, DefenseFace, Frame, GameEvent, GameOptions,
  GameState, Option, PlayerId, ShipDef, ShipState, Squad, TokenName, TurretFacing, UpgradeDef, PilotDef, Obstacle, ObstacleKind,
} from './types';
import { CONTENT } from './content';

export const DEFAULT_OPTIONS: GameOptions = { maxRounds: 12, targetScore: 20, obstacleCount: 6, variant: 'standard' };
export const SQUAD_LIMIT = 20;

type Ev = GameEvent[];
const C: Content = CONTENT;

// ---------- rng / dice ----------

function rand(G: GameState): number {
  G.rng = (G.rng + 0x6d2b79f5) | 0;
  let t = G.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const ATTACK_DIE: AttackFace[] = ['hit', 'hit', 'hit', 'crit', 'focus', 'focus', 'blank', 'blank'];
const DEFENSE_DIE: DefenseFace[] = ['evade', 'evade', 'evade', 'focus', 'focus', 'blank', 'blank', 'blank'];
const rollAttackDie = (G: GameState): AttackFace => ATTACK_DIE[Math.floor(rand(G) * 8)];
const rollDefenseDie = (G: GameState): DefenseFace => DEFENSE_DIE[Math.floor(rand(G) * 8)];

// ---------- lookups ----------

export const shipDef = (s: ShipState): ShipDef => C.ships[s.shipId];
export const pilotDef = (s: ShipState): PilotDef => C.pilots[s.pilotId];
export const upgradeDefs = (s: ShipState): UpgradeDef[] => s.upgrades.map(u => C.upgrades[u.id]);
export const shipPoly = (s: ShipState): Poly => basePoly(s.pose, shipDef(s).size);
export const inPlay = (s: ShipState): boolean => s.placed && !s.removed;
export const liveShips = (G: GameState): ShipState[] => G.shipOrder.map(id => G.ships[id]).filter(inPlay);
/** Ships that can still be interacted with (not destroyed-pending-removal). */
export const activeShips = (G: GameState): ShipState[] => liveShips(G).filter(s => !s.destroyed);
const hasPilotAbility = (s: ShipState, a: string) => pilotDef(s).ability === a;
const upgradeIdxWith = (s: ShipState, ability: string) => s.upgrades.findIndex(u => C.upgrades[u.id].ability === ability);
const hasCrit = (s: ShipState, cardId: string) => s.damage.some(d => d.faceup && d.cardId === cardId);
export const isStressed = (s: ShipState) => s.tokens.stress > 0;
export const isIonized = (s: ShipState) => s.tokens.ion >= ({ small: 1, medium: 2, large: 3 }[shipDef(s).size]);
export const shipRange = (a: ShipState, b: ShipState) => rangeBand(closestPoints(shipPoly(a), shipPoly(b)).dist);
export const hullRemaining = (s: ShipState) => s.hull - s.damage.length;

export function effectiveDifficulty(s: ShipState, m: Maneuver): Difficulty {
  if ((m.bearing === 'T' || m.bearing === 'Y') && hasCrit(s, 'damaged-engine')) return m.difficulty === 'B' ? 'W' : 'R';
  return m.difficulty;
}

export interface DialEntry { index: number; code: string; maneuver: Maneuver; difficulty: Difficulty; allowed: boolean }
export function dialFor(s: ShipState): DialEntry[] {
  return shipDef(s).dial.map((code, index) => {
    const maneuver = parseManeuver(code);
    const difficulty = effectiveDifficulty(s, maneuver);
    return { index, code, maneuver, difficulty, allowed: !(isStressed(s) && difficulty === 'R') };
  });
}

/** Where a maneuver would end if nothing were in the way (used for planning previews and the bot). */
export function previewManeuver(s: ShipState, m: { speed: number; bearing: Bearing }, slide = 0): Pose {
  return finalPose(buildPath(s.pose, m, shipDef(s).size), shipDef(s).size, slide);
}

// ---------- squads ----------

export function squadCost(sq: Squad): number { return sq.ships.reduce((n, s) => n + (C.pilots[s.pilotId]?.cost ?? 0), 0); }

export function validateSquad(sq: Squad): string[] {
  const errs: string[] = [];
  if (!sq.ships.length) errs.push('Squad has no ships.');
  const limited: Record<string, number> = {};
  for (const s of sq.ships) {
    const p = C.pilots[s.pilotId];
    if (!p) { errs.push(`Unknown pilot ${s.pilotId}`); continue; }
    if (C.ships[p.shipId].faction !== sq.faction) errs.push(`${p.name} is not in faction ${sq.faction}.`);
    if (p.limited) limited[p.name] = (limited[p.name] ?? 0) + 1;
    if (p.standardLoadout) { if (s.upgrades.length) errs.push(`${p.name} has a standard loadout and cannot equip upgrades.`); continue; }
    const slots = [...p.slots];
    let load = 0;
    const seen = new Set<string>();
    for (const uid of s.upgrades) {
      const u = C.upgrades[uid];
      if (!u) { errs.push(`Unknown upgrade ${uid}`); continue; }
      if (seen.has(uid)) errs.push(`${p.name}: duplicate ${u.name}.`);
      seen.add(uid);
      const i = slots.indexOf(u.slot);
      if (i < 0) errs.push(`${p.name}: no free ${u.slot} slot for ${u.name}.`); else slots.splice(i, 1);
      if (u.restrictions?.needsForce && !p.force) errs.push(`${p.name}: ${u.name} requires a force user.`);
      if (u.restrictions?.standardLoadoutOnly) errs.push(`${u.name} is only available in standard loadouts.`);
      if (u.limited) limited[u.name] = (limited[u.name] ?? 0) + 1;
      load += u.cost;
    }
    if (load > p.loadout) errs.push(`${p.name}: loadout ${load}/${p.loadout}.`);
  }
  for (const [name, n] of Object.entries(limited)) if (n > 1) errs.push(`${name} is limited to 1.`);
  const cost = squadCost(sq);
  if (cost > SQUAD_LIMIT) errs.push(`Squad costs ${cost}/${SQUAD_LIMIT}.`);
  return errs;
}

// ---------- creation ----------

function makeShip(owner: PlayerId, n: number, pilotId: string, upgrades: string[]): ShipState {
  const p = C.pilots[pilotId], d = C.ships[p.shipId];
  const ups = (p.standardLoadout ?? upgrades).map(id => ({ id, charges: C.upgrades[id].charges?.value ?? 0 }));
  let hull = d.hull, shields = d.shields;
  for (const u of ups) { hull += C.upgrades[u.id].stat?.hull ?? 0; shields += C.upgrades[u.id].stat?.shields ?? 0; }
  const hasTurret = ups.some(u => C.upgrades[u.id].attack?.arc === 'turret');
  return {
    id: `p${owner}s${n}`, owner, pilotId, shipId: d.id, label: `${n}`, cost: p.cost, initiative: p.initiative,
    pose: { x: 0, y: 0, r: 0 }, placed: false, hull, shieldsMax: shields, shields, damage: [], upgrades: ups,
    charges: p.charges?.value ?? 0, force: p.force?.value ?? 0, forceMax: p.force?.value ?? 0,
    tokens: { focus: 0, evade: 0, calculate: 0, stress: 0, strain: 0, ion: 0, disarm: 0 },
    lock: null, turret: hasTurret ? 'front' : null, dial: -1, dialRevealed: false, owedAction: null,
    actionsThisRound: [], activated: false, engaged: false, destroyed: false, removed: false, fled: false,
  };
}

function convexHull(pts: { x: number; y: number }[]): Poly {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cr = (o: any, a: any, b: any) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Poly = [], up: Poly = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

function generateObstacles(G: GameState, count: number): Obstacle[] {
  const kinds: ObstacleKind[] = ['asteroid', 'debris', 'gas', 'asteroid', 'debris', 'gas', 'asteroid', 'asteroid'];
  const out: Obstacle[] = [];
  let guard = 0;
  while (out.length < count && guard++ < 4000) {
    const R = 24 + rand(G) * 16;
    const cx = 2 * RANGE_BAND + R + rand(G) * (PLAY_AREA - 4 * RANGE_BAND - 2 * R);
    const cy = 2 * RANGE_BAND + R + rand(G) * (PLAY_AREA - 4 * RANGE_BAND - 2 * R);
    const pts = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(G) * 0.5, rr = R * (0.7 + rand(G) * 0.3);
      pts.push(v(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr));
    }
    const poly = convexHull(pts);
    if (out.some(o => closestPoints(o.poly, poly).dist <= RANGE_BAND)) continue;
    out.push({ id: `obs${out.length}`, kind: kinds[out.length % kinds.length], poly, seed: Math.floor(rand(G) * 1e9) });
  }
  return out;
}

export function createGame(squads: [Squad, Squad], names: [string, string], seed: number, options: Partial<GameOptions> = {}): { state: GameState; events: GameEvent[] } {
  for (const sq of squads) { const e = validateSquad(sq); if (e.length) throw new Error(`Invalid squad "${sq.name}": ${e.join(' ')}`); }
  const G: GameState = {
    version: 1, rng: seed | 0, round: 0, phase: 'setup', firstPlayer: 0,
    players: [0, 1].map(i => ({ name: names[i], squadName: squads[i].name, faction: squads[i].faction, squadPoints: squadCost(squads[i]), score: 0 })) as GameState['players'],
    ships: {}, shipOrder: [], obstacles: [], deck: [], discard: [], stack: [], pending: null, attack: null, winner: null,
    options: { ...DEFAULT_OPTIONS, ...options },
  };
  squads.forEach((sq, pi) => sq.ships.forEach((s, i) => {
    const ship = makeShip(pi as PlayerId, i + 1, s.pilotId, s.upgrades);
    G.ships[ship.id] = ship; G.shipOrder.push(ship.id);
  }));
  // Deficit: each player scores the points their opponent left unspent.
  G.players[0].score = SQUAD_LIMIT - G.players[1].squadPoints;
  G.players[1].score = SQUAD_LIMIT - G.players[0].squadPoints;
  for (const c of C.damageDeck) for (let i = 0; i < c.count; i++) G.deck.push(c.id);
  shuffle(G, G.deck);
  G.obstacles = generateObstacles(G, G.options.obstacleCount);
  const ev: Ev = [];
  G.firstPlayer = rollFirstPlayer(G);
  G.stack.push({ type: 'setup', step: 0 });
  advance(G, ev);
  return { state: G, events: ev };
}

function shuffle<T>(G: GameState, a: T[]) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand(G) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } }

function rollFirstPlayer(G: GameState): PlayerId {
  for (;;) {
    const roll = () => [0, 1, 2].map(() => rollAttackDie(G));
    const a = roll(), b = roll();
    for (const face of ['crit', 'focus', 'hit'] as AttackFace[]) {
      const ca = a.filter(f => f === face).length, cb = b.filter(f => f === face).length;
      if (ca !== cb) return ca > cb ? 0 : 1;
    }
  }
}

// ---------- ordering ----------

function nextInOrder(G: GameState, pool: ShipState[], ascending: boolean): ShipState[] {
  if (!pool.length) return [];
  const init = ascending ? Math.min(...pool.map(s => s.initiative)) : Math.max(...pool.map(s => s.initiative));
  const atInit = pool.filter(s => s.initiative === init);
  const first = atInit.filter(s => s.owner === G.firstPlayer);
  return first.length ? first : atInit;
}

// ---------- tokens & damage ----------

function gainToken(G: GameState, s: ShipState, token: TokenName, n: number, ev: Ev) {
  if (n <= 0) return;
  s.tokens[token] += n;
  ev.push({ t: 'token', shipId: s.id, token, delta: n });
  if (token === 'ion' && isIonized(s) && s.lock) setLock(G, s, null, ev);
}
function spendToken(s: ShipState, token: TokenName, n: number, ev: Ev) {
  const k = Math.min(n, s.tokens[token]);
  if (k <= 0) return;
  s.tokens[token] -= k;
  ev.push({ t: 'token', shipId: s.id, token, delta: -k });
}
function setLock(G: GameState, s: ShipState, targetId: string | null, ev: Ev) {
  s.lock = targetId;
  ev.push({ t: 'lock', shipId: s.id, targetId });
}
function recoverForce(s: ShipState, n: number, ev: Ev) {
  const k = Math.min(n, s.forceMax - s.force);
  if (k > 0) { s.force += k; ev.push({ t: 'token', shipId: s.id, token: 'force', delta: k }); }
}

function drawCard(G: GameState): string {
  if (!G.deck.length) { G.deck = G.discard; G.discard = []; shuffle(G, G.deck); }
  return G.deck.pop() ?? 'direct-hit';
}
const cardName = (id: string) => C.damageDeck.find(c => c.id === id)?.name ?? id;

function sufferDamage(G: GameState, s: ShipState, hits: number, crits: number, ev: Ev) {
  if (s.removed || hits + crits <= 0) return;
  if (hasCrit(s, 'hull-breach')) { crits += hits; hits = 0; }
  let shields = 0, facedown = 0;
  const faceup: string[] = [];
  const one = (crit: boolean) => {
    if (s.shields > 0) { s.shields--; shields++; return; }
    const cardId = drawCard(G);
    s.damage.push({ cardId, faceup: crit });
    if (crit) faceup.push(cardId); else facedown++;
  };
  for (let i = 0; i < hits; i++) one(false);
  const followUps: (() => void)[] = [];
  for (let i = 0; i < crits; i++) {
    const leak = s.damage.find(d => d.faceup && d.cardId === 'fuel-leak');
    const before = faceup.length;
    one(true);
    if (leak) followUps.push(() => { leak.faceup = false; ev.push({ t: 'repair', shipId: s.id, cardId: 'fuel-leak' }); sufferDamage(G, s, 1, 0, ev); });
    if (faceup.length > before) {
      const card = s.damage[s.damage.length - 1];
      if (card.cardId === 'direct-hit') followUps.push(() => { card.faceup = false; sufferDamage(G, s, 1, 0, ev); });
      if (card.cardId === 'panicked-pilot') followUps.push(() => { card.faceup = false; gainToken(G, s, 'stress', 2, ev); });
    }
  }
  ev.push({ t: 'damage', shipId: s.id, shields, facedown, faceup });
  for (const id of faceup) ev.push({ t: 'crit', shipId: s.id, cardId: id, name: cardName(id) });
  if (upgradeIdxWith(s, 'hate') >= 0) recoverForce(s, hits + crits, ev);
  for (const f of followUps) f();
  checkDestroyed(G, s, ev);
}

function checkDestroyed(G: GameState, s: ShipState, ev: Ev) {
  if (s.destroyed || s.removed || s.damage.length < s.hull) return;
  s.destroyed = true;
  ev.push({ t: 'destroyed', shipId: s.id });
  G.players[1 - s.owner].score += s.cost;
  ev.push({ t: 'score', scores: [G.players[0].score, G.players[1].score] });
  if (G.phase !== 'engagement') removeShip(G, s, 'destroyed', ev); // simultaneous fire: removal is deferred while engaging
}

function removeShip(G: GameState, s: ShipState, reason: 'destroyed' | 'fled', ev: Ev) {
  if (s.removed) return;
  s.removed = true;
  for (const c of s.damage) G.discard.push(c.cardId);
  for (const o of liveShips(G)) if (o.lock === s.id) setLock(G, o, null, ev);
  ev.push({ t: 'removed', shipId: s.id, reason });
}

// ---------- movement ----------

export interface MoveResult { pose: Pose; travelled: number; full: boolean; bumped: ShipState[]; path: Path; hitObstacles: Obstacle[] }

function overlapping(G: GameState, self: ShipState, pose: Pose): ShipState[] {
  const poly = basePoly(pose, shipDef(self).size);
  return liveShips(G).filter(o => o.id !== self.id && polysOverlap(poly, shipPoly(o)));
}

export function tallonSlides(G: GameState, s: ShipState, m: Maneuver): number[] {
  if (m.bearing !== 'E' && m.bearing !== 'R') return [0];
  const path = buildPath(s.pose, m, shipDef(s).size);
  return [-1, 0, 1].filter(sl => overlapping(G, s, finalPose(path, shipDef(s).size, sl)).length === 0);
}

export function resolveMove(G: GameState, s: ShipState, m: { speed: number; bearing: Bearing }, slide: number): MoveResult {
  const size = shipDef(s).size;
  const path = buildPath(s.pose, m, size);
  let pose = finalPose(path, size, slide), travelled = path.total, full = true;
  let bumped = overlapping(G, s, pose);
  if (bumped.length && path.total > 0) {
    full = false;
    let sClear = 0;
    for (let d = path.total - 1; d >= 0; d -= 1) {
      if (!overlapping(G, s, poseAlong(path, d)).length) { sClear = d; break; }
    }
    let lo = sClear, hi = Math.min(path.total, sClear + 1);
    for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; if (overlapping(G, s, poseAlong(path, mid)).length) hi = mid; else lo = mid; }
    travelled = lo; pose = poseAlong(path, lo);
  } else if (bumped.length) { full = false; travelled = 0; pose = s.pose; }
  const slices = templateSlices(path).filter((_, i) => path.h + i * 4 <= travelled + path.h);
  const endPoly = basePoly(pose, size);
  const hitObstacles = G.obstacles.filter(o => polysOverlap(endPoly, o.poly) || slices.some(q => polysOverlap(q, o.poly)));
  return { pose, travelled, full, bumped, path, hitObstacles };
}

function obstacleEffects(G: GameState, s: ShipState, obs: Obstacle[], ev: Ev) {
  for (const o of obs) {
    if (s.removed) return;
    ev.push({ t: 'obstacle', shipId: s.id, obstacleId: o.id, kind: o.kind });
    const die = rollAttackDie(G);
    ev.push({ t: 'roll', shipId: s.id, die, cause: o.kind });
    if (o.kind === 'asteroid') sufferDamage(G, s, 1 + (die === 'hit' || die === 'crit' ? 1 : 0), 0, ev);
    else if (o.kind === 'debris') { gainToken(G, s, 'stress', 1, ev); if (die === 'hit') sufferDamage(G, s, 1, 0, ev); if (die === 'crit') sufferDamage(G, s, 0, 1, ev); }
    else {
      if (s.lock) setLock(G, s, null, ev);
      for (const x of liveShips(G)) if (x.lock === s.id) setLock(G, x, null, ev);
      gainToken(G, s, 'strain', 1, ev);
      if (die === 'hit') gainToken(G, s, 'ion', 1, ev);
      if (die === 'crit') gainToken(G, s, 'ion', 3, ev);
    }
  }
}

export const atRange0OfObstacle = (G: GameState, s: ShipState, kind?: ObstacleKind) =>
  G.obstacles.some(o => (!kind || o.kind === kind) && closestPoints(shipPoly(s), o.poly).dist <= 0.05);

function repositionOk(G: GameState, s: ShipState, pose: Pose, sweep: Poly[]): boolean {
  const poly = basePoly(pose, shipDef(s).size);
  if (outsidePlayArea(poly)) return false;
  if (overlapping(G, s, pose).length) return false;
  return !G.obstacles.some(o => polysOverlap(poly, o.poly) || sweep.some(q => polysOverlap(q, o.poly)));
}

// ---------- actions ----------

function actionBar(s: ShipState): ActionDef[] {
  return [...shipDef(s).actions, ...upgradeDefs(s).flatMap(u => u.addActions ?? [])];
}

const ACTION_LABEL: Record<ActionType, string> = { focus: 'Focus', evade: 'Evade', lock: 'Lock', barrelRoll: 'Barrel Roll', boost: 'Boost', calculate: 'Calculate', reload: 'Reload', rotate: 'Rotate Turret', card: 'Repair' };

export function legalActions(G: GameState, s: ShipState, f: { allowed?: ActionType[]; forceRed?: boolean; ignoreStress?: boolean }): Option[] {
  if (isStressed(s) && !f.ignoreStress) return [];
  const opts: Option[] = [];
  const sensors = hasCrit(s, 'damaged-sensors');
  const bar = actionBar(s);
  const types: { type: ActionType; red: boolean }[] = [];
  for (const a of bar) types.push({ type: a.type, red: a.difficulty === 'R' || !!f.forceRed });
  // Granted actions (e.g. a free boost) need not be on the bar.
  for (const t of f.allowed ?? []) if (!types.some(x => x.type === t)) types.push({ type: t, red: !!f.forceRed });
  types.push({ type: 'card', red: false });
  const seen = new Set<ActionType>();
  for (const { type, red } of types) {
    if (seen.has(type)) continue; seen.add(type);
    if (f.allowed && !f.allowed.includes(type)) continue;
    if (type !== 'card' && s.actionsThisRound.includes(type)) continue;
    if (sensors && type !== 'focus' && type !== 'card') continue;
    const base = { action: type, red, shipId: s.id };
    const name = (red ? 'Red ' : '') + ACTION_LABEL[type];
    switch (type) {
      case 'focus': case 'evade': case 'calculate':
        opts.push({ id: type, label: name, ...base }); break;
      case 'lock':
        if (isIonized(s) || atRange0OfObstacle(G, s, 'gas')) break;
        for (const t of activeShips(G)) if (t.owner !== s.owner && t.id !== s.lock && shipRange(s, t) <= 3 && !atRange0OfObstacle(G, t, 'gas'))
          opts.push({ id: `lock:${t.id}`, label: `${name} → ${pilotDef(t).name}`, targetId: t.id, ...base });
        break;
      case 'barrelRoll':
        for (const side of [1, -1] as const) for (const pos of [1, 0, -1] as const) {
          const pose = barrelRollPose(s.pose, side, pos, shipDef(s).size);
          if (repositionOk(G, s, pose, [barrelRollTemplate(s.pose, side, shipDef(s).size)]))
            opts.push({ id: `barrelRoll:${side}:${pos}`, label: `${name} ${side > 0 ? 'left' : 'right'} ${pos > 0 ? 'fwd' : pos < 0 ? 'back' : 'mid'}`, pose, ...base });
        }
        break;
      case 'boost':
        for (const b of ['B', 'F', 'N'] as Bearing[]) {
          const path = buildPath(s.pose, { speed: 1, bearing: b }, shipDef(s).size);
          const pose = finalPose(path, shipDef(s).size);
          if (repositionOk(G, s, pose, templateSlices(path)))
            opts.push({ id: `boost:${b}`, label: `${name} ${b === 'B' ? 'left' : b === 'N' ? 'right' : 'straight'}`, pose, ...base });
        }
        break;
      case 'reload':
        s.upgrades.forEach((u, i) => {
          const d = C.upgrades[u.id];
          if (['Torpedo', 'Missile', 'Device'].includes(d.slot) && d.charges && u.charges < d.charges.value)
            opts.push({ id: `reload:${i}`, label: `${name} ${d.name}`, upgradeIdx: i, ...base });
        });
        break;
      case 'rotate':
        if (!s.turret) break;
        for (const facing of ['front', 'left', 'right', 'rear'] as TurretFacing[]) if (facing !== s.turret)
          opts.push({ id: `rotate:${facing}`, label: `Rotate turret ${facing}`, facing, ...base });
        break;
      case 'card': {
        s.damage.forEach((d, i) => {
          const def = C.damageDeck.find(c => c.id === d.cardId)!;
          if (d.faceup && def.repairAction) opts.push({ id: `repair:${i}`, label: `Repair ${def.name}`, cardIdx: i, ...base });
        });
        const droid = upgradeIdxWith(s, 'repairDroid');
        if (droid >= 0 && !sensors) {
          if (s.upgrades[droid].charges > 0 && s.damage.some(d => !d.faceup)) opts.push({ id: 'droid:facedown', label: 'Droid: repair facedown card', upgradeIdx: droid, ...base });
          s.damage.forEach((d, i) => { const def = C.damageDeck.find(c => c.id === d.cardId)!; if (d.faceup && def.type === 'Ship' && !def.repairAction) opts.push({ id: `droid:faceup:${i}`, label: `Droid: repair ${def.name}`, cardIdx: i, ...base }); });
        }
        break;
      }
    }
  }
  return opts;
}

function performAction(G: GameState, s: ShipState, o: Option, ev: Ev) {
  const type = o.action!;
  ev.push({ t: 'action', shipId: s.id, action: type, label: o.label, red: !!o.red });
  if (type !== 'card') s.actionsThisRound.push(type);
  switch (type) {
    case 'focus': gainToken(G, s, 'focus', 1, ev); break;
    case 'evade': gainToken(G, s, 'evade', 1, ev); break;
    case 'calculate': gainToken(G, s, 'calculate', 1, ev); break;
    case 'lock': setLock(G, s, o.targetId!, ev); break;
    case 'barrelRoll': case 'boost': {
      const from = s.pose; s.pose = o.pose!;
      const b = type === 'boost' ? (o.id.split(':')[1] as Bearing) : 'F';
      ev.push({ t: 'move', shipId: s.id, kind: type, from, to: s.pose, speed: 1, bearing: b, travelled: 0, full: true, difficulty: 'W' });
      break;
    }
    case 'reload': {
      s.upgrades[o.upgradeIdx!].charges++; ev.push({ t: 'token', shipId: s.id, token: 'charge', delta: 1, upgradeIdx: o.upgradeIdx });
      gainToken(G, s, 'disarm', 1, ev); break;
    }
    case 'rotate': s.turret = o.facing!; ev.push({ t: 'turret', shipId: s.id, facing: o.facing! }); break;
    case 'card': {
      if (o.id === 'droid:facedown') {
        s.upgrades[o.upgradeIdx!].charges--;
        const i = s.damage.findIndex(d => !d.faceup);
        const [c] = s.damage.splice(i, 1); G.discard.push(c.cardId);
        ev.push({ t: 'repair', shipId: s.id, cardId: 'facedown' });
      } else {
        const c = s.damage[o.cardIdx!]; c.faceup = false;
        ev.push({ t: 'repair', shipId: s.id, cardId: c.cardId });
      }
      break;
    }
  }
  if (o.red) gainToken(G, s, 'stress', 1, ev);
}

// ---------- attacks ----------

export interface Weapon { id: string; name: string; primary: boolean; arc: ArcName; value: number; minRange: number; maxRange: number; ordnance: boolean; requires?: 'lock' | 'focus'; ion: boolean; upgradeIdx: number; chargeCost: number; ability?: string }

export function weaponsOf(s: ShipState): Weapon[] {
  const d = shipDef(s);
  const ws: Weapon[] = [{ id: 'primary', name: 'Primary Weapon', primary: true, arc: 'front', value: d.attack, minRange: 0, maxRange: 3, ordnance: false, ion: false, upgradeIdx: -1, chargeCost: 0 }];
  s.upgrades.forEach((u, i) => {
    const def = C.upgrades[u.id];
    if (!def.attack) return;
    const a = def.attack;
    ws.push({ id: `up${i}`, name: def.name, primary: false, arc: a.arc === 'turret' ? (s.turret ?? 'front') : 'front', value: a.value, minRange: a.minRange, maxRange: a.maxRange, ordnance: a.ordnance, requires: a.requires, ion: !!a.ion, upgradeIdx: i, chargeCost: a.chargeCost ?? 0, ability: def.ability });
  });
  return ws;
}

export function isObstructed(G: GameState, from: { x: number; y: number }, to: { x: number; y: number }): boolean {
  return G.obstacles.some(o => segmentCrossesPoly(from, to, o.poly));
}

export function attackOptions(G: GameState, s: ShipState): Option[] {
  if (s.tokens.disarm > 0 || atRange0OfObstacle(G, s)) return [];
  const opts: Option[] = [];
  const size = shipDef(s).size;
  for (const w of weaponsOf(s)) {
    if (w.upgradeIdx >= 0 && s.upgrades[w.upgradeIdx].charges < w.chargeCost) continue;
    for (const t of activeShips(G)) {
      if (t.owner === s.owner) continue;
      const m = measureArc(s.pose, size, w.arc, shipPoly(t));
      if (!m.inArc || m.range < w.minRange || m.range > w.maxRange) continue;
      let viaAim = false;
      if (w.requires === 'lock' && s.lock !== t.id || w.requires === 'focus' && s.tokens.focus < 1) {
        if (upgradeIdxWith(s, 'instinctiveAim') >= 0 && s.force > 0) viaAim = true; else continue;
      }
      const obstructed = isObstructed(G, m.from, m.to);
      opts.push({
        id: `atk:${w.id}:${t.id}${viaAim ? ':aim' : ''}`, label: `${w.name} → ${pilotDef(t).name} (${t.label})`, weapon: w.id, targetId: t.id, shipId: s.id,
        arc: w.arc, range: m.range, obstructed, dice: w.value, detail: viaAim ? 'Instinctive Aim: spend 1 force' : undefined,
      });
    }
  }
  return opts;
}

function inBullseye(a: ShipState, d: ShipState) { return measureArc(a.pose, shipDef(a).size, 'bullseye', shipPoly(d)).inArc; }
function inFiringArc(of: ShipState, target: ShipState) {
  return weaponsOf(of).some(w => measureArc(of.pose, shipDef(of).size, w.arc, shipPoly(target)).inArc);
}

function attackDiceCount(G: GameState, A: AttackState): number {
  const a = G.ships[A.attacker], d = G.ships[A.defender];
  const w = weaponsOf(a).find(x => x.id === A.weapon)!;
  let n = w.value;
  if (!(w.primary && A.range === 0)) {
    if (A.range === 1 && !w.ordnance) n++;
    if (hasPilotAbility(a, 'plusDieRange1') && A.range === 1) n++;
    if (hasPilotAbility(a, 'plusDieBullseye') && A.bullseye) n++;
    if (hasPilotAbility(a, 'plusDieVsDamaged') && d.damage.length > 0) n++;
    if (w.primary && shipDef(a).shipAbility?.id === 'atc' && a.lock === d.id) n++;
  }
  if (hasCrit(a, 'weapons-failure')) n--;
  return Math.max(0, n);
}

function defenseDiceCount(G: GameState, A: AttackState, ev: Ev): number {
  const a = G.ships[A.attacker], d = G.ships[A.defender];
  const w = weaponsOf(a).find(x => x.id === A.weapon)!;
  let n = shipDef(d).agility;
  if (A.range === 3 && !w.ordnance) n++;
  if (A.obstructed) n++;
  if (A.range !== 0) {
    if (hasPilotAbility(a, 'minusDefenseDie')) n--;
    if (upgradeIdxWith(a, 'outmaneuver') >= 0 && w.arc === 'front' && !inFiringArc(d, a)) n--;
  }
  if (hasCrit(d, 'structural-damage')) n--;
  if (d.tokens.strain > 0) { n--; spendToken(d, 'strain', 1, ev); }
  return Math.max(0, n);
}

function attackModOptions(G: GameState, A: AttackState): Option[] {
  const a = G.ships[A.attacker], d = G.ships[A.defender];
  const w = weaponsOf(a).find(x => x.id === A.weapon)!;
  const done: Option = { id: 'done', label: 'Done' };
  if (w.primary && A.range === 0) return [done];
  const dice = A.attackDice;
  const has = (f: AttackFace) => dice.includes(f);
  const rerollable = dice.filter((_, i) => !A.attackRerolled[i]).length;
  const blinded = hasCrit(a, 'blinded-pilot');
  const opts: Option[] = [];
  if (a.force > 0 && has('focus')) opts.push({ id: 'force', label: 'Spend 1 force: focus → hit' });
  if (!blinded) {
    if (a.tokens.focus > 0 && has('focus')) opts.push({ id: 'focus', label: 'Spend focus: all focus → hit' });
    if (a.tokens.calculate > 0 && has('focus')) opts.push({ id: 'calculate', label: 'Spend calculate: 1 focus → hit' });
    if (rerollable > 0) {
      if (a.lock === d.id && !A.noLockSpend) opts.push({ id: 'lock', label: 'Spend lock: reroll dice', pickDice: { max: rerollable } });
      const reroll = (key: string, label: string, max: number) => { if (!A.used.includes(key) && max > 0) opts.push({ id: key, label, pickDice: { max: Math.min(max, rerollable) } }); };
      if (w.primary && activeShips(G).some(x => x.owner === a.owner && hasPilotAbility(x, 'auraReroll') && shipRange(x, a) <= 1)) reroll('auraReroll', 'Packleader aura: reroll 1 die', 1);
      if (w.primary && A.bullseye && upgradeIdxWith(a, 'predator') >= 0) reroll('predator', 'Predator: reroll 1 die', 1);
      if (hasPilotAbility(a, 'rerollPerFriendNearDefender')) reroll('rerollPerFriendNearDefender', 'Coordinated fire: reroll', activeShips(G).filter(x => x.owner === a.owner && x.id !== a.id && shipRange(x, d) <= 1).length);
      if (upgradeIdxWith(a, 'fireControl') >= 0 && a.lock === d.id) reroll('fireControl', 'Fire-control: reroll 1 die (keeps lock)', 1);
    }
    if (has('hit')) {
      const change = (key: string, label: string) => { if (!A.used.includes(key)) opts.push({ id: key, label }); };
      if (w.primary && shipDef(a).shipAbility?.id === 'atc' && a.lock === d.id) change('atc', `${shipDef(a).shipAbility!.name}: hit → crit`);
      if (A.bullseye && upgradeIdxWith(a, 'marksmanship') >= 0) change('marksmanship', 'Marksmanship: hit → crit');
      if (w.ability === 'hitToCrit') change('hitToCrit', `${w.name}: hit → crit`);
    }
  }
  return opts.length ? [...opts, done] : [done];
}

function defenseModOptions(G: GameState, A: AttackState): Option[] {
  const d = G.ships[A.defender];
  const dice = A.defenseDice;
  const has = (f: DefenseFace) => dice.includes(f);
  const opts: Option[] = [];
  if (d.force > 0 && has('focus')) opts.push({ id: 'force', label: 'Spend 1 force: focus → evade' });
  if (d.tokens.focus > 0 && has('focus')) opts.push({ id: 'focus', label: 'Spend focus: all focus → evade' });
  if (d.tokens.calculate > 0 && has('focus')) opts.push({ id: 'calculate', label: 'Spend calculate: 1 focus → evade' });
  if (d.tokens.evade > 0 && (has('blank') || has('focus'))) opts.push({ id: 'evade', label: 'Spend evade: 1 blank/focus → evade' });
  const el = upgradeIdxWith(d, 'elusive');
  if (el >= 0 && d.upgrades[el].charges > 0 && !A.used.includes('elusive') && dice.some((_, i) => !A.defenseRerolled[i])) opts.push({ id: 'elusive', label: 'Elusive: reroll 1 die', pickDice: { max: 1 } });
  if (upgradeIdxWith(d, 'brilliantEvasion') >= 0 && d.force > 0 && has('focus') && !A.bullseye && !A.used.includes('brilliantEvasion')) opts.push({ id: 'brilliantEvasion', label: 'Evasive Insight: 2 focus → evade' });
  const done: Option = { id: 'done', label: 'Done' };
  return opts.length ? [...opts, done] : [done];
}

function afterSpendFocus(G: GameState, s: ShipState) {
  if (hasPilotAbility(s, 'shareFocus') && activeShips(G).some(x => x.owner === s.owner && x.id !== s.id && [1, 2, 3].includes(shipRange(s, x))))
    G.stack.push({ type: 'shareFocus', step: 0, shipId: s.id });
}

function applyAttackMod(G: GameState, A: AttackState, o: Option, picks: number[], ev: Ev) {
  const a = G.ships[A.attacker];
  const dice = A.attackDice;
  const swap = (from: AttackFace, to: AttackFace, n: number) => { for (let i = 0; i < dice.length && n > 0; i++) if (dice[i] === from) { dice[i] = to; n--; } };
  const reroll = (max: number) => {
    const idx = [...new Set(picks)].filter(i => i >= 0 && i < dice.length && !A.attackRerolled[i]).slice(0, max);
    for (const i of idx) { dice[i] = rollAttackDie(G); A.attackRerolled[i] = true; }
  };
  switch (o.id) {
    case 'focus': spendToken(a, 'focus', 1, ev); swap('focus', 'hit', 99); afterSpendFocus(G, a); break;
    case 'calculate': spendToken(a, 'calculate', 1, ev); swap('focus', 'hit', 1); break;
    case 'force': a.force--; ev.push({ t: 'token', shipId: a.id, token: 'force', delta: -1 }); swap('focus', 'hit', 1); break;
    case 'lock': setLock(G, a, null, ev); reroll(o.pickDice!.max); break;
    case 'fireControl': A.noLockSpend = true; A.used.push(o.id); reroll(1); break;
    case 'auraReroll': case 'predator': case 'rerollPerFriendNearDefender': A.used.push(o.id); reroll(o.pickDice!.max); break;
    case 'atc': case 'marksmanship': case 'hitToCrit': A.used.push(o.id); swap('hit', 'crit', 1); break;
  }
  ev.push({ t: 'dice', pool: 'attack', shipId: a.id, dice: [...dice], cause: o.label });
}

function applyDefenseMod(G: GameState, A: AttackState, o: Option, picks: number[], ev: Ev) {
  const d = G.ships[A.defender];
  const dice = A.defenseDice;
  const swap = (from: DefenseFace, n: number) => { let k = 0; for (let i = 0; i < dice.length && k < n; i++) if (dice[i] === from) { dice[i] = 'evade'; k++; } return k; };
  switch (o.id) {
    case 'focus': spendToken(d, 'focus', 1, ev); swap('focus', 99); afterSpendFocus(G, d); break;
    case 'calculate': spendToken(d, 'calculate', 1, ev); swap('focus', 1); break;
    case 'force': d.force--; ev.push({ t: 'token', shipId: d.id, token: 'force', delta: -1 }); swap('focus', 1); break;
    case 'evade': spendToken(d, 'evade', 1, ev); if (!swap('blank', 1)) swap('focus', 1); break;
    case 'elusive': {
      const i = picks.find(i => i >= 0 && i < dice.length && !A.defenseRerolled[i]);
      if (i === undefined) return;
      const u = upgradeIdxWith(d, 'elusive'); d.upgrades[u].charges--; ev.push({ t: 'token', shipId: d.id, token: 'charge', delta: -1, upgradeIdx: u });
      dice[i] = rollDefenseDie(G); A.defenseRerolled[i] = true; A.used.push('elusive'); break;
    }
    case 'brilliantEvasion': d.force--; ev.push({ t: 'token', shipId: d.id, token: 'force', delta: -1 }); swap('focus', 2); A.used.push(o.id); break;
  }
  ev.push({ t: 'dice', pool: 'defense', shipId: d.id, dice: [...dice], cause: o.label });
}

// ---------- ability prompts ----------

function pushAbility(G: GameState, key: string, s: ShipState, prompt: string, extra: Record<string, any> = {}) {
  G.stack.push({ type: 'ability', step: 0, key, shipId: s.id, prompt, ...extra });
}

function resolveAbility(G: GameState, f: Frame, ev: Ev) {
  const s = G.ships[f.shipId];
  const spendCharge = (i: number) => { s.upgrades[i].charges--; ev.push({ t: 'token', shipId: s.id, token: 'charge', delta: -1, upgradeIdx: i }); };
  ev.push({ t: 'ability', shipId: s.id, name: f.name ?? f.key });
  switch (f.key) {
    case 'regenShield': spendCharge(f.upgradeIdx); gainToken(G, s, 'disarm', 1, ev); s.shields++; ev.push({ t: 'token', shipId: s.id, token: 'shield', delta: 1 }); break;
    case 'focusAfterBlue': G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: ['focus'] }); break;
    case 'afterburners': spendCharge(f.upgradeIdx); G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: ['boost'], ignoreStress: true }); break;
    case 'forceForAction': s.force--; ev.push({ t: 'token', shipId: s.id, token: 'force', delta: -1 }); G.stack.push({ type: 'action', step: 0, shipId: s.id }); break;
    case 'actionAfterFriendDefends': G.stack.push({ type: 'action', step: 0, shipId: s.id }); break;
    case 'crackShot': {
      spendCharge(f.upgradeIdx);
      const i = G.attack!.defenseDice.indexOf('evade');
      if (i >= 0) G.attack!.defenseDice.splice(i, 1);
      ev.push({ t: 'dice', pool: 'defense', shipId: G.attack!.defender, dice: [...G.attack!.defenseDice], cause: 'Crack Shot' });
      break;
    }
  }
}

// ---------- flow ----------

function choice(G: GameState, player: PlayerId, kind: any, prompt: string, options: Option[], shipId?: string) {
  G.pending = { type: 'choice', player, kind, prompt, options, shipId };
}
const pop = (G: GameState) => { G.stack.pop(); };

function placementOrder(G: GameState): string[] {
  const ships = G.shipOrder.map(id => G.ships[id]);
  return ships.sort((a, b) => a.initiative - b.initiative || (a.owner === G.firstPlayer ? -1 : 1) - (b.owner === G.firstPlayer ? -1 : 1)).map(s => s.id);
}

export function deploymentValid(G: GameState, s: ShipState, pose: Pose): boolean {
  const poly = basePoly(pose, shipDef(s).size);
  if (outsidePlayArea(poly)) return false;
  const ok = s.owner === 0 ? poly.every(p => p.y <= RANGE_BAND + 1e-6) : poly.every(p => p.y >= PLAY_AREA - RANGE_BAND - 1e-6);
  if (!ok) return false;
  return !liveShips(G).some(o => o.id !== s.id && polysOverlap(poly, shipPoly(o)));
}

function run(G: GameState, f: Frame, ev: Ev) {
  switch (f.type) {
    case 'setup': {
      if (f.step === 0) { f.order = placementOrder(G); f.idx = 0; f.step = 1; ev.push({ t: 'phase', phase: 'setup' }); }
      if (f.idx >= f.order.length) { pop(G); G.stack.push({ type: 'round', step: 0 }); return; }
      const s = G.ships[f.order[f.idx]];
      G.pending = { type: 'placeShip', player: s.owner, shipId: s.id };
      return;
    }
    case 'round': return runRound(G, f, ev);
    case 'activationPhase': {
      const pool = activeShips(G).filter(s => !s.activated);
      const next = nextInOrder(G, pool, true);
      if (!next.length) return pop(G);
      if (next.length === 1) { G.stack.push({ type: 'activateShip', step: 0, shipId: next[0].id }); return; }
      return choice(G, next[0].owner, 'activateShip', 'Choose a ship to activate', next.map(s => ({ id: s.id, label: `${pilotDef(s).name} (${s.label})`, shipId: s.id })));
    }
    case 'activateShip': return runActivate(G, f, ev);
    case 'actionPhase': {
      // Actions are independent of each other now that all movement is done, so initiative order is
      // kept only for tidiness and ties need no player choice.
      const pool = activeShips(G).filter(s => s.owedAction);
      if (!pool.length) return pop(G);
      // Group by owner: one player answers for all of their ships before the other is asked at all,
      // which is what lets a correspondence player settle the whole phase in a single sitting.
      let owner = f.owner as PlayerId | undefined;
      if (owner === undefined || !pool.some(x => x.owner === owner)) { owner = nextInOrder(G, pool, true)[0].owner; f.owner = owner; }
      const s = nextInOrder(G, pool.filter(x => x.owner === owner), true)[0];
      const owed = s.owedAction!;
      s.owedAction = null;
      if (owed.bumpedEnemy) G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: ['focus', 'calculate'], forceRed: true, barOnly: true, noChain: true });
      else G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: owed.ionized ? ['focus'] : undefined, barOnly: owed.ionized });
      return;
    }
    case 'action': return runAction(G, f, ev);
    case 'ability': {
      const s = G.ships[f.shipId];
      if (!inPlay(s)) return pop(G);
      return choice(G, s.owner, 'ability', f.prompt, [{ id: 'yes', label: 'Use', shipId: s.id }, { id: 'no', label: 'Skip', shipId: s.id }], s.id);
    }
    case 'shareFocus': {
      const s = G.ships[f.shipId];
      const targets = activeShips(G).filter(x => x.owner === s.owner && x.id !== s.id && [1, 2, 3].includes(shipRange(s, x)));
      if (!targets.length) return pop(G);
      return choice(G, s.owner, 'chooseShip', `${pilotDef(s).name}: give a focus token to a friendly ship?`, [...targets.map(x => ({ id: x.id, label: `${pilotDef(x).name} (${x.label})`, shipId: x.id })), { id: 'none', label: 'No one' }], s.id);
    }
    case 'engagementPhase': {
      const pool = liveShips(G).filter(s => !s.engaged);
      const next = nextInOrder(G, pool, false);
      const init = next.length ? next[0].initiative : -1;
      if (f.init !== undefined && init !== f.init) for (const s of liveShips(G)) if (s.destroyed) removeShip(G, s, 'destroyed', ev);
      f.init = init;
      const still = next.filter(inPlay);
      if (!still.length) { if (!next.length) return pop(G); return; }
      if (still.length === 1) { G.stack.push({ type: 'engageShip', step: 0, shipId: still[0].id }); return; }
      return choice(G, still[0].owner, 'engageShip', 'Choose a ship to engage', still.map(s => ({ id: s.id, label: `${pilotDef(s).name} (${s.label})`, shipId: s.id })));
    }
    case 'engageShip': return runEngage(G, f, ev);
    case 'attack': return runAttack(G, f, ev);
  }
  throw new Error(`Unknown frame ${f.type}`);
}

function runRound(G: GameState, f: Frame, ev: Ev) {
  switch (f.step) {
    case 0: {
      G.round++; G.phase = 'planning';
      for (const s of liveShips(G)) { s.dial = -1; s.dialRevealed = false; s.activated = false; s.engaged = false; s.actionsThisRound = []; s.owedAction = null; }
      ev.push({ t: 'phase', phase: 'planning' });
      G.pending = { type: 'planning', players: ([0, 1] as PlayerId[]).filter(p => liveShips(G).some(s => s.owner === p)) };
      f.step = 1; return;
    }
    case 1:
      G.firstPlayer = rollFirstPlayer(G);
      ev.push({ t: 'round', round: G.round, firstPlayer: G.firstPlayer });
      G.phase = 'system'; ev.push({ t: 'phase', phase: 'system' });
      f.step = 2; return;
    case 2: G.phase = 'activation'; ev.push({ t: 'phase', phase: 'activation' }); G.stack.push({ type: 'activationPhase', step: 0 }); f.step = 3; return;
    case 3:
      if (G.options.variant === 'correspondence' && liveShips(G).some(s => s.owedAction)) { G.stack.push({ type: 'actionPhase', step: 0 }); return; }
      G.phase = 'engagement'; ev.push({ t: 'phase', phase: 'engagement' }); G.stack.push({ type: 'engagementPhase', step: 0 }); f.step = 4; return;
    case 4: {
      G.phase = 'end'; ev.push({ t: 'phase', phase: 'end' });
      for (const s of liveShips(G)) {
        if (s.destroyed) { removeShip(G, s, 'destroyed', ev); continue; }
        for (const tk of ['focus', 'evade', 'calculate', 'disarm'] as TokenName[]) if (s.tokens[tk]) spendToken(s, tk, s.tokens[tk], ev);
        const p = pilotDef(s);
        if (p.force) recoverForce(s, p.force.recovers, ev);
        if (p.charges?.recovers && s.charges < p.charges.value) s.charges = Math.min(p.charges.value, s.charges + p.charges.recovers);
        s.upgrades.forEach(u => { const c = C.upgrades[u.id].charges; if (c?.recovers) u.charges = Math.min(c.value, u.charges + c.recovers); });
      }
      const alive = [0, 1].map(p => liveShips(G).some(s => s.owner === p));
      const [a, b] = [G.players[0].score, G.players[1].score];
      const byScore = (): PlayerId | 'draw' => (a === b ? 'draw' : a > b ? 0 : 1);
      let winner: PlayerId | 'draw' | null = null;
      if (!alive[0] || !alive[1]) winner = alive[0] ? 0 : alive[1] ? 1 : byScore();
      else if ((a >= G.options.targetScore || b >= G.options.targetScore) && a !== b) winner = byScore();
      else if (G.round >= G.options.maxRounds) winner = byScore();
      if (winner !== null) { G.winner = winner; G.phase = 'over'; G.stack = []; ev.push({ t: 'gameOver', winner }); return; }
      f.step = 0; return;
    }
  }
}

function runActivate(G: GameState, f: Frame, ev: Ev) {
  const s = G.ships[f.shipId];
  if (!inPlay(s)) return pop(G);
  switch (f.step) {
    case 0: {
      const code = shipDef(s).dial[s.dial] ?? '2FW';
      s.dialRevealed = true;
      ev.push({ t: 'reveal', shipId: s.id, code });
      f.step = 1;
      const droid = upgradeIdxWith(s, 'regenShield');
      if (droid >= 0 && s.upgrades[droid].charges > 0 && s.shields < s.shieldsMax) pushAbility(G, 'regenShield', s, `${C.upgrades[s.upgrades[droid].id].name}: spend 1 charge and gain a disarm token to recover 1 shield?`, { upgradeIdx: droid, name: C.upgrades[s.upgrades[droid].id].name });
      return;
    }
    case 1: {
      let m = parseManeuver(shipDef(s).dial[s.dial] ?? '2FW');
      m = { ...m, difficulty: effectiveDifficulty(s, m) };
      f.ion = false;
      if (isIonized(s)) {
        const b = m.bearing;
        const bearing: Bearing = 'TBLE'.includes(b) ? 'B' : 'YNPR'.includes(b) ? 'N' : 'F';
        m = { speed: 1, bearing, difficulty: 'B' }; f.ion = true;
      } else if (isStressed(s) && m.difficulty === 'R') m = { speed: 2, bearing: 'F', difficulty: 'W' };
      f.m = m;
      const slides = tallonSlides(G, s, m);
      f.step = 2; f.slide = slides.length ? slides[Math.floor(slides.length / 2)] : 0;
      if (slides.length > 1) {
        f.slides = slides;
        return choice(G, s.owner, 'tallon', 'Choose final position', slides.map(sl => ({ id: `slide:${sl}`, label: sl < 0 ? 'Back' : sl > 0 ? 'Forward' : 'Middle', pose: previewManeuver(s, m, sl), shipId: s.id })), s.id);
      }
      return;
    }
    case 2: {
      const m: Maneuver = f.m;
      const from = s.pose;
      const res = resolveMove(G, s, m, f.slide);
      s.pose = res.pose;
      ev.push({ t: 'move', shipId: s.id, kind: f.ion ? 'ion' : 'maneuver', from, to: res.pose, speed: m.speed, bearing: m.bearing, travelled: res.travelled, full: res.full, difficulty: m.difficulty });
      f.full = res.full; f.bump = null;
      if (outsidePlayArea(shipPoly(s))) {
        s.fled = true; G.players[1 - s.owner].score += s.cost;
        ev.push({ t: 'score', scores: [G.players[0].score, G.players[1].score] });
        removeShip(G, s, 'fled', ev); return pop(G);
      }
      if (m.difficulty === 'R') gainToken(G, s, 'stress', 1, ev);
      if (m.difficulty === 'B') { spendToken(s, 'stress', 1, ev); spendToken(s, 'strain', 1, ev); }
      obstacleEffects(G, s, res.hitObstacles, ev);
      if (res.hitObstacles.length && hasCrit(s, 'stunned-pilot')) sufferDamage(G, s, 1, 0, ev);
      if (!res.full) {
        const friendly = res.bumped.some(o => o.owner === s.owner);
        for (const o of res.bumped) ev.push({ t: 'bump', shipId: s.id, otherId: o.id });
        f.bump = friendly ? 'friendly' : 'enemy';
        if (friendly) { const die = rollAttackDie(G); ev.push({ t: 'roll', shipId: s.id, die, cause: 'collision' }); if (die === 'hit' || die === 'crit') sufferDamage(G, s, 1, 0, ev); }
      }
      if (m.bearing !== 'F' && m.bearing !== 'K' && m.bearing !== 'O' && m.bearing !== 'S') {
        const ls = s.damage.find(d => d.faceup && d.cardId === 'loose-stabilizer');
        if (ls) { ls.faceup = false; ev.push({ t: 'repair', shipId: s.id, cardId: ls.cardId }); sufferDamage(G, s, 1, 0, ev); }
      }
      if (f.ion) { const pr = s.damage.find(d => d.faceup && d.cardId === 'power-regulator'); if (pr) { pr.faceup = false; ev.push({ t: 'repair', shipId: s.id, cardId: pr.cardId }); } }
      const el = upgradeIdxWith(s, 'elusive');
      if (el >= 0 && res.full && m.difficulty === 'R' && s.upgrades[el].charges < 1) { s.upgrades[el].charges = 1; ev.push({ t: 'token', shipId: s.id, token: 'charge', delta: 1, upgradeIdx: el }); }
      f.step = 3; return;
    }
    case 3: {
      f.step = 4;
      const m: Maneuver = f.m;
      if (!f.ion && f.full && m.difficulty === 'B' && hasPilotAbility(s, 'focusAfterBlue') && legalActions(G, s, { allowed: ['focus'] }).length)
        pushAbility(G, 'focusAfterBlue', s, `${pilotDef(s).name}: perform a focus action?`, { name: pilotDef(s).name });
      return;
    }
    case 4: {
      f.step = 5;
      const m: Maneuver = f.m;
      const ab = upgradeIdxWith(s, 'afterburners');
      if (!f.ion && ab >= 0 && f.full && m.speed >= 3 && s.upgrades[ab].charges > 0 && legalActions(G, s, { allowed: ['boost'], ignoreStress: true }).length)
        pushAbility(G, 'afterburners', s, 'Afterburners: spend 1 charge to boost?', { upgradeIdx: ab, name: 'Afterburners' });
      return;
    }
    case 5: {
      f.step = 6;
      if (f.bump === 'friendly') return; // bumping a friend costs you the action outright
      if (G.options.variant === 'correspondence') {
        // Bank it: every ship moves first, then the Action Phase collects all of them at once.
        s.owedAction = { bumpedEnemy: f.bump === 'enemy', ionized: !!f.ion };
        return;
      }
      if (f.bump === 'enemy') { G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: ['focus', 'calculate'], forceRed: true, barOnly: true, noChain: true }); return; }
      G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: f.ion ? ['focus'] : undefined, barOnly: f.ion });
      return;
    }
    case 6:
      if (f.ion) spendToken(s, 'ion', s.tokens.ion, ev);
      s.activated = true;
      return pop(G);
  }
}

function runAction(G: GameState, f: Frame, ev: Ev) {
  const s = G.ships[f.shipId];
  if (!inPlay(s) || s.destroyed) return pop(G);
  switch (f.step) {
    case 0: {
      let opts = legalActions(G, s, f as any);
      if (f.barOnly) opts = opts.filter(o => actionBar(s).some(a => a.type === o.action));
      if (!opts.length) return pop(G);
      return choice(G, s.owner, 'action', f.allowed ? `Perform action (${f.allowed.map((a: ActionType) => ACTION_LABEL[a]).join(' / ')})` : 'Perform an action', [...opts, { id: 'pass', label: 'No action', shipId: s.id }], s.id);
    }
    case 1: {
      f.step = 2;
      const def = !f.allowed ? shipDef(s).actions.find(a => a.type === f.performed && a.linked) : undefined;
      if (def?.linked && !f.noChain) G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: [def.linked.type], forceRed: def.linked.difficulty === 'R' });
      return;
    }
    case 2: {
      f.step = 3;
      if (hasCrit(s, 'wounded-pilot')) { const die = rollAttackDie(G); ev.push({ t: 'roll', shipId: s.id, die, cause: 'Wounded Pilot' }); if (die === 'hit' || die === 'crit') gainToken(G, s, 'stress', 1, ev); }
      return;
    }
    case 3: {
      f.step = 4;
      if (!f.noChain && hasPilotAbility(s, 'forceForAction') && s.force > 0 && legalActions(G, s, {}).length)
        pushAbility(G, 'forceForAction', s, `${pilotDef(s).name}: spend 1 force to perform another action?`, { name: pilotDef(s).name });
      return;
    }
    case 4: {
      f.step = 5;
      if (!f.noChain && hasPilotAbility(s, 'redBoostAfterAction')) G.stack.push({ type: 'action', step: 0, shipId: s.id, allowed: ['boost'], forceRed: true });
      return;
    }
    default: return pop(G);
  }
}

function runEngage(G: GameState, f: Frame, ev: Ev) {
  const s = G.ships[f.shipId];
  if (!inPlay(s)) return pop(G);
  switch (f.step) {
    case 0: {
      f.step = 1;
      if (!s.destroyed) {
        if (hasCrit(s, 'console-fire')) { const die = rollAttackDie(G); ev.push({ t: 'roll', shipId: s.id, die, cause: 'Console Fire' }); if (die === 'hit') sufferDamage(G, s, 1, 0, ev); }
        if (hasCrit(s, 'power-regulator') && s.tokens.ion === 0) gainToken(G, s, 'ion', 1, ev);
      }
      return;
    }
    case 1: {
      const opts = attackOptions(G, s);
      if (!opts.length) { s.engaged = true; return pop(G); }
      return choice(G, s.owner, 'attack', `${pilotDef(s).name}: choose an attack`, [...opts, { id: 'pass', label: 'Hold fire', shipId: s.id }], s.id);
    }
    default: s.engaged = true; return pop(G);
  }
}

function runAttack(G: GameState, f: Frame, ev: Ev) {
  const A = G.attack!;
  const a = G.ships[A.attacker], d = G.ships[A.defender];
  switch (f.step) {
    case 0: {
      const w = weaponsOf(a).find(x => x.id === A.weapon)!;
      if (w.upgradeIdx >= 0 && w.chargeCost) { a.upgrades[w.upgradeIdx].charges -= w.chargeCost; ev.push({ t: 'token', shipId: a.id, token: 'charge', delta: -w.chargeCost, upgradeIdx: w.upgradeIdx }); }
      if (f.viaAim) { a.force--; ev.push({ t: 'token', shipId: a.id, token: 'force', delta: -1 }); }
      ev.push({ t: 'attack', attacker: a.id, defender: d.id, weapon: w.id, weaponName: w.name, range: A.range, obstructed: A.obstructed });
      if (hasPilotAbility(d, 'defenderRecoverForce')) recoverForce(d, 1, ev);
      A.attackDice = Array.from({ length: attackDiceCount(G, A) }, () => rollAttackDie(G));
      A.attackRerolled = A.attackDice.map(() => false);
      ev.push({ t: 'dice', pool: 'attack', shipId: a.id, dice: [...A.attackDice], cause: 'roll' });
      f.step = 1; return;
    }
    case 1: {
      const opts = attackModOptions(G, A);
      if (opts.length === 1) { f.step = 2; return; }
      return choice(G, a.owner, 'modifyAttack', 'Modify attack dice', opts, a.id);
    }
    case 2: {
      A.defenseDice = Array.from({ length: defenseDiceCount(G, A, ev) }, () => rollDefenseDie(G));
      if (hasPilotAbility(d, 'evadeIfEnemyClose') && activeShips(G).some(x => x.owner !== d.owner && shipRange(x, d) <= 1)) A.defenseDice.push('evade');
      A.defenseRerolled = A.defenseDice.map(() => false);
      ev.push({ t: 'dice', pool: 'defense', shipId: d.id, dice: [...A.defenseDice], cause: 'roll' });
      f.step = 3; return;
    }
    case 3: {
      const opts = defenseModOptions(G, A);
      if (opts.length === 1) { f.step = 4; return; }
      return choice(G, d.owner, 'modifyDefense', 'Modify defense dice', opts, d.id);
    }
    case 4: {
      f.step = 5;
      const w = weaponsOf(a).find(x => x.id === A.weapon)!;
      const cs = upgradeIdxWith(a, 'crackShot');
      if (cs >= 0 && w.primary && A.bullseye && a.upgrades[cs].charges > 0 && A.defenseDice.includes('evade'))
        pushAbility(G, 'crackShot', a, 'Crack Shot: spend 1 charge to cancel 1 evade?', { upgradeIdx: cs, name: 'Crack Shot' });
      return;
    }
    case 5: {
      const w = weaponsOf(a).find(x => x.id === A.weapon)!;
      let evades = A.defenseDice.filter(x => x === 'evade').length;
      let hits = A.attackDice.filter(x => x === 'hit').length, crits = A.attackDice.filter(x => x === 'crit').length;
      const ch = Math.min(hits, evades); hits -= ch; evades -= ch;
      crits -= Math.min(crits, evades);
      const hit = hits + crits > 0;
      ev.push({ t: 'attackResult', attacker: a.id, defender: d.id, hit, hits, crits });
      if (hit) {
        if (w.ion) { sufferDamage(G, d, 1, 0, ev); if (inPlay(d)) gainToken(G, d, 'ion', hits + crits - 1, ev); }
        else sufferDamage(G, d, hits, crits, ev);
      }
      f.step = 6; return;
    }
    case 6: {
      f.step = 7;
      for (const x of activeShips(G)) {
        if (x.owner === d.owner && hasPilotAbility(x, 'actionAfterFriendDefends') && inPlay(d) && shipRange(x, d) <= 1 && legalActions(G, x, {}).length)
          pushAbility(G, 'actionAfterFriendDefends', x, `${pilotDef(x).name}: perform an action?`, { name: pilotDef(x).name });
      }
      return;
    }
    default: G.attack = null; return pop(G);
  }
}

function advance(G: GameState, ev: Ev) {
  let guard = 0;
  while (!G.pending && G.stack.length && G.phase !== 'over') {
    if (++guard > 10000) throw new Error('Engine stuck');
    run(G, G.stack[G.stack.length - 1], ev);
  }
}

// ---------- commands ----------

export class RulesError extends Error {}

export function applyCommand(state: GameState, cmd: Command): { state: GameState; events: GameEvent[] } {
  const G: GameState = structuredClone(state);
  const ev: Ev = [];
  const P = G.pending;
  if (!P || G.phase === 'over') throw new RulesError('No decision pending.');
  const top = G.stack[G.stack.length - 1];
  if (cmd.type === 'placeShip') {
    if (P.type !== 'placeShip' || P.player !== cmd.player || P.shipId !== cmd.shipId) throw new RulesError('Not your placement.');
    const s = G.ships[cmd.shipId];
    const pose = { x: cmd.pose.x, y: cmd.pose.y, r: cmd.pose.r };
    if (![pose.x, pose.y, pose.r].every(Number.isFinite) || !deploymentValid(G, s, pose)) throw new RulesError('Invalid deployment position.');
    s.pose = pose; s.placed = true;
    ev.push({ t: 'placed', shipId: s.id, pose });
    top.idx++; G.pending = null;
  } else if (cmd.type === 'setDials') {
    if (P.type !== 'planning' || !P.players.includes(cmd.player)) throw new RulesError('Not planning.');
    const mine = activeShips(G).filter(s => s.owner === cmd.player);
    for (const s of mine) {
      const i = cmd.dials[s.id];
      const entry = dialFor(s)[i];
      if (!Number.isInteger(i) || !entry) throw new RulesError(`Missing dial for ${s.id}.`);
      if (!entry.allowed) throw new RulesError(`${pilotDef(s).name} is stressed and cannot select a red maneuver.`);
    }
    for (const s of mine) s.dial = cmd.dials[s.id];
    ev.push({ t: 'dialsSet', player: cmd.player });
    P.players = P.players.filter(p => p !== cmd.player);
    if (!P.players.length) G.pending = null;
  } else {
    if (P.type !== 'choice' || P.player !== cmd.player) throw new RulesError('Not your decision.');
    const o = P.options[cmd.option];
    if (!o) throw new RulesError('Invalid option.');
    G.pending = null;
    onChoice(G, top, P.kind, o, cmd.dice ?? [], ev);
  }
  advance(G, ev);
  return { state: G, events: ev };
}

function onChoice(G: GameState, f: Frame, kind: string, o: Option, picks: number[], ev: Ev) {
  switch (f.type) {
    case 'activationPhase': G.stack.push({ type: 'activateShip', step: 0, shipId: o.id }); return;
    case 'engagementPhase': G.stack.push({ type: 'engageShip', step: 0, shipId: o.id }); return;
    case 'activateShip': f.slide = Number(o.id.split(':')[1]); return;
    case 'action':
      if (o.id === 'pass') { G.stack.pop(); return; }
      f.performed = o.action; f.step = 1;
      performAction(G, G.ships[f.shipId], o, ev);
      return;
    case 'ability':
      G.stack.pop();
      if (o.id === 'yes') resolveAbility(G, f, ev);
      return;
    case 'shareFocus':
      G.stack.pop();
      if (o.id !== 'none') { ev.push({ t: 'ability', shipId: f.shipId, name: pilotDef(G.ships[f.shipId]).name }); gainToken(G, G.ships[o.id], 'focus', 1, ev); }
      return;
    case 'engageShip': {
      f.step = 2;
      if (o.id === 'pass') return;
      const a = G.ships[f.shipId], d = G.ships[o.targetId!];
      G.attack = { attacker: a.id, defender: d.id, weapon: o.weapon!, arc: o.arc!, range: o.range!, obstructed: !!o.obstructed, bullseye: inBullseye(a, d), attackDice: [], defenseDice: [], attackRerolled: [], defenseRerolled: [], used: [] };
      G.stack.push({ type: 'attack', step: 0, viaAim: o.id.endsWith(':aim') });
      return;
    }
    case 'attack':
      if (kind === 'modifyAttack') { if (o.id === 'done') f.step = 2; else applyAttackMod(G, G.attack!, o, picks, ev); }
      else if (kind === 'modifyDefense') { if (o.id === 'done') f.step = 4; else applyDefenseMod(G, G.attack!, o, picks, ev); }
      return;
  }
}

// ---------- views ----------

/** What `player` is allowed to know: hides enemy dials, facedown cards, the deck and the RNG. */
export function viewFor(G: GameState, player: PlayerId | 'spectator'): GameState {
  const V: GameState = structuredClone(G);
  V.rng = 0; V.deck = []; V.discard = [];
  for (const s of Object.values(V.ships)) {
    if (s.owner !== player && !s.dialRevealed && s.dial >= 0) s.dial = -2;
    for (const c of s.damage) if (!c.faceup) c.cardId = 'hidden';
  }
  return V;
}
