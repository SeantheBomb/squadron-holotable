// Watching a finished match back. A ReplaySession looks like any other Session to the Game, so a
// replay gets the same presentation as the live match: movement, dice, damage, the log.
import { resimulate } from '@holotable/rules';
import type { Command, GameEvent, GameState, MatchRecord, PlayerId, ReplayStep } from '@holotable/rules';
import type { GameScene } from './scene';
import type { Listener, Session, Update } from './session';

export const REPLAY_RATES = [1, 2, 4] as const;

export class ReplaySession implements Session {
  readonly local: PlayerId[] = [];
  readonly replay = this;
  /** False when the current engine no longer reproduces the record; playback uses the recorded events. */
  readonly faithful: boolean;
  playing = true;
  rate: number = 1;
  perspective: PlayerId = 0;
  private steps: ReplayStep[];
  private next = 0;
  private timer = 0;
  private parked = false;
  private listeners: Listener[] = [];
  private changeFns: (() => void)[] = [];
  private snapFn: ((u: Update) => void) | null = null;

  constructor(readonly match: MatchRecord, private scene: GameScene) {
    const r = resimulate(match);
    this.faithful = r.faithful && r.steps.length > 1;
    this.steps = this.faithful ? r.steps : fallbackSteps(match, r.steps[0]?.state ?? null);
    queueMicrotask(() => this.emitNext());
  }

  get total() { return this.steps.length; }
  get position() { return this.next; }
  get finished() { return this.next >= this.steps.length; }

  /** The rounds a viewer can jump to, with the step each one starts at. */
  rounds(): { round: number; step: number }[] {
    if (!this.faithful) return [];
    const out: { round: number; step: number }[] = [];
    this.steps.forEach((s, i) => {
      for (const e of s.events) if (e.t === 'round') out.push({ round: e.round, step: i });
    });
    return out;
  }

  // ---------- Session ----------
  viewer() { return this.perspective; }
  send(_: Command) { /* nothing to decide in a replay */ }
  onUpdate(fn: Listener) { this.listeners.push(fn); }
  onError(_: (m: string) => void) { /* a replay has no transport to fail */ }
  idle() {
    this.changed();
    if (this.finished) return;
    if (!this.playing) { this.parked = true; return; }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitNext(), 120 / this.rate) as unknown as number;
  }
  dispose() {
    clearTimeout(this.timer);
    this.playing = false;
    this.scene.setPaused(false);
    this.scene.rate = 1;
  }

  // ---------- controls ----------
  onChange(fn: () => void) { this.changeFns.push(fn); }
  /** The Game registers how to drop what it is animating and show a state immediately. */
  onSnap(fn: (u: Update) => void) { this.snapFn = fn; }

  setPlaying(on: boolean) {
    this.playing = on;
    this.scene.setPaused(!on);
    if (on && this.parked) { this.parked = false; this.idle(); }
    this.changed();
  }
  setRate(r: number) { this.rate = r; this.scene.rate = r; this.changed(); }
  setPerspective(p: PlayerId) { this.perspective = p; this.changed(); }

  /** Jump to a step without animating what came before it. */
  seek(step: number) {
    clearTimeout(this.timer);
    const s = this.steps[Math.max(0, Math.min(step, this.steps.length - 1))];
    this.next = this.steps.indexOf(s) + 1;
    this.parked = false;
    this.scene.setPaused(false);
    this.snapFn?.({ view: s.state, events: [] });
    // Replay the step's own events so a round starts with its banner, then carry on.
    this.emit({ view: s.state, events: s.events.filter(e => e.t === 'round' || e.t === 'phase') });
    this.scene.setPaused(!this.playing);
    this.changed();
  }
  restart() { this.seek(0); }

  private emitNext() {
    if (this.finished) return;
    const s = this.steps[this.next++];
    this.emit({ view: s.state, events: s.events });
  }
  private emit(u: Update) { for (const fn of this.listeners) fn(u); }
  private changed() { for (const fn of this.changeFns) fn(); }
}

/**
 * The engine has changed since this match was played, so its commands would no longer play out the
 * same way. Show what actually happened instead: start from the setup and play every recorded event
 * against the recorded end state, which is where every ship's identity and loadout comes from.
 */
function fallbackSteps(r: MatchRecord, start: GameState | null): ReplayStep[] {
  const final = r.final;
  if (!final) return start ? [{ state: start, events: [] }] : [];
  const cast: GameState = structuredClone(final);
  for (const s of Object.values(cast.ships)) { s.removed = false; s.destroyed = false; s.placed = false; }
  // Nobody is on the table until the recorded deployment places them.
  const first: GameState = structuredClone(cast);
  first.phase = 'setup'; first.round = 0; first.pending = null; first.winner = null;
  first.players = first.players.map(p => ({ ...p, score: 0 })) as GameState['players'];
  const events: GameEvent[] = r.events;
  return [{ state: first, events: [] }, { state: final, events }];
}

/** Set by main, which owns the scene and screen, so any screen can start a replay. */
let opener: (r: MatchRecord) => void = () => {};
export const setReplayOpener = (fn: (r: MatchRecord) => void) => { opener = fn; };
export const openReplay = (r: MatchRecord) => opener(r);
