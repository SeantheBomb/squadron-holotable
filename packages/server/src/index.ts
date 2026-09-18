// Authoritative multiplayer: one Durable Object per match runs the rules engine, rolls the dice and
// holds hidden dials. Clients only ever receive redacted views.
import { DurableObject } from 'cloudflare:workers';
import { applyCommand, createGame, validateSquad, viewFor } from '@holotable/rules';
import type { Command, GameEvent, GameState, PlayerId, Squad } from '@holotable/rules';

interface Env { MATCH: DurableObjectNamespace<Match> }
interface Seat { token: string; name: string; squad: Squad | null; ready: boolean }
interface Stored { seats: Seat[]; game: GameState | null }

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (url.pathname === '/api/rooms' && req.method === 'POST') {
      const bytes = crypto.getRandomValues(new Uint8Array(5));
      const code = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
      return json({ code });
    }
    const m = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{5})\/ws$/);
    if (m) return env.MATCH.get(env.MATCH.idFromName(m[1])).fetch(req);
    return json({ ok: true, service: 'holotable-server' });
  },
};

export class Match extends DurableObject<Env> {
  private data: Stored | null = null;

  private async load(): Promise<Stored> {
    return (this.data ??= (await this.ctx.storage.get<Stored>('match')) ?? { seats: [], game: null });
  }
  private async save() { await this.ctx.storage.put('match', this.data); }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private seatOf(ws: WebSocket): number { return (ws.deserializeAttachment() as { seat: number } | null)?.seat ?? -1; }

  private push(events: GameEvent[]) {
    const d = this.data!;
    const seats = d.seats.map(s => ({ name: s.name, squad: s.squad?.name ?? null, faction: s.squad?.faction ?? null, ready: s.ready }));
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.seatOf(ws);
      if (seat < 0) continue;
      ws.send(JSON.stringify({
        type: 'state', you: seat, events, seats, started: !!d.game,
        view: d.game ? viewFor(d.game, seat as PlayerId) : null,
      }));
    }
  }

  /** Both seats filled, both with a legal squad, both ready. */
  private tryStart(): GameEvent[] {
    const d = this.data!;
    if (d.game || d.seats.length < 2) return [];
    if (!d.seats.every(s => s.squad && s.ready && !validateSquad(s.squad).length)) return [];
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    const g = createGame([d.seats[0].squad!, d.seats[1].squad!], [d.seats[0].name, d.seats[1].name], seed);
    d.game = g.state;
    return g.events;
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const d = await this.load();
    let msg: any;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const fail = (error: string) => ws.send(JSON.stringify({ type: 'error', error }));

    if (msg.type === 'join') {
      const token = String(msg.token ?? '');
      if (token.length < 8) return fail('Bad token.');
      let seat = d.seats.findIndex(s => s.token === token);
      if (seat < 0) {
        if (d.seats.length >= 2) return fail('Room is full.');
        if (d.game) return fail('That match has already started.');
        d.seats.push({ token, name: String(msg.name ?? 'Pilot').slice(0, 24), squad: null, ready: false });
        seat = d.seats.length - 1;
      } else if (msg.name) d.seats[seat].name = String(msg.name).slice(0, 24);
      ws.serializeAttachment({ seat });
      // A squad sent with the join is only an opening suggestion; the lobby is where it is confirmed.
      const squad = msg.squad as Squad | undefined;
      if (!d.game && squad && Array.isArray(squad.ships) && !validateSquad(squad).length) d.seats[seat].squad = squad;
      await this.save();
      return this.push([]);
    }

    if (msg.type === 'setSquad') {
      const seat = this.seatOf(ws);
      if (seat < 0) return fail('Not seated.');
      if (d.game) return fail('The match has already started.');
      const squad = msg.squad as Squad;
      const errs = squad && Array.isArray(squad.ships) ? validateSquad(squad) : ['Missing squad.'];
      if (errs.length) return fail(errs.join(' '));
      d.seats[seat].squad = squad;
      d.seats[seat].ready = false; // changing your list drops your ready
      await this.save();
      return this.push([]);
    }

    if (msg.type === 'ready') {
      const seat = this.seatOf(ws);
      if (seat < 0) return fail('Not seated.');
      if (d.game) return this.push([]);
      if (!d.seats[seat].squad) return fail('Choose a squadron first.');
      d.seats[seat].ready = !!msg.ready;
      const events = this.tryStart();
      await this.save();
      return this.push(events);
    }

    if (msg.type === 'resync') {
      const seat = this.seatOf(ws);
      if (seat < 0) return fail('Not seated.');
      return this.push([]); // re-broadcast current state; no events to replay
    }

    if (msg.type === 'cmd') {
      const seat = this.seatOf(ws);
      if (seat < 0 || !d.game) return fail('Not seated.');
      const cmd = msg.command as Command;
      if (!cmd || cmd.player !== seat) return fail('Not your command.');
      try {
        const res = applyCommand(d.game, cmd);
        d.game = res.state;
        await this.save();
        this.push(res.events);
      } catch (e: any) { fail(e?.message ?? 'Invalid command.'); }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) { try { ws.close(code, 'bye'); } catch { /* already closed */ } }
}
