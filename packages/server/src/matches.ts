// The match index. Durable Objects hold the games but cannot be listed or queried, so every match
// also gets a row here to answer "which games am I in, and whose move is it?".
import type { Env, User } from './auth';

export interface MatchRow {
  code: string; mode: string; status: string;
  p0_user: string | null; p1_user: string | null;
  p0_name: string | null; p1_name: string | null;
  turn_user: string | null; round: number; winner: string | null;
  created_at: number; updated_at: number;
}

export async function createMatch(env: Env, code: string, mode: 'live' | 'correspondence', creator: User | null): Promise<void> {
  const now = Date.now();
  await env.holotable.prepare(
    `INSERT INTO matches (code, mode, status, p0_user, p0_name, round, created_at, updated_at)
     VALUES (?,?,'lobby',?,?,0,?,?) ON CONFLICT(code) DO NOTHING`,
  ).bind(code, mode, creator?.id ?? null, creator?.username ?? null, now, now).run();
}

/** Called by the match Durable Object whenever the game state moves on. */
export async function syncMatch(env: Env, code: string, patch: Partial<MatchRow>): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  const sets = cols.map(c => `${c} = ?`).join(', ');
  await env.holotable.prepare(`UPDATE matches SET ${sets}, updated_at = ? WHERE code = ?`)
    .bind(...cols.map(c => (patch as any)[c]), Date.now(), code).run();
}

export async function claimSeat(env: Env, code: string, seat: 0 | 1, user: User): Promise<void> {
  const col = seat === 0 ? 'p0_user' : 'p1_user', name = seat === 0 ? 'p0_name' : 'p1_name';
  await env.holotable.prepare(`UPDATE matches SET ${col} = ?, ${name} = ?, updated_at = ? WHERE code = ?`)
    .bind(user.id, user.username, Date.now(), code).run();
}

/** Games a player is in, most recently moved first, with the ones waiting on them flagged. */
export async function listMatches(env: Env, userId: string, limit = 50): Promise<(MatchRow & { yourTurn: boolean; you: 0 | 1 })[]> {
  const { results } = await env.holotable.prepare(
    `SELECT * FROM matches WHERE (p0_user = ? OR p1_user = ?) AND status != 'abandoned'
     ORDER BY (turn_user = ?) DESC, updated_at DESC LIMIT ?`,
  ).bind(userId, userId, userId, limit).all<MatchRow>();
  return (results ?? []).map(m => ({ ...m, yourTurn: m.turn_user === userId, you: m.p0_user === userId ? 0 : 1 }));
}

export async function getMatch(env: Env, code: string): Promise<MatchRow | null> {
  return await env.holotable.prepare('SELECT * FROM matches WHERE code = ?').bind(code).first<MatchRow>();
}
