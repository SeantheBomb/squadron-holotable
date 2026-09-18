// Accounts: username + password, e-mail strictly optional.
//
// The browser does the expensive key stretching (PBKDF2-HMAC-SHA256, 600k iterations) and sends only
// the derived key — see packages/client/src/account.ts. Two reasons:
//   1. A Worker invocation has a small CPU budget; 600k iterations server-side would blow it.
//   2. The server never sees the password at all.
// The derived key is high-entropy, so a single salted SHA-256 is enough to make a database leak
// useless on its own: recovering a login still means brute-forcing the password through the
// client-side stretch.

export interface Env { holotable: D1Database }

export interface User { id: string; username: string; email: string | null }

const enc = new TextEncoder();
const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const randomHex = (bytes = 32) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

/** Constant-time compare, so a timing signal cannot leak how much of a hash matched. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,23}$/;
const RESERVED = new Set(['admin', 'moderator', 'system', 'server', 'holotable', 'claude', 'anonymous', 'guest', 'you']);

export function checkUsername(name: string): string | null {
  if (!USERNAME_RE.test(name)) return 'Usernames are 2-24 characters: letters, digits, spaces, and . _ -';
  if (/\s\s/.test(name) || name.trim() !== name) return 'No leading, trailing or repeated spaces.';
  if (RESERVED.has(name.toLowerCase().replace(/\s+/g, ''))) return 'That name is reserved.';
  return null;
}

/** Never store the raw derived key; salt it per user first. */
async function stored(derivedKey: string, salt: string): Promise<string> {
  return sha256(`${salt}:${derivedKey}`);
}

export async function register(env: Env, username: string, derivedKey: string, email?: string | null): Promise<{ user: User; token: string } | { error: string }> {
  const bad = checkUsername(username);
  if (bad) return { error: bad };
  if (typeof derivedKey !== 'string' || derivedKey.length < 32) return { error: 'Bad credential.' };
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return { error: 'That email address does not look right.' };

  const key = username.toLowerCase().replace(/\s+/g, ' ');
  const existing = await env.holotable.prepare('SELECT id FROM users WHERE username_key = ?').bind(key).first();
  if (existing) return { error: 'That username is taken.' };

  const id = randomHex(16), salt = randomHex(16), now = Date.now();
  await env.holotable.prepare(
    'INSERT INTO users (id, username, username_key, pw_hash, pw_salt, email, created_at, last_seen) VALUES (?,?,?,?,?,?,?,?)',
  ).bind(id, username, key, await stored(derivedKey, salt), salt, email || null, now, now).run();

  return { user: { id, username, email: email || null }, token: await issueSession(env, id) };
}

export async function login(env: Env, username: string, derivedKey: string): Promise<{ user: User; token: string } | { error: string }> {
  const key = String(username ?? '').toLowerCase().replace(/\s+/g, ' ');
  const row = await env.holotable.prepare('SELECT id, username, email, pw_hash, pw_salt FROM users WHERE username_key = ?').bind(key).first<any>();
  // Same message either way: do not reveal which usernames exist.
  if (!row) return { error: 'Wrong username or password.' };
  if (!sameSecret(await stored(String(derivedKey ?? ''), row.pw_salt), row.pw_hash)) return { error: 'Wrong username or password.' };
  await env.holotable.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(Date.now(), row.id).run();
  return { user: { id: row.id, username: row.username, email: row.email }, token: await issueSession(env, row.id) };
}

const SESSION_DAYS = 120; // correspondence games run for weeks; do not sign people out mid-match

async function issueSession(env: Env, userId: string): Promise<string> {
  const token = randomHex(32), now = Date.now();
  await env.holotable.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 864e5).run();
  return token;
}

/** Resolve `Authorization: Bearer <token>` to a user, or null. */
export async function userFor(env: Env, req: Request): Promise<User | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token || token.length < 32) return null;
  const row = await env.holotable.prepare(
    `SELECT u.id, u.username, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
  ).bind(await sha256(token)).first<any>();
  if (!row || row.expires_at < Date.now()) return null;
  return { id: row.id, username: row.username, email: row.email };
}

export async function logout(env: Env, req: Request): Promise<void> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (token) await env.holotable.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

/** Deleting an account takes its sessions, push endpoints and match ownership with it. */
export async function deleteAccount(env: Env, userId: string): Promise<void> {
  await env.holotable.batch([
    env.holotable.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    env.holotable.prepare('DELETE FROM push_subs WHERE user_id = ?').bind(userId),
    env.holotable.prepare('UPDATE matches SET p0_user = NULL WHERE p0_user = ?').bind(userId),
    env.holotable.prepare('UPDATE matches SET p1_user = NULL WHERE p1_user = ?').bind(userId),
    env.holotable.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
}

export async function setEmail(env: Env, userId: string, email: string | null): Promise<string | null> {
  if (email && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) return 'That email address does not look right.';
  await env.holotable.prepare('UPDATE users SET email = ? WHERE id = ?').bind(email || null, userId).run();
  return null;
}
