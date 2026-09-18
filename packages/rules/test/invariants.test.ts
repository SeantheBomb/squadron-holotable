import { describe, expect, it } from 'vitest';
import { PRESET_SQUADS, activeShips, applyCommand, createGame, dialFor, liveShips } from '../src';
import type { Command, GameState, PlayerId } from '../src';
import { Bot, randomCommand } from '../../bot/src';

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

/** The softlock class of bug: a decision the player cannot answer, or a state nobody can act on. */
describe('no unanswerable states', () => {
  it('every pending decision always offers at least one option', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const r = rng(seed);
      const a = PRESET_SQUADS[seed % PRESET_SQUADS.length], b = PRESET_SQUADS[(seed * 5 + 2) % PRESET_SQUADS.length];
      let G = createGame([a, b], ['A', 'B'], seed).state;
      let steps = 0;
      while (G.phase !== 'over') {
        const P = G.pending;
        expect(P, `seed ${seed}: state with no pending decision and no winner`).toBeTruthy();
        if (P!.type === 'choice') {
          expect(P!.options.length, `seed ${seed}: empty options for ${P!.kind}`).toBeGreaterThan(0);
          // Every option must be answerable: a dice-picking option needs pickable dice.
          for (const o of P!.options) {
            if (!o.pickDice) continue;
            const A = G.attack!;
            const pool = P!.kind === 'modifyAttack' ? A.attackRerolled : A.defenseRerolled;
            expect(pool.some(done => !done), `seed ${seed}: "${o.label}" offers a reroll with no rerollable die`).toBe(true);
          }
        }
        if (P!.type === 'planning') for (const s of activeShips(G).filter(s => P!.players.includes(s.owner))) {
          expect(dialFor(s).some(d => d.allowed), `seed ${seed}: ${s.id} has no legal maneuver`).toBe(true);
        }
        G = applyCommand(G, randomCommand(G, r)!).state;
        expect(++steps, `seed ${seed}: runaway game`).toBeLessThan(20000);
      }
      expect(G.winner).not.toBeNull();
    }
  });

  it('bot-driven games always terminate and never stall', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const bots = [0, 1].map(i => new Bot(i as PlayerId, { difficulty: 'ace', seed: seed * 7 + i }));
      let G: GameState = createGame([PRESET_SQUADS[seed % 4], PRESET_SQUADS[(seed + 1) % 4]], ['A', 'B'], seed).state;
      let steps = 0;
      while (G.phase !== 'over') {
        let cmd: Command | null = null;
        for (const p of [0, 1] as PlayerId[]) { cmd = bots[p].decide(G); if (cmd) break; }
        expect(cmd, `seed ${seed}: nobody can act on ${JSON.stringify(G.pending?.type)}`).toBeTruthy();
        G = applyCommand(G, cmd!).state;
        expect(++steps).toBeLessThan(20000);
      }
      expect(liveShips(G).length).toBeGreaterThanOrEqual(0);
    }
  });
});
