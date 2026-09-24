// Match records: everything needed to watch a finished match back.
//
// The engine is deterministic, so the starting setup plus every command reproduces the match
// exactly. The events are stored too: they are the ground truth if a later rules change makes the
// commands play out differently, and they let a viewer check that before trusting the re-run.
import { applyCommand, createGame } from './engine';
import type { Command, GameEvent, GameOptions, GameState, PlayerId, Squad } from './types';

export interface MatchRecord {
  v: 1;
  squads: [Squad, Squad];
  names: [string, string];
  seed: number;
  options: Partial<GameOptions>;
  commands: Command[];
  /** Every event in order, starting with the ones createGame emitted. */
  events: GameEvent[];
  mode?: 'local' | 'live' | 'correspondence';
  startedAt?: number;
  finishedAt?: number;
  winner?: PlayerId | 'draw' | null;
  scores?: [number, number];
  /** The end state, so a record can still be shown if its commands no longer re-run faithfully. */
  final?: GameState;
}

export function newRecord(squads: [Squad, Squad], names: [string, string], seed: number, options: Partial<GameOptions>, events: GameEvent[]): MatchRecord {
  return { v: 1, squads, names, seed, options, commands: [], events: [...events], startedAt: Date.now() };
}

/** Note an applied command and what it produced. */
export function recordStep(r: MatchRecord, command: Command, events: GameEvent[], after: GameState) {
  r.commands.push(command);
  r.events.push(...events);
  if (after.phase === 'over') {
    r.finishedAt ??= Date.now();
    r.winner = after.winner ?? null;
    r.scores = [after.players[0].score, after.players[1].score];
    r.final = after;
  }
}

export interface ReplayStep { state: GameState; events: GameEvent[] }

/**
 * Re-run a record through the current engine. `faithful` is false when the re-run no longer matches
 * what was recorded (a rules change since the match was played); the viewer should then fall back to
 * the recorded events.
 */
export function resimulate(r: MatchRecord): { steps: ReplayStep[]; faithful: boolean } {
  const steps: ReplayStep[] = [];
  let faithful = true;
  try {
    const g = createGame(r.squads, r.names, r.seed, r.options);
    steps.push({ state: g.state, events: g.events });
    let G = g.state;
    for (const c of r.commands) {
      const res = applyCommand(G, c);
      G = res.state;
      steps.push({ state: G, events: res.events });
    }
    const replayed = steps.flatMap(s => s.events);
    faithful = replayed.length === r.events.length && replayed.every((e, i) => substance(e) === substance(r.events[i]));
  } catch {
    faithful = false;
  }
  return { steps, faithful };
}

/**
 * Display text depends on which presentation pack is loaded (the server has none, a browser may),
 * so it is left out when checking that a re-run matches what happened.
 */
const TEXT_KEYS = new Set(['label', 'weaponName', 'name', 'text', 'cause', 'prompt']);
function substance(e: GameEvent): string {
  return JSON.stringify(e, (k, v) => (TEXT_KEYS.has(k) ? undefined : v));
}
