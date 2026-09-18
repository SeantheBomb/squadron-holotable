// Correspondence turns: a player submits a *packet* covering everything they can decide up front,
// plus policies for the things they cannot foresee (which die to reroll depends on the roll).
//
// The server then runs the engine forward, answering each pending decision from the packet, and
// stops at the first decision the packet does not cover. Nothing here changes the rules — it only
// answers the same prompts a human would, which is why live and correspondence share one engine.
import { activeShips, deploymentValid, dialFor } from '@holotable/rules';
import type { Command, GameState, PlayerId, Pose } from '@holotable/rules';
import { Bot } from './bot';

/** What a player states in advance for the things a packet cannot spell out. */
export interface Policy {
  /** Dice modifiers (spend focus, reroll with a lock, evade). 'assist' lets the flight computer decide. */
  dice: 'assist' | 'ask';
  /** Card prompts such as "spend a charge to recover a shield?" */
  abilities: 'assist' | 'ask';
}
export const DEFAULT_POLICY: Policy = { dice: 'assist', abilities: 'assist' };

/**
 * One recorded choice. Matched to a prompt by kind *and* ship rather than by position, so a packet
 * still lands correctly if the server's run diverges from what the player saw (a damage card can
 * make a ship skip its action, for instance).
 */
export interface Choice { kind: string; shipId?: string; option: string }

export interface TurnPacket {
  player: PlayerId;
  /** Setup: ship id → where to place it. Invalid poses fall back to the assistant. */
  deploy?: Record<string, Pose>;
  /** Planning: ship id → dial index. */
  dials?: Record<string, number>;
  /** Everything else this sitting covers, in the order the player made them. */
  choices?: Choice[];
  policy?: Policy;
}

/** The stages a correspondence player is asked for. Everything else is policy. */
export type Stage = 'deploy' | 'dials' | 'actions' | 'attacks' | 'decision';

export type Answer =
  | { kind: 'command'; command: Command }
  | { kind: 'ask'; stage: Stage; player: PlayerId }
  | { kind: 'idle' };

export function stageOf(G: GameState): { stage: Stage; player: PlayerId | null } {
  const P = G.pending;
  if (!P) return { stage: 'decision', player: null };
  if (P.type === 'planning') return { stage: 'dials', player: P.players[0] ?? null };
  if (P.type === 'placeShip') return { stage: 'deploy', player: P.player };
  if (P.kind === 'action') return { stage: 'actions', player: P.player };
  if (P.kind === 'attack') return { stage: 'attacks', player: P.player };
  return { stage: 'decision', player: P.player };
}

const botCache = new Map<string, Bot>();
function assistant(player: PlayerId, seed: number): Bot {
  const key = `${player}:${seed}`;
  let b = botCache.get(key);
  if (!b) { b = new Bot(player, { difficulty: 'ace', seed }); botCache.set(key, b); }
  return b;
}

/** Consumed choices are tracked per run, so the same entry is never used twice. */
export interface Consumed { used: Set<number> }
export const freshConsumed = (): Consumed => ({ used: new Set() });

export function answer(
  G: GameState,
  packets: Partial<Record<PlayerId, TurnPacket>>,
  seed = 1,
  consumed: Consumed = freshConsumed(),
): Answer {
  const P = G.pending;
  if (!P || G.phase === 'over') return { kind: 'idle' };

  // ---- planning: every ship needs a dial, and both players submit independently
  if (P.type === 'planning') {
    for (const player of P.players) {
      const dials = packets[player]?.dials;
      const mine = activeShips(G).filter(s => s.owner === player);
      if (!dials || mine.some(s => !Number.isInteger(dials[s.id]))) continue;
      // Drop anything the ship cannot legally set — stress can arrive after the packet was written.
      const fixed: Record<string, number> = {};
      for (const s of mine) {
        const legal = dialFor(s);
        fixed[s.id] = legal[dials[s.id]]?.allowed ? dials[s.id] : (legal.find(d => d.allowed)?.index ?? 0);
      }
      return { kind: 'command', command: { type: 'setDials', player, dials: fixed } };
    }
    return { kind: 'ask', stage: 'dials', player: P.players[0] };
  }

  const player = P.player;
  const packet = packets[player];
  const policy = packet?.policy ?? DEFAULT_POLICY;
  const assist = (): Answer => {
    const cmd = assistant(player, seed).decide(G);
    return cmd ? { kind: 'command', command: cmd } : { kind: 'ask', stage: stageOf(G).stage, player };
  };

  // ---- setup: place from the packet, falling back if the spot is no longer legal
  if (P.type === 'placeShip') {
    const pose = packet?.deploy?.[P.shipId];
    if (pose && deploymentValid(G, G.ships[P.shipId], pose)) {
      return { kind: 'command', command: { type: 'placeShip', player, shipId: P.shipId, pose } };
    }
    if (packet?.deploy) return assist();   // they submitted, but that spot is taken — put it somewhere legal
    return { kind: 'ask', stage: 'deploy', player };
  }

  // ---- a recorded choice for this exact prompt
  const choices = packet?.choices ?? [];
  for (let i = 0; i < choices.length; i++) {
    if (consumed.used.has(i)) continue;
    const c = choices[i];
    if (c.kind !== P.kind) continue;
    if (c.shipId && P.shipId && c.shipId !== P.shipId) continue;
    const idx = P.options.findIndex(o => o.id === c.option);
    if (idx < 0) continue;
    if (P.options[idx].pickDice) continue;    // needs dice picked; the assistant does that better
    consumed.used.add(i);
    return { kind: 'command', command: { type: 'choose', player, option: idx } };
  }

  switch (P.kind) {
    case 'action': return packet?.choices ? assist() : { kind: 'ask', stage: 'actions', player };
    case 'attack': return packet?.choices ? assist() : { kind: 'ask', stage: 'attacks', player };
    case 'modifyAttack':
    case 'modifyDefense':
      return policy.dice === 'assist' ? assist() : { kind: 'ask', stage: 'decision', player };
    case 'ability':
      return policy.abilities === 'assist' ? assist() : { kind: 'ask', stage: 'decision', player };
    // Ordering your own tied ships, Tallon placement, handing a focus to a wingmate: mechanical.
    default: return assist();
  }
}

export interface RunResult { state: GameState; events: any[]; waitingOn: PlayerId | null; stage: Stage }

/** Drive the game as far as the submitted packets allow, and report who is blocking. */
export function runForward(
  G: GameState,
  packets: Partial<Record<PlayerId, TurnPacket>>,
  apply: (s: GameState, c: Command) => { state: GameState; events: any[] },
  seed = 1,
): RunResult {
  let state = G;
  const events: any[] = [];
  const consumed = freshConsumed();
  for (let guard = 0; guard < 8000; guard++) {
    if (state.phase === 'over') return { state, events, waitingOn: null, stage: 'decision' };
    const a = answer(state, packets, seed, consumed);
    if (a.kind === 'idle') return { state, events, waitingOn: null, stage: 'decision' };
    if (a.kind === 'ask') return { state, events, waitingOn: a.player, stage: a.stage };
    const res = apply(state, a.command);
    state = res.state;
    events.push(...res.events);
  }
  throw new Error('Correspondence run did not settle');
}
