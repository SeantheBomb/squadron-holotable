// Closed-form expected damage for attack vs defense dice with the common modifiers.
const binom: number[][] = [];
for (let n = 0; n <= 10; n++) { binom[n] = []; for (let k = 0; k <= n; k++) binom[n][k] = k === 0 || k === n ? 1 : binom[n - 1][k - 1] + binom[n - 1][k]; }

function dist(n: number, p: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= n; k++) out.push(binom[n][k] * p ** k * (1 - p) ** (n - k));
  return out;
}

export interface AttackMods { focus?: boolean; reroll?: boolean; rerollOne?: boolean }
export interface DefenseMods { focus?: boolean; evade?: boolean }

const memo = new Map<string, number>();

export function expectedDamage(attackDice: number, a: AttackMods, defenseDice: number, d: DefenseMods): number {
  attackDice = Math.max(0, Math.min(8, attackDice)); defenseDice = Math.max(0, Math.min(8, defenseDice));
  const k = `${attackDice}${a.focus ? 'f' : ''}${a.reroll ? 'r' : ''}${a.rerollOne ? 'o' : ''}|${defenseDice}${d.focus ? 'f' : ''}${d.evade ? 'e' : ''}`;
  const hit = memo.get(k);
  if (hit !== undefined) return hit;
  let pa = a.focus ? 6 / 8 : 4 / 8;
  if (a.reroll) pa = pa + (1 - pa) * pa;
  else if (a.rerollOne && attackDice > 0) pa = pa + ((1 - pa) * pa) / attackDice; // one die's worth of reroll spread over the pool
  const pd = d.focus ? 5 / 8 : 3 / 8;
  const A = dist(attackDice, pa), D = dist(defenseDice, pd);
  let e = 0;
  for (let h = 0; h <= attackDice; h++) for (let ev = 0; ev <= defenseDice; ev++) {
    const evades = ev + (d.evade && ev < defenseDice ? 1 : 0);
    e += A[h] * D[ev] * Math.max(0, h - evades);
  }
  memo.set(k, e);
  return e;
}
