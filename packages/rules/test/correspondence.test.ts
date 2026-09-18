import { describe, expect, it } from 'vitest';
import { PRESET_SQUADS, activeShips, applyCommand, createGame, liveShips } from '../src';
import type { GameState, PlayerId } from '../src';
import { Bot, DEFAULT_POLICY, answer, stageOf } from '../../bot/src';
import type { TurnPacket } from '../../bot/src';

/**
 * A correspondence "submission" is one sitting: the player is asked for a stage, and answers every
 * prompt of that stage for all of their ships before handing back. This measures how many times each
 * player must come back per round — the number that decides whether the mode is playable.
 */
function play(variant: 'standard' | 'correspondence', seed: number) {
  const bots = [0, 1].map(i => new Bot(i as PlayerId, { difficulty: 'ace', seed: seed * 31 + i }));
  let G: GameState = createGame(
    [PRESET_SQUADS[seed % 4], PRESET_SQUADS[(seed + 1) % 4]], ['A', 'B'], 900 + seed, { variant },
  ).state;

  const submissions: Record<string, true> = {};   // `${round}:${player}:${stage}` seen
  const perRound: Record<number, [number, number]> = {};
  const naivePerRound: Record<number, [number, number]> = {};
  let steps = 0, worstPhaseSwitches = 0, phaseSwitches = 0, lastActionPlayer: PlayerId | null = null, inActionPhase = false;

  while (G.phase !== 'over') {
    const { stage, player } = stageOf(G);
    const round = Math.max(1, G.round);
    // Naive baseline: every single prompt a player faces, the way a per-decision async port would.
    if (player !== null) { naivePerRound[round] ??= [0, 0]; naivePerRound[round][player]++; }
    const nowActions = G.stack.some(fr => fr.type === 'actionPhase');
    if (nowActions && stage === 'actions' && player !== null) {
      if (!inActionPhase) { inActionPhase = true; phaseSwitches = 0; lastActionPlayer = player; }
      else if (lastActionPlayer !== player) { phaseSwitches++; lastActionPlayer = player; }
    } else if (!nowActions && inActionPhase) {
      inActionPhase = false;
      worstPhaseSwitches = Math.max(worstPhaseSwitches, phaseSwitches);
    }
    if (player !== null && stage !== 'decision') {
      const key = `${round}:${player}:${stage}`;
      if (!submissions[key]) {
        submissions[key] = true;
        perRound[round] ??= [0, 0];
        perRound[round][player]++;
      }
    }
    // Everything else — dice, abilities, ordering — is answered by the stated policy, no round trip.
    const packets: Partial<Record<PlayerId, TurnPacket>> = {};
    for (const p of [0, 1] as PlayerId[]) packets[p] = { player: p, policy: DEFAULT_POLICY };
    let cmd = null;
    const a = answer(G, packets, seed);
    if (a.kind === 'command') cmd = a.command;
    else for (const p of [0, 1] as PlayerId[]) { cmd = bots[p].decide(G); if (cmd) break; }
    expect(cmd, `nobody can act on ${G.pending?.type}`).toBeTruthy();
    G = applyCommand(G, cmd!).state;
    expect(++steps).toBeLessThan(30000);
  }
  const counts = Object.values(perRound).flat();
  const rawCounts = Object.values(naivePerRound).flat();
  return { G, counts, rawCounts, worstPhaseSwitches, rounds: Object.keys(perRound).length };
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

describe('correspondence variant', () => {
  it('cuts a round from ten decisions to three sittings', () => {
    const sittings: number[] = [], naive: number[] = [];
    for (let seed = 1; seed <= 12; seed++) {
      const r = play('correspondence', seed);
      sittings.push(...r.counts);
      naive.push(...r.rawCounts);
    }
    const s = median(sittings), n = median(naive);
    console.log(`per player per round — packeted sittings: ${s}, naive per-decision: ${n}`);
    // The claim in CORRESPONDENCE.md: a round costs three submissions instead of ten.
    expect(s).toBeLessThanOrEqual(3);
    expect(n).toBeGreaterThanOrEqual(6);
    expect(s * 2).toBeLessThan(n);
  });

  it('asks a player for all of their actions before turning to the opponent', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const r = play('correspondence', seed);
      // Within any one action phase the asking player hands over exactly once: all of mine, then all of theirs.
      expect(r.worstPhaseSwitches, `seed ${seed}: action phase alternated between players`).toBeLessThanOrEqual(1);
    }
  });

  it('plays full games to a winner under the batched action phase', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { G } = play('correspondence', seed);
      expect(G.winner).not.toBeNull();
      expect(G.phase).toBe('over');
      // No ship may be left holding an unspent action when the game ends.
      expect(liveShips(G).some(s => s.owedAction)).toBe(false);
    }
  });

  it('still lets every ship act — batching defers the action, it does not remove it', () => {
    let acted = 0, ships = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const bots = [0, 1].map(i => new Bot(i as PlayerId, { difficulty: 'ace', seed }));
      let G = createGame([PRESET_SQUADS[0], PRESET_SQUADS[1]], ['A', 'B'], seed, { variant: 'correspondence' }).state;
      let sawActionPhase = false;
      while (G.phase !== 'over' && G.round < 3) {
        if (G.stack.some(f => f.type === 'actionPhase')) sawActionPhase = true;
        if (G.round === 2 && G.phase === 'engagement') {
          ships += activeShips(G).length;
          acted += activeShips(G).filter(s => s.actionsThisRound.length > 0).length;
          break;
        }
        let cmd = null;
        for (const p of [0, 1] as PlayerId[]) { cmd = bots[p].decide(G); if (cmd) break; }
        if (!cmd) break;
        G = applyCommand(G, cmd).state;
      }
      expect(sawActionPhase).toBe(true);
    }
    expect(acted / Math.max(1, ships)).toBeGreaterThan(0.5);
  });
});
