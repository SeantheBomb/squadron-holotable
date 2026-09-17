// A Session hides where the rules run: locally (hotseat / vs bot) or on the match server.
import { applyCommand, createGame, viewFor } from '@holotable/rules';
import type { Command, GameEvent, GameState, PlayerId, Squad } from '@holotable/rules';
import type { BotOptions } from '@holotable/bot';

export interface Update { view: GameState; events: GameEvent[] }
export type Listener = (u: Update) => void;

export interface Session {
  /** players controlled from this screen */
  readonly local: PlayerId[];
  /** whose hidden information the current view shows */
  viewer(): PlayerId;
  send(cmd: Command): void;
  onUpdate(fn: Listener): void;
  onError(fn: (msg: string) => void): void;
  dispose(): void;
}

export class LocalSession implements Session {
  readonly local: PlayerId[];
  private G: GameState;
  private listeners: Listener[] = [];
  private errors: ((m: string) => void)[] = [];
  private worker: Worker | null = null;
  private seat: PlayerId = 0;
  private botBusy = false;

  constructor(squads: [Squad, Squad], names: [string, string], bot: BotOptions | null) {
    this.local = bot ? [0] : [0, 1];
    const g = createGame(squads, names, (Math.random() * 2 ** 31) | 0);
    this.G = g.state;
    if (bot) {
      this.worker = new Worker(new URL('./botWorker.ts', import.meta.url), { type: 'module' });
      this.worker.postMessage({ type: 'init', player: 1, options: bot });
      this.worker.onmessage = e => { this.botBusy = false; if (e.data.command) this.apply(e.data.command); };
    }
    queueMicrotask(() => { this.emit(g.events); this.pokeBot(); });
  }

  viewer(): PlayerId {
    if (this.local.length === 1) return this.local[0];
    const P = this.G.pending;
    if (P?.type === 'planning') return P.players[0];
    if (P) return P.player;
    return this.seat;
  }

  private emit(events: GameEvent[]) {
    this.seat = this.viewer();
    const u = { view: viewFor(this.G, this.seat), events };
    for (const fn of this.listeners) fn(u);
  }

  private apply(cmd: Command) {
    try {
      const res = applyCommand(this.G, cmd);
      this.G = res.state;
      this.emit(res.events);
    } catch (e: any) { for (const fn of this.errors) fn(e?.message ?? String(e)); }
    this.pokeBot();
  }

  private pokeBot() {
    if (!this.worker || this.botBusy || this.G.phase === 'over') return;
    const P = this.G.pending;
    if (!P) return;
    const botsTurn = P.type === 'planning' ? P.players.includes(1) : P.player === 1;
    if (!botsTurn) return;
    this.botBusy = true;
    this.worker.postMessage({ type: 'decide', view: viewFor(this.G, 1) });
  }

  send(cmd: Command) { this.apply(cmd); }
  onUpdate(fn: Listener) { this.listeners.push(fn); }
  onError(fn: (m: string) => void) { this.errors.push(fn); }
  dispose() { this.worker?.terminate(); }
}

export class RemoteSession implements Session {
  local: PlayerId[] = [];
  private ws: WebSocket;
  private listeners: Listener[] = [];
  private errors: ((m: string) => void)[] = [];
  private you: PlayerId = 0;
  onSeats: (names: string[]) => void = () => {};

  constructor(serverUrl: string, readonly code: string, name: string, squad: Squad) {
    const tokenKey = `holotable-token-${code}`;
    let token = sessionStorage.getItem(tokenKey);
    if (!token) { token = crypto.randomUUID(); sessionStorage.setItem(tokenKey, token); }
    this.ws = new WebSocket(`${serverUrl.replace(/^http/, 'ws')}/api/rooms/${code}/ws`);
    this.ws.onopen = () => this.ws.send(JSON.stringify({ type: 'join', token, name, squad }));
    this.ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'error') return this.errors.forEach(fn => fn(msg.error));
      if (msg.type === 'state') {
        this.you = msg.you; this.local = [msg.you];
        this.onSeats(msg.seats);
        if (msg.view) this.listeners.forEach(fn => fn({ view: msg.view, events: msg.events ?? [] }));
      }
    };
    this.ws.onclose = () => this.errors.forEach(fn => fn('Disconnected from match server.'));
  }

  viewer() { return this.you; }
  send(cmd: Command) { this.ws.send(JSON.stringify({ type: 'cmd', command: cmd })); }
  onUpdate(fn: Listener) { this.listeners.push(fn); }
  onError(fn: (m: string) => void) { this.errors.push(fn); }
  dispose() { this.ws.onclose = null; this.ws.close(); }
}
