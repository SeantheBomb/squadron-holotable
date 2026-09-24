// Accounts, client half.
//
// The password never leaves this file. We stretch it here with PBKDF2-HMAC-SHA256 (600k iterations,
// the current OWASP figure) and send only the derived key, which the server salts and hashes again.
// That keeps the heavy work off the Worker's small CPU budget and means a server-side breach never
// exposes anything a person typed.

export interface Account { id: string; username: string; email: string | null }

const TOKEN_KEY = 'holotable-session';
const ITERATIONS = 600_000;

export const serverUrl = (): string =>
  localStorage.getItem('holotable-server') || (import.meta as any).env?.VITE_SERVER_URL || 'http://localhost:8787';

export let account: Account | null = null;
let token: string | null = localStorage.getItem(TOKEN_KEY);
export const signedIn = () => !!token && !!account;

async function deriveKey(username: string, password: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = enc.encode(`holotable:v1:${username.toLowerCase().replace(/\s+/g, ' ')}`);
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, base, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as any) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${serverUrl()}${path}`, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || (body as any).error) throw new Error((body as any).error ?? `Request failed (${res.status})`);
  return body as T;
}

export async function restore(): Promise<Account | null> {
  if (!token) return null;
  try {
    const { user } = await api<{ user: Account | null }>('/api/account/me');
    account = user;
    if (!user) clearToken();
    return user;
  } catch { return null; }
}

function keep(out: { user: Account; token: string }) {
  account = out.user; token = out.token;
  localStorage.setItem(TOKEN_KEY, out.token);
}
function clearToken() { token = null; account = null; localStorage.removeItem(TOKEN_KEY); }

export async function register(username: string, password: string, email?: string): Promise<Account> {
  if (password.length < 8) throw new Error('Use at least 8 characters.');
  const key = await deriveKey(username, password);
  keep(await api('/api/account/register', { method: 'POST', body: JSON.stringify({ username, key, email: email || null }) }));
  return account!;
}

export async function signIn(username: string, password: string): Promise<Account> {
  const key = await deriveKey(username, password);
  keep(await api('/api/account/login', { method: 'POST', body: JSON.stringify({ username, key }) }));
  return account!;
}

export async function signOut(): Promise<void> {
  try { await api('/api/account/logout', { method: 'POST' }); } catch { /* the token dies locally either way */ }
  clearToken();
}

export const updateEmail = (email: string | null) => api<{ ok: true }>('/api/account/email', { method: 'POST', body: JSON.stringify({ email }) });
export const deleteAccount = async () => { await api('/api/account/delete', { method: 'POST' }); clearToken(); };

export interface MatchSummary {
  code: string; mode: string; status: string; round: number;
  p0_name: string | null; p1_name: string | null;
  yourTurn: boolean; you: 0 | 1; updated_at: number; winner: string | null;
}
export const myMatches = () => api<{ matches: MatchSummary[] }>('/api/matches').then(r => r.matches);

export async function createRoom(mode: 'live' | 'correspondence' = 'live'): Promise<string> {
  return (await api<{ code: string }>('/api/rooms', { method: 'POST', body: JSON.stringify({ mode }) })).code;
}

export const getTurn = (code: string) => api<any>(`/api/rooms/${code}/turn`);
export const postTurn = (code: string, body: unknown) => api<any>(`/api/rooms/${code}/turn`, { method: 'POST', body: JSON.stringify(body) });

/** Sockets carry no headers we control, so the session rides along as a query parameter. */
export const socketAuth = () => (token ? `?t=${encodeURIComponent(token)}` : '');

/** The full record of a finished match. `seat` is the seat token guests hold for live rooms. */
export const getReplay = (code: string, seat?: string | null) =>
  api<import('@holotable/rules').MatchRecord>(`/api/rooms/${code}/replay${seat ? `?seat=${encodeURIComponent(seat)}` : ''}`);
