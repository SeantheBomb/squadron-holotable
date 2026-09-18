// Authoritative multiplayer: one Durable Object per match runs the rules engine, rolls the dice and
// holds hidden dials. Clients only ever receive redacted views.
import { DurableObject } from 'cloudflare:workers';
import { applyCommand, createGame, validateSquad, viewFor } from '@holotable/rules';
import { runForward } from '@holotable/bot';
import type { TurnPacket } from '@holotable/bot';
import type { Command, GameEvent, GameState, PlayerId, Squad } from '@holotable/rules';
import { deleteAccount, login, logout, register, setEmail, userFor } from './auth';
import { claimSeat, createMatch, getMatch, listMatches, syncMatch } from './matches';

interface Env { MATCH: DurableObjectNamespace<Match>; holotable: D1Database }
interface Seat { token: string; name: string; squad: Squad | null; ready: boolean; user?: { id: string; username: string } | null; seen?: number }
interface StoredPacket { round: number; stage: string; packet: TurnPacket }
interface Stored { seats: Seat[]; game: GameState | null; code?: string; mode?: 'live' | 'correspondence'; log?: GameEvent[]; seed?: number; packets?: Record<string, StoredPacket> }

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Which stage the game is waiting on, and whose input it needs. Mirrors the packet layer. */
function stageFor(G: GameState): { stage: 'deploy' | 'dials' | 'actions' | 'attacks' | 'decision'; player: PlayerId | null } {
  const P = G.pending;
  if (!P) return { stage: 'decision', player: null };
  if (P.type === 'planning') return { stage: 'dials', player: P.players[0] ?? null };
  if (P.type === 'placeShip') return { stage: 'deploy', player: P.player };
  if (P.kind === 'action') return { stage: 'actions', player: P.player };
  if (P.kind === 'attack') return { stage: 'attacks', player: P.player };
  return { stage: 'decision', player: P.player };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // ---------- accounts ----------
      if (path === '/api/account/register' && req.method === 'POST') {
        const b = await req.json<any>();
        const out = await register(env, String(b.username ?? '').trim(), String(b.key ?? ''), b.email ? String(b.email).trim() : null);
        return 'error' in out ? json({ error: out.error }, 400) : json(out);
      }
      if (path === '/api/account/login' && req.method === 'POST') {
        const b = await req.json<any>();
        const out = await login(env, String(b.username ?? ''), String(b.key ?? ''));
        return 'error' in out ? json({ error: out.error }, 401) : json(out);
      }
      if (path === '/api/account/logout' && req.method === 'POST') { await logout(env, req); return json({ ok: true }); }
      if (path === '/api/account/me') {
        const user = await userFor(env, req);
        return user ? json({ user }) : json({ user: null }, 200);
      }
      if (path === '/api/account/email' && req.method === 'POST') {
        const user = await userFor(env, req);
        if (!user) return json({ error: 'Sign in first.' }, 401);
        const b = await req.json<any>();
        const err = await setEmail(env, user.id, b.email ? String(b.email).trim() : null);
        return err ? json({ error: err }, 400) : json({ ok: true });
      }
      if (path === '/api/account/delete' && req.method === 'POST') {
        const user = await userFor(env, req);
        if (!user) return json({ error: 'Sign in first.' }, 401);
        await deleteAccount(env, user.id);
        return json({ ok: true });
      }

      // ---------- matches ----------
      if (path === '/api/matches') {
        const user = await userFor(env, req);
        if (!user) return json({ error: 'Sign in first.' }, 401);
        return json({ matches: await listMatches(env, user.id) });
      }
      if (path === '/api/rooms' && req.method === 'POST') {
        const user = await userFor(env, req);
        const body = await req.json<any>().catch(() => ({}));
        const mode = body?.mode === 'correspondence' ? 'correspondence' : 'live';
        if (mode === 'correspondence' && !user) return json({ error: 'Correspondence matches need an account.' }, 401);
        const bytes = crypto.getRandomValues(new Uint8Array(5));
        const code = [...bytes].map(b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
        await createMatch(env, code, mode, user);
        return json({ code, mode });
      }

      const turn = path.match(/^\/api\/rooms\/([A-Z0-9]{5})\/turn$/);
      if (turn) {
        const user = await userFor(env, req);
        if (!user) return json({ error: 'Sign in first.' }, 401);
        const head = new Headers(req.headers);
        head.set('X-User', JSON.stringify(user));
        head.set('X-Mode', (await getMatch(env, turn[1]))?.mode ?? 'correspondence');
        return env.MATCH.get(env.MATCH.idFromName(turn[1])).fetch(
          new Request(`https://do/turn/${turn[1]}`, { method: req.method, headers: head, body: req.method === 'POST' ? await req.text() : undefined }),
        );
      }

      const m = path.match(/^\/api\/rooms\/([A-Z0-9]{5})\/ws$/);
      if (m) {
        // The socket carries no headers we control, so identity is passed as a query parameter and
        // resolved here, before the Durable Object ever sees it.
        const user = await userFor(env, new Request(req.url, { headers: { Authorization: `Bearer ${url.searchParams.get('t') ?? ''}` } }));
        const room = await getMatch(env, m[1]);
        const head = new Headers(req.headers);
        head.set('X-User', user ? JSON.stringify(user) : '');
        head.set('X-Mode', room?.mode ?? 'live');
        return env.MATCH.get(env.MATCH.idFromName(m[1])).fetch(new Request(req.url, { method: req.method, headers: head, body: req.body }));
      }
      return json({ ok: true, service: 'holotable-server' });
    } catch (e: any) {
      return json({ error: e?.message ?? 'Server error.' }, 500);
    }
  },
};

export class Match extends DurableObject<Env> {
  private data: Stored | null = null;

  private async load(): Promise<Stored> {
    return (this.data ??= (await this.ctx.storage.get<Stored>('match')) ?? { seats: [], game: null });
  }
  private async save() { await this.ctx.storage.put('match', this.data); }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/turn/')) return this.turn(req, url.pathname.split('/')[2] ?? '');
    if (req.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 426);
    const d = await this.load();
    d.code ??= new URL(req.url).pathname.split('/')[3] ?? '';
    d.mode ??= (req.headers.get('X-Mode') as 'live' | 'correspondence') ?? 'live';
    const raw = req.headers.get('X-User');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (raw) pair[1].serializeAttachment({ seat: -1, user: JSON.parse(raw) });
    await this.save();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }


  /** Correspondence play: no socket, no waiting. Fetch your turn, submit it, close the tab. */
  private async turn(req: Request, code: string): Promise<Response> {
    const d = await this.load();
    d.code ??= code;
    d.mode ??= (req.headers.get('X-Mode') as any) ?? 'correspondence';
    d.seed ??= Math.floor(Math.random() * 1e9);
    const user = JSON.parse(req.headers.get('X-User') || 'null') as { id: string; username: string } | null;
    if (!user) return json({ error: 'Sign in first.' }, 401);

    let seat = d.seats.findIndex(s => s.user?.id === user.id);
    // Opening the room is joining it: take a free seat straight away so both sides see each other.
    if (seat < 0 && !d.game && d.seats.length < 2) {
      d.seats.push({ token: `acct:${user.id}`, name: user.username, squad: null, ready: false, user, seen: 0 });
      seat = d.seats.length - 1;
      await claimSeat(this.env, code, seat as 0 | 1, user as any);
      await this.save();
      await this.index();
    }

    if (req.method === 'POST') {
      const body = await req.json<any>().catch(() => ({}));
      if (seat < 0) return json({ error: d.game ? 'That match has already started.' : 'That match is full.' }, 403);
      const me = d.seats[seat];

      if (body.squad !== undefined && !d.game) {
        const errs = validateSquad(body.squad);
        if (errs.length) return json({ error: errs.join(' ') }, 400);
        me.squad = body.squad; me.ready = false;
      }
      if (body.ready !== undefined && !d.game) {
        if (!me.squad) return json({ error: 'Choose a squadron first.' }, 400);
        me.ready = !!body.ready;
        const ev = this.tryStart();
        if (ev.length) { d.log = ev; for (const s of d.seats) s.seen = 0; }
      }

      // ---- a turn packet
      if (body.packet && d.game) {
        const before = stageFor(d.game);
        if (before.player !== null && before.player !== seat) return json({ error: 'It is not your turn.' }, 409);
        // A packet stays live until its stage is done. Prompts alternate between players inside a
        // stage (deployment and engagement both do), and nobody should be asked twice for one sitting.
        d.packets ??= {};
        d.packets[String(seat)] = { round: d.game.round, stage: before.stage, packet: { ...(body.packet as TurnPacket), player: seat as PlayerId, stage: before.stage } };
        const res = runForward(d.game, this.livePackets(), (st, c) => applyCommand(st, c), d.seed);
        d.game = res.state;
        // Do NOT mark these seen: the results of your own turn — your movement, the exchange of
        // fire, who died — are exactly what you want to read when you next open the match.
        d.log = [...(d.log ?? []), ...res.events].slice(-600);
      }
      await this.save();
      await this.index();
      return json(this.turnView(seat, user));
    }

    // A plain read is the player catching up, so everything shown is now seen.
    const payload = this.turnView(seat, user);
    if (seat >= 0) d.seats[seat].seen = (d.log ?? []).length;
    await this.save();
    return json(payload);
  }

  /**
   * Stored packets that still apply. Scoped by round so last round's dials or attack declarations can
   * never be replayed against this one.
   */
  private livePackets(): Record<number, TurnPacket> {
    const d = this.data!;
    const out: Record<number, TurnPacket> = {};
    for (const [seat, entry] of Object.entries(d.packets ?? {})) {
      if (d.game && entry.round === d.game.round) out[Number(seat)] = entry.packet;
    }
    return out;
  }

  /** Everything a correspondence client needs in one payload. */
  private turnView(seat: number, user: { id: string; username: string }) {
    const d = this.data!;
    const G = d.game;
    const view = G && seat >= 0 ? viewFor(G, seat as PlayerId) : null;
    const st = G ? stageFor(G) : { stage: 'deploy' as const, player: null };
    const seen = seat >= 0 ? (d.seats[seat].seen ?? 0) : (d.log?.length ?? 0);
    return {
      you: seat, mode: d.mode ?? 'correspondence', started: !!G,
      seats: d.seats.map(s => ({ name: s.name, squad: s.squad?.name ?? null, faction: s.squad?.faction ?? null, ready: s.ready, account: !!s.user })),
      view,
      stage: st.stage,
      waitingOn: st.player,
      yourTurn: seat >= 0 && st.player === seat,
      since: (d.log ?? []).slice(seen),
      user,
    };
  }

  private attach(ws: WebSocket): { seat: number; user?: { id: string; username: string } } {
    return (ws.deserializeAttachment() as any) ?? { seat: -1 };
  }

  /** Mirror the parts of the game the match list needs. */
  private async index() {
    const d = this.data!;
    if (!d.code) return;
    const G = d.game;
    const turn = G?.pending
      ? (G.pending.type === 'planning' ? null : (G.pending as any).player as PlayerId)
      : null;
    const seatUser = (i: number) => d.seats[i]?.user?.id ?? null;
    await syncMatch(this.env, d.code, {
      status: G ? (G.phase === 'over' ? 'over' : 'active') : 'lobby',
      round: G?.round ?? 0,
      winner: G && G.winner !== null ? String(G.winner) : null,
      turn_user: turn === null ? null : seatUser(turn),
      p0_name: d.seats[0]?.name ?? null,
      p1_name: d.seats[1]?.name ?? null,
    } as any);
  }

  private seatOf(ws: WebSocket): number { return this.attach(ws).seat; }

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
    const g = createGame([d.seats[0].squad!, d.seats[1].squad!], [d.seats[0].name, d.seats[1].name], seed, d.mode === 'correspondence' ? { variant: 'correspondence' } : {});
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
        const who = this.attach(ws).user ?? null;
        d.seats.push({ token, name: who?.username ?? String(msg.name ?? 'Pilot').slice(0, 24), squad: null, ready: false, user: who });
        seat = d.seats.length - 1;
        if (who && d.code) await claimSeat(this.env, d.code, seat as 0 | 1, who as any);
      } else if (msg.name) d.seats[seat].name = String(msg.name).slice(0, 24);
      ws.serializeAttachment({ seat, user: this.attach(ws).user ?? d.seats[seat].user ?? null });
      // A squad sent with the join is only an opening suggestion; the lobby is where it is confirmed.
      const squad = msg.squad as Squad | undefined;
      if (!d.game && squad && Array.isArray(squad.ships) && !validateSquad(squad).length) d.seats[seat].squad = squad;
      await this.save();
      await this.index();
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
      await this.index();
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
        await this.index();
        this.push(res.events);
      } catch (e: any) { fail(e?.message ?? 'Invalid command.'); }
    }
  }

  async webSocketClose(ws: WebSocket, code: number) { try { ws.close(code, 'bye'); } catch { /* already closed */ } }
}
