// End-to-end check against a running `wrangler dev`: two sockets play a full random game.
import { PRESET_SQUADS } from '@holotable/rules';
import type { GameState, PlayerId } from '@holotable/rules';
import { randomCommand } from '@holotable/bot';

declare const process: { exit(code: number): void };
const base = 'http://localhost:8787';
let seed = 7; const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const { code } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json() as { code: string };
console.log('room', code);
let done = false, msgs = 0, leaks = 0;

function client(i: number) {
  const ws = new WebSocket(`ws://localhost:8787/api/rooms/${code}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'join', token: `token-${i}-abcdefgh`, name: `P${i}`, squad: PRESET_SQUADS[i] }));
  let readied = false;
  ws.onmessage = e => {
    const m = JSON.parse(e.data as string); msgs++;
    if (m.type === 'error') { console.log('server error:', m.error); return; }
    const G: GameState | null = m.view;
    if (!G) { if (!readied && m.seats?.[i]?.squad) { readied = true; ws.send(JSON.stringify({ type: 'ready', ready: true })); } return; }
    const me = m.you as PlayerId;
    for (const s of Object.values(G.ships)) if (s.owner !== me && !s.dialRevealed && s.dial >= 0) leaks++;
    if (G.rng !== 0 || G.deck.length) leaks++;
    if (G.phase === 'over') { if (!done) { done = true; console.log(`game over: winner=${G.winner} rounds=${G.round} messages=${msgs} leaks=${leaks}`); setTimeout(() => process.exit(leaks ? 1 : 0), 200); } return; }
    const cmd = randomCommand(G, r, me);
    if (cmd) ws.send(JSON.stringify({ type: 'cmd', command: cmd }));
  };
}
client(0); setTimeout(() => client(1), 300);
setTimeout(() => { console.log('timeout'); process.exit(2); }, 60000);
