import { PLAY_AREA, activeShips, applyCommand, dialFor } from '@holotable/rules';
import type { Command, GameState, PlayerId } from '@holotable/rules';

/** Uniformly random legal play — the baseline opponent for regression sims. */
export function randomCommand(G: GameState, r: () => number, player?: PlayerId): Command | null {
  const P = G.pending;
  if (!P) return null;
  if (P.type === 'placeShip') {
    if (player !== undefined && P.player !== player) return null;
    const s = G.ships[P.shipId];
    for (;;) {
      const x = 40 + r() * (PLAY_AREA - 80);
      const pose = s.owner === 0 ? { x, y: 30 + r() * 40, r: Math.PI / 2 } : { x, y: PLAY_AREA - 30 - r() * 40, r: -Math.PI / 2 };
      const cmd: Command = { type: 'placeShip', player: P.player, shipId: s.id, pose };
      try { applyCommand(G, cmd); return cmd; } catch { /* retry */ }
    }
  }
  if (P.type === 'planning') {
    const who = player ?? P.players[0];
    if (!P.players.includes(who)) return null;
    const dials: Record<string, number> = {};
    for (const s of activeShips(G).filter(s => s.owner === who)) { const ok = dialFor(s).filter(d => d.allowed); dials[s.id] = ok[Math.floor(r() * ok.length)].index; }
    return { type: 'setDials', player: who, dials };
  }
  if (player !== undefined && P.player !== player) return null;
  const i = Math.floor(r() * P.options.length);
  const o = P.options[i];
  return { type: 'choose', player: P.player, option: i, dice: o.pickDice ? Array.from({ length: o.pickDice.max }, (_, k) => k) : undefined };
}
