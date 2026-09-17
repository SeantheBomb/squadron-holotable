// Presentation packs overlay names, text and models onto the engine's neutral content. They never
// change mechanics or ids, so packed and unpacked clients stay compatible with the same server.
import { CONTENT } from '@holotable/rules';
import type { Squad } from '@holotable/rules';

export interface Pack {
  name: string;
  terms?: { force?: string };
  factions?: Record<string, { name: string }>;
  ships?: Record<string, { name?: string; model?: string; modelScale?: number; modelYaw?: number; abilityName?: string; abilityText?: string }>;
  pilots?: Record<string, { name?: string; caption?: string; text?: string; xws?: string }>;
  upgrades?: Record<string, { name?: string; text?: string; xws?: string }>;
  damage?: Record<string, { name?: string; text?: string }>;
  squads?: Squad[];
  credits?: { what: string; author: string; license: string; url: string }[];
}

export let activePack: Pack | null = null;
export let packBase = '';
export const term = (k: 'force') => activePack?.terms?.[k] ?? ({ force: 'Force' } as const)[k];

export function packUrl(): string | null {
  const q = new URLSearchParams(location.search).get('pack');
  if (q === 'none') return null;
  return q ?? localStorage.getItem('holotable-pack') ?? (import.meta as any).env?.VITE_PACK_URL ?? ((import.meta as any).env?.DEV ? '/pack/pack.json' : null);
}

export async function loadPack(): Promise<Pack | null> {
  const url = packUrl();
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
    const pack = (await res.json()) as Pack;
    packBase = new URL('.', new URL(url, location.href)).href;
    for (const [id, o] of Object.entries(pack.factions ?? {})) if (CONTENT.factions[id]) CONTENT.factions[id].name = o.name;
    for (const [id, o] of Object.entries(pack.ships ?? {})) {
      const s = CONTENT.ships[id]; if (!s) continue;
      if (o.name) s.name = o.name;
      if (s.shipAbility) { if (o.abilityName) s.shipAbility.name = o.abilityName; if (o.abilityText) s.shipAbility.text = o.abilityText; }
    }
    for (const [id, o] of Object.entries(pack.pilots ?? {})) { const p = CONTENT.pilots[id]; if (p) Object.assign(p, { name: o.name ?? p.name, caption: o.caption ?? p.caption, text: o.text ?? p.text }); }
    for (const [id, o] of Object.entries(pack.upgrades ?? {})) { const u = CONTENT.upgrades[id]; if (u) Object.assign(u, { name: o.name ?? u.name, text: o.text ?? u.text }); }
    for (const [id, o] of Object.entries(pack.damage ?? {})) { const c = CONTENT.damageDeck.find(d => d.id === id); if (c) Object.assign(c, { name: o.name ?? c.name, text: o.text ?? c.text }); }
    activePack = pack;
    return pack;
  } catch { return null; }
}

/** XWS (the community squad interchange format) → engine squad, via the pack's id mapping. */
export function importXws(json: string): Squad {
  const x = JSON.parse(json);
  const pilotByXws = new Map<string, string>(), upgradeByXws = new Map<string, string>();
  for (const [id, o] of Object.entries(activePack?.pilots ?? {})) if (o.xws) pilotByXws.set(o.xws, id);
  for (const [id, o] of Object.entries(activePack?.upgrades ?? {})) if (o.xws) upgradeByXws.set(o.xws, id);
  if (!pilotByXws.size) throw new Error('XWS import needs a presentation pack with an id mapping.');
  const ships = (x.pilots ?? []).map((p: any) => {
    const pilotId = pilotByXws.get(p.id ?? p.name);
    if (!pilotId) throw new Error(`Pilot "${p.id ?? p.name}" is not available yet.`);
    const upgrades: string[] = [];
    if (!CONTENT.pilots[pilotId].standardLoadout) for (const list of Object.values(p.upgrades ?? {})) for (const u of list as string[]) {
      const id = upgradeByXws.get(u);
      if (!id) throw new Error(`Upgrade "${u}" is not available yet.`);
      upgrades.push(id);
    }
    return { pilotId, upgrades };
  });
  if (!ships.length) throw new Error('No pilots found in XWS.');
  const faction = CONTENT.ships[CONTENT.pilots[ships[0].pilotId].shipId].faction;
  return { name: x.name || 'Imported Squad', faction, ships };
}
