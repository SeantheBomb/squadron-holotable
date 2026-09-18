// Correspondence turns: a player submits a *packet* covering everything they can decide up front,
// plus policies for the things they cannot foresee (which die to reroll depends on the roll).
//
// The server then runs the engine forward, answering each pending decision from the packet, and
// stops at the first decision the packet does not cover. Nothing here changes the rules — it only
// answers the same prompts a human would, which is why live and correspondence share one engine.
import { activeShips, dialFor } from '@holotable/rules';
import type { Command, GameState, PlayerId } from '@holotable/rules';
import { Bot } from './bot';

/** What a player states in advance for the things a packet cannot spell out. */
export interface Policy {
  /** Dice modifiers (spend focus, reroll with a lock, evade). 'assist' lets the flight computer decide. */
  dice: 'assist' | 'ask';
  /** Card prompts such as "spend a charge to recover a shield?" */
  abilities: 'assist' | 'ask';
  /** Which of your own tied ships goes first, and Tallon roll placement. Never worth a round trip. */
  minor: 'assist';
}

export const DEFAULT_POLICY: Policy = { dice: 'assist', abilities: 'assist', minor: 'assist' };

export interface TurnPacket {
  player: PlayerId;
  /** Planning phase: ship id → dial index. */
  dials?: Record<string, number>;
  /** Action phase: ship id → the `Option.id` to take, or 'pass'. */
  actions?: Record<string, string>;
  /** Engagement: ship id → the `Option.id` of the attack to make, or 'pass'. */
  attacks?: Record<string, string>;
  policy?: Policy;
}

export type Answer =
  | { kind: 'command'; command: Command }
  | { kind: 'ask'; stage: Stage; player: PlayerId }   // needs this player, and the packet cannot cover it
  | { kind: 'idle' };                                  // waiting on the other player

/** The three things a correspondence player is ever asked for. */
export type Stage = 'dials' | 'actions' | 'attacks' | 'decision';

export function stageOf(G: GameState): { stage: Stage; player: PlayerId | null } {
  const P = G.pending;
  if (!P) return { stage: 'decision', player: null };
  if (P.type === 'planning') return { stage: 'dials', player: P.players[0] ?? null };
  if (P.type === 'placeShip') return { stage: 'decision', player: P.player };
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

/**
 * Answer the current decision from `packets`, or say who needs to be asked.
 * `seed` keeps the assistant's tie-breaking stable for a given match.
 */
export function answer(G: GameState, packets: Partial<Record<PlayerId, TurnPacket>>, seed = 1): Answer {
  const P = G.pending;
  if (!P || G.phase === 'over') return { kind: 'idle' };

  // ---- planning: every ship needs a dial, and both players submit independently
  if (P.type === 'planning') {
    for (const player of P.players) {
      const packet = packets[player];
      const mine = activeShips(G).filter(s => s.owner === player);
      const dials = packet?.dials;
      if (!dials || mine.some(s => !Number.isInteger(dials[s.id]))) continue;
      // Drop anything the ship cannot legally set (stress can arrive after the packet was written).
      const fixed: Record<string, number> = {};
      for (const s of mine) {
        const legal = dialFor(s);
        const want = dials[s.id];
        fixed[s.id] = legal[want]?.allowed ? want : (legal.find(d => d.allowed)?.index ?? 0);
      }
      return { kind: 'command', command: { type: 'setDials', player, dials: fixed } };
    }
    return { kind: 'ask', stage: 'dials', player: P.players[0] };
  }

  const player = P.player;
  const packet = packets[player];
  const policy = packet?.policy ?? DEFAULT_POLICY;

  if (P.type === 'placeShip') return { kind: 'ask', stage: 'decision', player };

  const pick = (id: string | undefined): Answer | null => {
    if (id === undefined) return null;
    const i = P.options.findIndex(o => o.id === id);
    if (i < 0) return null;
    const o = P.options[i];
    // A reroll option needs dice chosen; let the assistant pick which, it is never the interesting part.
    if (o.pickDice) return null;
    return { kind: 'command', command: { type: 'choose', player, option: i } };
  };
  const assist = (): Answer => {
    const cmd = assistant(player, seed).decide(G);
    return cmd ? { kind: 'command', command: cmd } : { kind: 'ask', stage: stageOf(G).stage, player };
  };

  switch (P.kind) {
    case 'action': {
      const chosen = packet?.actions?.[P.shipId ?? ''];
      return pick(chosen) ?? (chosen === 'pass' ? pick('pass') : null) ?? { kind: 'ask', stage: 'actions', player };
    }
    case 'attack': {
      const chosen = packet?.attacks?.[P.shipId ?? ''];
      return pick(chosen) ?? (chosen === 'pass' ? pick('pass') : null) ?? { kind: 'ask', stage: 'attacks', player };
    }
    case 'modifyAttack':
    case 'modifyDefense':
      return policy.dice === 'assist' ? assist() : { kind: 'ask', stage: 'decision', player };
    case 'ability':
      return policy.abilities === 'assist' ? assist() : { kind: 'ask', stage: 'decision', player };
    // Ordering your own tied ships, Tallon placement, handing a focus to a wingmate: mechanical.
    case 'activateShip':
    case 'engageShip':
    case 'tallon':
    case 'chooseShip':
      return assist();
    default:
      return assist();
  }
}

export interface RunResult { state: GameState; events: any[]; waitingOn: PlayerId | null; stage: Stage }

/**
 * Drive the game as far as the submitted packets allow. Returns the new state and who is blocking.
 * `apply` is passed in so this module stays free of engine internals.
 */
export function runForward(
  G: GameState,
  packets: Partial<Record<PlayerId, TurnPacket>>,
  apply: (s: GameState, c: Command) => { state: GameState; events: any[] },
  seed = 1,
): RunResult {
  let state = G;
  const events: any[] = [];
  for (let guard = 0; guard < 5000; guard++) {
    if (state.phase === 'over') return { state, events, waitingOn: null, stage: 'decision' };
    const a = answer(state, packets, seed);
    if (a.kind === 'idle') return { state, events, waitingOn: null, stage: 'decision' };
    if (a.kind === 'ask') return { state, events, waitingOn: a.player, stage: a.stage };
    const res = apply(state, a.command);
    state = res.state;
    events.push(...res.events);
  }
  throw new Error('Correspondence run did not settle');
}
