// Minimal goal-oriented action planner: forward A* over boolean world facts.
export type Facts = Record<string, boolean>;

export interface GoapAction {
  name: string;
  cost: number;
  pre: Facts;
  eff: Facts;
}

const satisfies = (state: Facts, cond: Facts) => Object.entries(cond).every(([k, val]) => !!state[k] === val);
const key = (s: Facts) => Object.keys(s).filter(k => s[k]).sort().join('|');

export function plan(start: Facts, goal: Facts, actions: GoapAction[], maxDepth = 5): GoapAction[] | null {
  interface Node { state: Facts; path: GoapAction[]; g: number }
  const open: Node[] = [{ state: start, path: [], g: 0 }];
  const best = new Map<string, number>();
  const h = (s: Facts) => Object.entries(goal).filter(([k, val]) => !!s[k] !== val).length;
  while (open.length) {
    open.sort((a, b) => a.g + h(a.state) - (b.g + h(b.state)));
    const n = open.shift()!;
    if (satisfies(n.state, goal)) return n.path;
    if (n.path.length >= maxDepth) continue;
    for (const a of actions) {
      if (!satisfies(n.state, a.pre)) continue;
      const state = { ...n.state, ...a.eff };
      const g = n.g + a.cost, k = key(state);
      if ((best.get(k) ?? Infinity) <= g) continue;
      best.set(k, g);
      open.push({ state, path: [...n.path, a], g });
    }
  }
  return null;
}
