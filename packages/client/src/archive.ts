// Finished matches kept in this browser, so games against the AI and hotseat games can be watched
// back too. Online matches are stored here as well once fetched, which covers guests who have no
// account-backed match list.
import type { MatchRecord } from '@holotable/rules';

export interface ArchiveEntry {
  id: string;                 // room code for online matches, a random id for local ones
  record: MatchRecord;
  savedAt: number;
}

const DB = 'holotable-archive', STORE = 'matches', LIMIT = 100;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export async function listArchive(): Promise<ArchiveEntry[]> {
  try { return (await tx<ArchiveEntry[]>('readonly', s => s.getAll())).sort((a, b) => b.savedAt - a.savedAt); }
  catch { return []; }   // private windows and blocked storage: the archive is a convenience
}

export async function saveToArchive(id: string, record: MatchRecord) {
  try {
    await tx('readwrite', s => s.put({ id, record, savedAt: Date.now() }));
    const all = await listArchive();
    for (const old of all.slice(LIMIT)) await tx('readwrite', s => s.delete(old.id));
  } catch { /* not fatal */ }
}

export async function getArchived(id: string): Promise<MatchRecord | null> {
  try { return (await tx<ArchiveEntry | undefined>('readonly', s => s.get(id)))?.record ?? null; }
  catch { return null; }
}

export async function removeFromArchive(id: string) {
  try { await tx('readwrite', s => s.delete(id)); } catch { /* not fatal */ }
}
