// Headless tournament harness: `npm run sim -- [games] [a] [b]` where a/b ∈ rookie|veteran|ace|random.
import { PRESET_SQUADS, applyCommand, createGame, viewFor } from '@holotable/rules';
import type { GameState, PlayerId } from '@holotable/rules';
import { Bot, Difficulty } from './bot';
import { randomCommand } from './random';

declare const process: { argv: string[] };
const games = Number(process.argv[2] ?? 40);
const kinds = [process.argv[3] ?? 'veteran', process.argv[4] ?? 'random'];
let seed = 99;
const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

const wins = [0, 0, 0]; let rounds = 0, fled = 0, t0 = Date.now();
for (let g = 0; g < games; g++) {
  const a = PRESET_SQUADS[g % 4], b = PRESET_SQUADS[(g + 1 + (g >> 2)) % 4];
  const swap = g % 2 === 1; // alternate sides so squads don't bias the result
  const who = swap ? [kinds[1], kinds[0]] : kinds;
  let G: GameState = createGame([a, b], ['A', 'B'], 1000 + g).state;
  const bots = who.map((k, i) => (k === 'random' ? null : new Bot(i as PlayerId, { difficulty: k as Difficulty, seed: g * 2 + i, personality: (['jouster', 'flanker', 'guardian'] as const)[g % 3] })));
  let steps = 0;
  while (G.phase !== 'over') {
    let cmd = null;
    for (const p of [0, 1] as PlayerId[]) { cmd = bots[p] ? bots[p]!.decide(viewFor(G, p)) : randomCommand(G, r, p); if (cmd) break; }
    if (!cmd) throw new Error('nobody can act: ' + JSON.stringify(G.pending));
    G = applyCommand(G, cmd).state;
    if (++steps > 50000) throw new Error('runaway game');
  }
  rounds += G.round; fled += Object.values(G.ships).filter(s => s.fled).length;
  const w = G.winner === 'draw' ? 2 : swap ? 1 - (G.winner as number) : (G.winner as number);
  wins[w]++;
}
console.log(`${kinds[0]} vs ${kinds[1]} over ${games} games: ${wins[0]}–${wins[1]} (${wins[2]} draws), avg ${(rounds / games).toFixed(1)} rounds, ${fled} ships fled, ${((Date.now() - t0) / games).toFixed(0)} ms/game`);
