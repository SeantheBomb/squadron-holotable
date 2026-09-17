import { describe, expect, it } from 'vitest';
import { PRESET_SQUADS, applyCommand, createGame, activeShips, dialFor, liveShips, polysOverlap, shipPoly, PLAY_AREA, viewFor } from '../src';
import type { Command, GameState, PlayerId } from '../src';

function rng(seed: number) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }

export function randomCommand(G: GameState, r: () => number): Command {
  const P = G.pending!;
  if (P.type === 'placeShip') {
    const s = G.ships[P.shipId];
    for (;;) {
      const x = 40 + r() * (PLAY_AREA - 80);
      const pose = s.owner === 0 ? { x, y: 30 + r() * 40, r: Math.PI / 2 } : { x, y: PLAY_AREA - 30 - r() * 40, r: -Math.PI / 2 };
      try { applyCommand(G, { type: 'placeShip', player: P.player, shipId: s.id, pose }); return { type: 'placeShip', player: P.player, shipId: s.id, pose }; } catch { /* retry */ }
    }
  }
  if (P.type === 'planning') {
    const player = P.players[0];
    const dials: Record<string, number> = {};
    for (const s of activeShips(G).filter(s => s.owner === player)) { const ok = dialFor(s).filter(d => d.allowed); dials[s.id] = ok[Math.floor(r() * ok.length)].index; }
    return { type: 'setDials', player, dials };
  }
  const i = Math.floor(r() * P.options.length);
  const o = P.options[i];
  const dice = o.pickDice ? Array.from({ length: o.pickDice.max }, (_, k) => k) : undefined;
  return { type: 'choose', player: P.player as PlayerId, option: i, dice };
}

describe('engine fuzz', () => {
  it('plays random games to completion without breaking invariants', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const a = PRESET_SQUADS[seed % PRESET_SQUADS.length], b = PRESET_SQUADS[(seed * 7 + 1) % PRESET_SQUADS.length];
      let { state: G } = createGame([a, b], ['A', 'B'], seed);
      let steps = 0;
      while (G.phase !== 'over') {
        expect(G.pending).toBeTruthy();
        G = applyCommand(G, randomCommand(G, r)).state;
        if (G.phase === 'planning') {
          const ships = liveShips(G);
          for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++)
            expect(polysOverlap(shipPoly(ships[i]), shipPoly(ships[j]), 0.01), `overlap seed ${seed}`).toBe(false);
          for (const s of ships) for (const t of Object.values(s.tokens)) expect(t).toBeGreaterThanOrEqual(0);
        }
        expect(++steps).toBeLessThan(20000);
      }
      expect(G.winner).not.toBeNull();
      expect(JSON.stringify(viewFor(G, 0))).toBeTruthy();
    }
  });
});
