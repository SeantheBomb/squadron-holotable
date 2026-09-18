import { describe, expect, it } from 'vitest';
import { PLAY_AREA, PRESET_SQUADS, activeShips, applyCommand, createGame, dialFor, liveShips } from '../src';
import type { GameState, PlayerId, Pose } from '../src';
import { Bot, DEFAULT_POLICY, answer, runForward, stageOf } from '../../bot/src';
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

/**
 * Drives a game the way the server actually does: a player is asked for a stage, submits a packet
 * stamped with that stage, and the run continues. The earlier tests passed packets with no choices
 * at all, which is why they never caught the assistant quietly playing the engagement.
 */
describe('a packet only speaks for the stage it was submitted for', () => {
  it('still asks the player to declare attacks after they have submitted their actions', () => {
    let attacksAsked = 0, actionsAsked = 0, gamesWithCombat = 0;
    for (let seed = 1; seed <= 10; seed++) {
      let G: GameState = createGame(
        [PRESET_SQUADS[seed % 4], PRESET_SQUADS[(seed + 1) % 4]], ['A', 'B'], 700 + seed, { variant: 'correspondence' },
      ).state;
      const stored: Record<number, any> = {};
      const bots = [0, 1].map(i => new Bot(i as PlayerId, { difficulty: 'ace', seed: seed * 17 + i }));
      let sawAttackPrompt = false, steps = 0;

      while (G.phase !== 'over' && steps++ < 4000) {
        const res = runForward(G, stored, (st, c) => applyCommand(st, c), seed);
        G = res.state;
        if (res.waitingOn === null) break;
        const p = res.waitingOn;
        if (res.stage === 'attacks') { attacksAsked++; sawAttackPrompt = true; }
        if (res.stage === 'actions') actionsAsked++;
        // The sitting: a packet for this stage only, with no explicit choices — the assistant fills
        // in within the stage, exactly as it does for a player who left everything on its default.
        stored[p] = { player: p, stage: res.stage, choices: [], dials: undefined, deploy: undefined, policy: DEFAULT_POLICY };
        if (res.stage === 'dials') {
          // Fly like a player would — the assistant closes on the enemy, so the squadrons actually meet.
          const cmd = bots[p].decide(G);
          const dials: Record<string, number> = cmd && cmd.type === 'setDials' ? cmd.dials : {};
          for (const s of activeShips(G).filter(s => s.owner === p)) {
            if (Number.isInteger(dials[s.id])) continue;
            const ok = dialFor(s).filter(d => d.allowed);
            dials[s.id] = ok[Math.floor(ok.length / 2)].index;
          }
          stored[p].dials = dials;
        }
        if (res.stage === 'deploy') {
          const deploy: Record<string, Pose> = {};
          for (const s of Object.values(G.ships).filter(s => s.owner === p && !s.removed)) {
            const n = Number(s.label) || 1;
            deploy[s.id] = { x: PLAY_AREA / 2 + (n - 3) * 58, y: p === 0 ? 30 : PLAY_AREA - 30, r: p === 0 ? Math.PI / 2 : -Math.PI / 2 };
          }
          stored[p].deploy = deploy;
        }
      }
      if (sawAttackPrompt) gamesWithCombat++;
    }
    expect(actionsAsked, 'players were never asked for actions').toBeGreaterThan(0);
    // The bug: an actions packet has `choices`, so every later attack prompt fell through to the
    // assistant and the engagement was played without the player ever seeing it.
    expect(attacksAsked, 'the player was never asked to declare an attack').toBeGreaterThan(0);
    expect(gamesWithCombat, 'no game ever reached an attack declaration').toBeGreaterThan(2);
  });
});
