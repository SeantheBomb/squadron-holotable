import { describe, expect, it } from 'vitest';
import { PRESET_SQUADS, applyCommand, createGame, newRecord, recordStep, resimulate } from '../src';
import type { GameState, PlayerId } from '../src';
import { Bot } from '../../bot/src';

function recordedGame(seed: number, variant: 'standard' | 'correspondence') {
  const squads = [PRESET_SQUADS[seed % 4], PRESET_SQUADS[(seed + 1) % 4]] as const;
  const g = createGame([squads[0], squads[1]], ['A', 'B'], seed, { variant });
  const rec = newRecord([squads[0], squads[1]], ['A', 'B'], seed, { variant }, g.events);
  const bots = [0, 1].map(i => new Bot(i as PlayerId, { difficulty: 'ace', seed: seed + i }));
  let G: GameState = g.state;
  while (G.phase !== 'over') {
    const P = G.pending!;
    const cmd = bots[P.type === 'planning' ? P.players[0] : P.player].decide(G)!;
    const res = applyCommand(G, cmd);
    G = res.state;
    recordStep(rec, cmd, res.events, G);
  }
  return { rec, final: G };
}

describe('match records', () => {
  it('re-run a finished match exactly, step for step', () => {
    for (const [seed, variant] of [[3, 'standard'], [8, 'correspondence']] as const) {
      const { rec, final } = recordedGame(seed, variant);
      const { steps, faithful } = resimulate(JSON.parse(JSON.stringify(rec)));
      expect(faithful).toBe(true);
      expect(steps.length).toBe(rec.commands.length + 1);
      expect(steps[steps.length - 1].state).toEqual(final);
      expect(rec.winner).toBe(final.winner);
      expect(rec.finishedAt).toBeTypeOf('number');
    }
  });

  it('notices when the recorded events no longer match what the engine produces', () => {
    const { rec } = recordedGame(5, 'standard');
    const tampered = JSON.parse(JSON.stringify(rec));
    const i = tampered.events.findIndex((e: any) => e.t === 'attackResult');
    tampered.events[i].hits += 1;
    expect(resimulate(tampered).faithful).toBe(false);
  });

  it('ignores display names, which depend on the presentation pack loaded', () => {
    const { rec } = recordedGame(6, 'standard');
    const renamed = JSON.parse(JSON.stringify(rec));
    for (const e of renamed.events) { if (e.weaponName) e.weaponName = 'Renamed'; if (e.label) e.label = 'Renamed'; }
    expect(resimulate(renamed).faithful).toBe(true);
  });
});
