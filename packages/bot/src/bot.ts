// Three-layer bot: squad commander (target + roles) → per-pilot GOAP intent → simulation-based
// maneuver/action evaluation. It only ever receives a redacted view, so it cannot see hidden dials.
import {
  PLAY_AREA, activeShips, atRange0OfObstacle, attackOptions, basePoly, closestPoints, deploymentValid, dialFor, fwd,
  hullRemaining, isObstructed, isStressed, measureArc, normAngle, pilotDef, previewManeuver, resolveMove, shipDef,
  shipPoly, shipRange, weaponsOf, isIonized,
} from '@holotable/rules';
import type { Command, GameState, Option, PlayerId, Pose, ShipState } from '@holotable/rules';
import { expectedDamage } from './diceMath';
import { Facts, GoapAction, plan } from './goap';

export type Difficulty = 'rookie' | 'veteran' | 'ace';
export interface Personality { name: string; offense: number; defense: number; closing: number; riskTolerance: number }
export const PERSONALITIES: Record<string, Personality> = {
  jouster: { name: 'Jouster', offense: 1.25, defense: 0.75, closing: 1.2, riskTolerance: 1.2 },
  flanker: { name: 'Flanker', offense: 1.0, defense: 1.15, closing: 0.8, riskTolerance: 0.9 },
  guardian: { name: 'Guardian', offense: 0.9, defense: 1.3, closing: 0.9, riskTolerance: 0.8 },
};
export interface BotOptions { difficulty?: Difficulty; personality?: keyof typeof PERSONALITIES; seed?: number }

interface Belief { ship: ShipState; poses: { pose: Pose; w: number }[] }
interface Intent { off: number; def: number; close: number; blueBonus: number; flipBonus: number; wantLock: boolean; wantFocus: boolean; plan: string[] }

const PILOT_ACTIONS: GoapAction[] = [
  { name: 'Approach', cost: 2, pre: { targetInRange: false }, eff: { targetInRange: true } },
  { name: 'LineUp', cost: 1, pre: { targetInRange: true, hasShot: false, targetBehind: false }, eff: { hasShot: true } },
  { name: 'FlipTurn', cost: 2, pre: { targetBehind: true, stressed: false }, eff: { targetBehind: false, hasShot: true, stressed: true } },
  { name: 'ComeAbout', cost: 3.5, pre: { targetBehind: true }, eff: { targetBehind: false } },
  { name: 'ClearStress', cost: 1, pre: { stressed: true }, eff: { stressed: false } },
  { name: 'AcquireLock', cost: 1, pre: { targetInRange: true, stressed: false, targetLocked: false }, eff: { targetLocked: true } },
  { name: 'FocusUp', cost: 1, pre: { stressed: false, hasFocus: false }, eff: { hasFocus: true } },
  { name: 'FireOrdnance', cost: 1, pre: { hasShot: true, targetLocked: true, hasOrdnance: true }, eff: { damageDealt: true } },
  { name: 'FireFocused', cost: 2.5, pre: { hasShot: true, hasFocus: true }, eff: { damageDealt: true } },
  { name: 'FirePrimary', cost: 5, pre: { hasShot: true }, eff: { damageDealt: true } },
  { name: 'Disengage', cost: 2, pre: { inDanger: true }, eff: { inDanger: false, safe: true, hasShot: false } },
];

export class Bot {
  readonly player: PlayerId;
  readonly difficulty: Difficulty;
  readonly personality: Personality;
  private seed: number;
  private focusTarget: string | null = null;
  private intents: Record<string, Intent> = {};
  private intentRound = -1;

  constructor(player: PlayerId, opts: BotOptions = {}) {
    this.player = player;
    this.difficulty = opts.difficulty ?? 'veteran';
    this.personality = PERSONALITIES[opts.personality ?? 'jouster'];
    this.seed = (opts.seed ?? 12345) >>> 0;
  }

  private rand(): number { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }
  private noise(): number {
    const sigma = this.difficulty === 'rookie' ? 0.9 : this.difficulty === 'veteran' ? 0.25 : 0.05;
    return (this.rand() + this.rand() + this.rand() - 1.5) * 2 * sigma;
  }

  /** Returns the command for the current pending decision, or null when it is not this bot's turn. */
  decide(G: GameState): Command | null {
    const P = G.pending;
    if (!P) return null;
    if (P.type === 'placeShip') return P.player === this.player ? this.place(G, G.ships[P.shipId]) : null;
    if (P.type === 'planning') return P.players.includes(this.player) ? this.planDials(G) : null;
    if (P.player !== this.player) return null;
    const pick = (i: number, dice?: number[]): Command => ({ type: 'choose', player: this.player, option: Math.max(0, i), dice });
    switch (P.kind) {
      case 'activateShip': case 'engageShip': return pick(0);
      case 'tallon': return pick(this.best(P.options, o => this.positionScore(G, G.ships[P.shipId!], o.pose!, this.intentFor(G, G.ships[P.shipId!]), this.beliefs(G), false)));
      case 'action': return pick(this.chooseAction(G, G.ships[P.shipId!], P.options));
      case 'attack': return pick(this.chooseAttack(G, G.ships[P.shipId!], P.options));
      case 'modifyAttack': return this.modifyAttack(G, P.options, pick);
      case 'modifyDefense': return this.modifyDefense(G, P.options, pick);
      case 'ability': return pick(this.useAbility(G, P.shipId!, P.prompt) ? 0 : 1);
      case 'chooseShip': {
        const i = this.best(P.options, o => (o.id === 'none' ? -1 : (G.ships[o.id].tokens.focus ? 0 : 1) + (G.ships[o.id].engaged ? 0 : 1) + G.ships[o.id].initiative / 10));
        return pick(i);
      }
    }
    return pick(0);
  }

  private best<T>(xs: T[], score: (x: T) => number): number {
    let bi = 0, bs = -Infinity;
    xs.forEach((x, i) => { const s = score(x); if (s > bs) { bs = s; bi = i; } });
    return bi;
  }

  // ---------- setup ----------

  private place(G: GameState, s: ShipState): Command {
    const mine = G.shipOrder.map(id => G.ships[id]).filter(x => x.owner === this.player);
    const idx = mine.indexOf(s), n = mine.length;
    const centre = PLAY_AREA / 2 + (this.rand() - 0.5) * 60;
    const y = this.player === 0 ? 24 : PLAY_AREA - 24, r = this.player === 0 ? Math.PI / 2 : -Math.PI / 2;
    for (let attempt = 0; attempt < 200; attempt++) {
      const spread = 64 + attempt * 2;
      const x = Math.max(30, Math.min(PLAY_AREA - 30, centre + (idx - (n - 1) / 2) * spread + (attempt ? (this.rand() - 0.5) * attempt * 8 : 0)));
      const pose = { x, y: y + (this.player === 0 ? 1 : -1) * (attempt > 20 ? this.rand() * 50 : 0), r };
      if (deploymentValid(G, s, pose)) return { type: 'placeShip', player: this.player, shipId: s.id, pose };
    }
    throw new Error('Bot could not find a deployment position');
  }

  // ---------- commander ----------

  private enemies(G: GameState) { return activeShips(G).filter(s => s.owner !== this.player); }
  private friends(G: GameState) { return activeShips(G).filter(s => s.owner === this.player); }

  private chooseFocusTarget(G: GameState): string | null {
    const foes = this.enemies(G), mine = this.friends(G);
    if (!foes.length) return null;
    const value = (e: ShipState) => {
      const health = hullRemaining(e) + e.shields;
      const reach = mine.reduce((n, m) => n + 1 / (1 + Math.hypot(m.pose.x - e.pose.x, m.pose.y - e.pose.y) / 250), 0);
      return (e.cost + 1) * reach / (health * (1 + shipDef(e).agility * 0.35));
    };
    const cur = foes.find(e => e.id === this.focusTarget);
    const bestFoe = foes[this.best(foes, value)];
    if (cur && value(cur) * 1.25 >= value(bestFoe)) return cur.id; // hysteresis: don't flip targets on a whim
    return bestFoe.id;
  }

  private intentFor(G: GameState, s: ShipState): Intent {
    if (this.intentRound !== G.round) { this.intents = {}; this.intentRound = G.round; this.focusTarget = this.chooseFocusTarget(G); }
    return (this.intents[s.id] ??= this.makeIntent(G, s));
  }

  private makeIntent(G: GameState, s: ShipState): Intent {
    const target = this.focusTarget ? G.ships[this.focusTarget] : this.enemies(G)[0];
    const pers = this.personality;
    const intent: Intent = { off: pers.offense, def: pers.defense, close: 0.4 * pers.closing, blueBonus: 0, flipBonus: 0, wantLock: false, wantFocus: false, plan: [] };
    if (!target) return intent;
    const rel = normAngle(Math.atan2(target.pose.y - s.pose.y, target.pose.x - s.pose.x) - s.pose.r);
    const health = (hullRemaining(s) + s.shields) / (s.hull + s.shieldsMax);
    const threat = this.enemies(G).filter(e => shipRange(e, s) <= 2 && weaponsOf(e).some(w => measureArc(e.pose, shipDef(e).size, w.arc, shipPoly(s)).inArc)).length;
    const facts: Facts = {
      targetInRange: shipRange(s, target) <= 3,
      hasShot: false,
      targetBehind: Math.abs(rel) > Math.PI * 0.6,
      targetLocked: s.lock === target.id,
      hasOrdnance: weaponsOf(s).some(w => w.requires === 'lock' && s.upgrades[w.upgradeIdx].charges > 0),
      stressed: isStressed(s),
      hasFocus: s.tokens.focus > 0,
      inDanger: health <= 0.34 * (2 - pers.riskTolerance) + 0.2 && threat >= 2,
    };
    const goal: Facts = facts.inDanger ? { safe: true } : { damageDealt: true };
    const steps = plan(facts, goal, PILOT_ACTIONS) ?? [];
    intent.plan = steps.map(a => a.name);
    const soon = intent.plan.slice(0, 3);
    if (intent.plan[0] === 'ClearStress' || (facts.stressed && soon.includes('ClearStress'))) intent.blueBonus = 1.5;
    if (soon.includes('Approach')) intent.close = 1.0 * pers.closing;
    if (soon[0] === 'FlipTurn') intent.flipBonus = 0.8;
    if (soon.includes('Disengage')) { intent.def *= 2; intent.off *= 0.5; intent.close = -0.5; }
    if (intent.plan.includes('AcquireLock')) intent.wantLock = true;
    if (intent.plan.includes('FocusUp')) intent.wantFocus = true;
    return intent;
  }

  // ---------- beliefs ----------

  /** Probability-weighted guesses for where each enemy will end its maneuver. */
  private beliefs(G: GameState): Belief[] {
    const mine = this.friends(G);
    const K = this.difficulty === 'rookie' ? 2 : this.difficulty === 'veteran' ? 4 : 6;
    return this.enemies(G).map(e => {
      if (e.activated || G.phase === 'engagement' || G.phase === 'end') return { ship: e, poses: [{ pose: e.pose, w: 1 }] };
      const cands = dialFor(e).filter(d => d.allowed).map(d => {
        const m = isIonized(e) ? { speed: 1, bearing: 'F' as const } : d.maneuver;
        const res = resolveMove(G, e, m, 0);
        let score = 0;
        if (offBoard(res.pose)) score -= 10;
        for (const o of res.hitObstacles) score -= o.kind === 'asteroid' ? 2 : 1;
        if (d.difficulty === 'R') score -= 0.3;
        if (d.difficulty === 'B' && isStressed(e)) score += 0.6;
        for (const m2 of mine) {
          const guess = previewManeuver(m2, { speed: 2, bearing: 'F' });
          score += 1.0 * this.shot(G, e, res.pose, m2, guess, false) - 0.5 * this.shot(G, m2, guess, e, res.pose, false);
          score -= Math.hypot(guess.x - res.pose.x, guess.y - res.pose.y) / 1500;
        }
        return { pose: res.pose, score };
      });
      cands.sort((a, b) => b.score - a.score);
      const top = cands.slice(0, K);
      const mx = top[0]?.score ?? 0;
      const ws = top.map(c => Math.exp((c.score - mx) / 0.6));
      const sum = ws.reduce((a, b) => a + b, 0) || 1;
      return { ship: e, poses: top.map((c, i) => ({ pose: c.pose, w: ws[i] / sum })) };
    });
  }

  /** Expected damage of attacker's best weapon from `ap` against defender at `dp`. */
  private shot(G: GameState, att: ShipState, ap: Pose, def: ShipState, dp: Pose, assumeFocus: boolean, turretAny = false): number {
    if (att.tokens.disarm > 0) return 0;
    const dpoly = basePoly(dp, shipDef(def).size);
    let bestDmg = 0;
    for (const w of weaponsOf(att)) {
      if (w.upgradeIdx >= 0 && att.upgrades[w.upgradeIdx].charges < w.chargeCost) continue;
      if (w.requires === 'lock' && att.lock !== def.id) continue;
      const arcs = turretAny && !w.primary && w.arc !== 'front' ? (['front', 'left', 'right', 'rear'] as const) : [w.arc];
      for (const arc of arcs) {
        const m = measureArc(ap, shipDef(att).size, arc, dpoly);
        if (!m.inArc || m.range < w.minRange || m.range > w.maxRange) continue;
        let dice = w.value + (m.range === 1 && !w.ordnance ? 1 : 0);
        let agi = shipDef(def).agility + (m.range === 3 && !w.ordnance ? 1 : 0) + (isObstructed(G, m.from, m.to) ? 1 : 0);
        if (pilotDef(att).ability === 'minusDefenseDie') agi--;
        if (pilotDef(att).ability === 'plusDieRange1' && m.range === 1) dice++;
        const focus = assumeFocus || att.tokens.focus > 0 || att.force > 0;
        const dmg = expectedDamage(dice, { focus, reroll: att.lock === def.id && !w.requires }, agi, { focus: def.tokens.focus > 0 || def.force > 0, evade: def.tokens.evade > 0 });
        bestDmg = Math.max(bestDmg, w.ion ? Math.min(dmg, 1) + 0.4 * Math.max(0, dmg - 1) : dmg);
      }
    }
    return bestDmg;
  }

  // ---------- position evaluation ----------

  private positionScore(G: GameState, s: ShipState, pose: Pose, intent: Intent, beliefs: Belief[], canAct: boolean): number {
    if (offBoard(pose)) return -1000;
    let offense = 0, defense = 0, closing = 0;
    const health = (hullRemaining(s) + s.shields) / (s.hull + s.shieldsMax);
    for (const b of beliefs) {
      let o = 0, d = 0;
      for (const p of b.poses) {
        o += p.w * this.shot(G, s, pose, b.ship, p.pose, canAct, true);
        d += p.w * this.shot(G, b.ship, p.pose, s, pose, !isStressed(b.ship));
      }
      const pri = b.ship.id === this.focusTarget ? 1.3 : 1;
      const finishing = o >= hullRemaining(b.ship) + b.ship.shields ? 1.3 : 1;
      offense = Math.max(offense, o * pri * finishing);
      defense += d;
      if (b.ship.id === this.focusTarget || beliefs.length === 1) {
        const p0 = b.poses[0].pose;
        const dist = Math.hypot(p0.x - pose.x, p0.y - pose.y);
        const ang = Math.abs(normAngle(Math.atan2(p0.y - pose.y, p0.x - pose.x) - pose.r));
        closing = -(dist / 900) - (ang / Math.PI) * 0.9;
      }
    }
    let score = intent.off * offense - intent.def * defense * (1 + (1 - health) * 0.8) + intent.close * closing;
    // Don't fly off the table next round: look at the room ahead of the nose.
    const f = fwd(pose.r);
    const ahead = Math.min(
      f.x > 0 ? (PLAY_AREA - pose.x) / f.x : f.x < 0 ? -pose.x / f.x : Infinity,
      f.y > 0 ? (PLAY_AREA - pose.y) / f.y : f.y < 0 ? -pose.y / f.y : Infinity);
    if (ahead < 90) score -= 2.2; else if (ahead < 170) score -= 0.8;
    if (G.obstacles.some(ob => closestPoints(basePoly(pose), ob.poly).dist <= 0.05)) score -= 1.2; // can't shoot while touching
    return score;
  }

  // ---------- planning ----------

  private planDials(G: GameState): Command {
    const beliefs = this.beliefs(G);
    const dials: Record<string, number> = {};
    const planned: { id: string; pose: Pose }[] = [];
    const mine = this.friends(G).sort((a, b) => a.initiative - b.initiative);
    for (const s of mine) {
      const intent = this.intentFor(G, s);
      const entries = dialFor(s).filter(d => d.allowed);
      let bestIdx = entries[0].index, bestScore = -Infinity, bestPose = s.pose;
      for (const d of entries) {
        const res = resolveMove(G, s, isIonized(s) ? { speed: 1, bearing: 'F' } : d.maneuver, 0);
        let score = this.positionScore(G, s, res.pose, intent, beliefs, d.difficulty !== 'R' && !isStressed(s) || d.difficulty === 'B');
        for (const o of res.hitObstacles) score -= (o.kind === 'asteroid' ? 2.2 : o.kind === 'debris' ? 1.2 : 1.0) / this.personality.riskTolerance;
        if (!res.full) score -= 0.9;
        if (planned.some(p => Math.hypot(p.pose.x - res.pose.x, p.pose.y - res.pose.y) < 46)) score -= 1.5; // likely friendly bump
        if (d.difficulty === 'R') score -= 0.45;
        if (d.difficulty === 'B') score += (isStressed(s) ? 0.5 : 0.05) + intent.blueBonus;
        if ('KLPER'.includes(d.maneuver.bearing)) score += intent.flipBonus;
        score += this.noise();
        if (score > bestScore) { bestScore = score; bestIdx = d.index; bestPose = res.pose; }
      }
      dials[s.id] = bestIdx;
      planned.push({ id: s.id, pose: bestPose });
    }
    return { type: 'setDials', player: this.player, dials };
  }

  // ---------- actions ----------

  private chooseAction(G: GameState, s: ShipState, options: Option[]): number {
    const intent = this.intentFor(G, s);
    const beliefs = this.beliefs(G);
    const here = this.positionScore(G, s, s.pose, intent, beliefs, false);
    const threat = beliefs.reduce((n, b) => n + b.poses.reduce((m, p) => m + p.w * this.shot(G, b.ship, p.pose, s, s.pose, true), 0), 0);
    const bestShot = (focus: boolean) => Math.max(0, ...beliefs.map(b => b.poses.reduce((m, p) => m + p.w * this.shot(G, s, s.pose, b.ship, p.pose, focus, true), 0)));
    const base = bestShot(false);
    const value = (o: Option): number => {
      let val = 0;
      switch (o.action) {
        case undefined: return 0; // pass
        case 'focus': val = (s.tokens.focus || s.force > 1 ? 0.1 : (bestShot(true) - base) * intent.off + threat * 0.22 * intent.def) + (intent.wantFocus ? 0.1 : 0) + 0.15; break;
        case 'calculate': val = 0.5 * (bestShot(true) - base) + 0.1; break;
        case 'evade': val = threat * 0.3 * intent.def + 0.05; break;
        case 'lock': {
          const t = G.ships[o.targetId!];
          const hasOrd = weaponsOf(s).some(w => w.requires === 'lock' && s.upgrades[w.upgradeIdx].charges > 0);
          const canShootNow = attackOptions(G, s).some(a => a.targetId === t.id);
          val = (canShootNow ? 0.35 * base + 0.2 : 0.15) + (hasOrd ? 0.7 : 0) + (intent.wantLock ? 0.3 : 0) + (t.id === this.focusTarget ? 0.25 : 0);
          if (shipDef(s).shipAbility?.id === 'atc') val += 0.5;
          break;
        }
        case 'barrelRoll': case 'boost': val = this.positionScore(G, s, o.pose!, intent, beliefs, false) - here - 0.1; break;
        case 'rotate': {
          const turned = { ...s, turret: o.facing! } as ShipState;
          const gain = Math.max(0, ...beliefs.map(b => b.poses.reduce((m, p) => m + p.w * this.shotFixed(G, turned, b.ship, p.pose), 0))) - Math.max(0, ...beliefs.map(b => b.poses.reduce((m, p) => m + p.w * this.shotFixed(G, s, b.ship, p.pose), 0)));
          val = gain * 1.2; break;
        }
        case 'reload': val = base > 0.3 ? -0.5 : 0.5; break;
        case 'card': val = base > 0.5 ? 0.25 : 0.7; break;
      }
      if (o.red) val -= 0.4;
      return val + this.noise() * 0.3;
    };
    return this.best(options, value);
  }

  private shotFixed(G: GameState, att: ShipState, def: ShipState, dp: Pose): number { return this.shot(G, att, att.pose, def, dp, false, false); }

  // ---------- combat ----------

  private chooseAttack(G: GameState, s: ShipState, options: Option[]): number {
    return this.best(options, o => {
      if (o.id === 'pass') return 0.01;
      const t = G.ships[o.targetId!];
      const w = weaponsOf(s).find(x => x.id === o.weapon)!;
      const dice = w.value + (o.range === 1 && !w.ordnance ? 1 : 0);
      const agi = shipDef(t).agility + (o.range === 3 && !w.ordnance ? 1 : 0) + (o.obstructed ? 1 : 0);
      let dmg = expectedDamage(dice, { focus: s.tokens.focus > 0 || s.force > 0, reroll: s.lock === t.id && !w.requires }, agi, { focus: t.tokens.focus > 0 || t.force > 0, evade: t.tokens.evade > 0 });
      if (w.ion) dmg = Math.min(dmg, 1) + (t.activated ? 0.2 : 0.5) * Math.max(0, dmg - 1);
      const health = hullRemaining(t) + t.shields;
      let val = dmg * (1 + t.cost / 10) * (t.id === this.focusTarget ? 1.2 : 1);
      if (dmg >= health * 0.8) val *= 1.4;
      if (o.detail) val -= 0.2; // costs force
      return val + this.noise() * 0.2;
    });
  }

  private modifyAttack(G: GameState, options: Option[], pick: (i: number, dice?: number[]) => Command): Command {
    const A = G.attack!;
    const a = G.ships[A.attacker];
    const dice = A.attackDice;
    const canConvert = a.tokens.focus > 0 || a.force > 0 || a.tokens.calculate > 0;
    const idx = (id: string) => options.findIndex(o => o.id === id);
    const wanted = dice.map((f, i) => ({ f, i })).filter(x => !A.attackRerolled[x.i] && (x.f === 'blank' || (x.f === 'focus' && !canConvert))).map(x => x.i);
    for (const id of ['auraReroll', 'predator', 'rerollPerFriendNearDefender', 'fireControl', 'lock']) {
      const i = idx(id);
      if (i >= 0 && wanted.length && (id !== 'lock' || wanted.length >= 1)) return pick(i, wanted.slice(0, options[i].pickDice!.max));
    }
    for (const id of ['atc', 'marksmanship', 'hitToCrit']) if (idx(id) >= 0) return pick(idx(id));
    const focusCount = dice.filter(f => f === 'focus').length;
    if (focusCount >= 2 && idx('focus') >= 0) return pick(idx('focus'));
    if (focusCount >= 1 && idx('force') >= 0 && a.force > 1) return pick(idx('force'));
    if (focusCount >= 1 && idx('calculate') >= 0) return pick(idx('calculate'));
    if (focusCount >= 1 && idx('focus') >= 0) return pick(idx('focus'));
    if (focusCount >= 1 && idx('force') >= 0) return pick(idx('force'));
    return pick(idx('done'));
  }

  private modifyDefense(G: GameState, options: Option[], pick: (i: number, dice?: number[]) => Command): Command {
    const A = G.attack!;
    const incoming = A.attackDice.filter(f => f === 'hit' || f === 'crit').length;
    const evades = A.defenseDice.filter(f => f === 'evade').length;
    const idx = (id: string) => options.findIndex(o => o.id === id);
    if (evades >= incoming) return pick(idx('done'));
    const focusCount = A.defenseDice.filter(f => f === 'focus').length;
    const need = incoming - evades;
    if (idx('elusive') >= 0) { const b = A.defenseDice.findIndex((f, i) => f === 'blank' && !A.defenseRerolled[i]); if (b >= 0) return pick(idx('elusive'), [b]); }
    if (focusCount >= 2 && idx('brilliantEvasion') >= 0) return pick(idx('brilliantEvasion'));
    if (focusCount >= 1 && need === 1 && idx('force') >= 0) return pick(idx('force'));
    if (focusCount >= 1 && idx('calculate') >= 0) return pick(idx('calculate'));
    if (focusCount >= 1 && idx('focus') >= 0) return pick(idx('focus'));
    if (focusCount >= 1 && idx('force') >= 0) return pick(idx('force'));
    if (idx('evade') >= 0) return pick(idx('evade'));
    return pick(idx('done'));
  }

  private useAbility(G: GameState, shipId: string, prompt: string): boolean {
    const s = G.ships[shipId];
    if (/disarm/i.test(prompt)) {
      // Shield regeneration costs this round's attack: only when nobody is likely to be in our sights.
      const beliefs = this.beliefs(G);
      const shotLikely = beliefs.some(b => b.poses.some(p => this.shot(G, s, s.pose, b.ship, p.pose, false, true) > 0.4));
      return !shotLikely || (s.shields === 0 && hullRemaining(s) <= 2);
    }
    if (/spend 1 force to perform another action/i.test(prompt)) return s.force >= 2 || this.enemies(G).every(e => e.activated);
    return true;
  }
}

function offBoard(p: Pose): boolean {
  return basePoly(p).some(q => q.x < 0 || q.y < 0 || q.x > PLAY_AREA || q.y > PLAY_AREA);
}

export { atRange0OfObstacle };
