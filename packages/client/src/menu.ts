// Hangar: mode select, squad selection/builder, online lobby.
import { CONTENT, PRESET_SQUADS, SQUAD_LIMIT, squadCost, validateSquad } from '@holotable/rules';
import type { Squad } from '@holotable/rules';
import type { BotOptions } from '@holotable/bot';
import { h } from './hud';
import { activePack, importXws } from './pack';
import { sfx } from './audio';

export type Launch =
  | { mode: 'bot'; squads: [Squad, Squad]; bot: BotOptions; name: string }
  | { mode: 'hotseat'; squads: [Squad, Squad] }
  | { mode: 'online'; server: string; code: string; name: string; squad: Squad };

const CUSTOM_KEY = 'holotable-squads';
const loadCustom = (): Squad[] => { try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]'); } catch { return []; } };
const saveCustom = (s: Squad[]) => { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(s)); } catch { /* ignore */ } };
const allSquads = (): Squad[] => [...(activePack?.squads ?? []), ...PRESET_SQUADS, ...loadCustom()].filter(s => !validateSquad(s).length);

export function showMenu(ui: HTMLElement, launch: (l: Launch) => void) {
  let mode: 'bot' | 'hotseat' | 'online' = 'bot';
  let a = 0, b = 1;
  let difficulty: BotOptions['difficulty'] = 'veteran', personality: BotOptions['personality'] = 'jouster';
  let name = localStorage.getItem('holotable-name') ?? 'Commander';
  let server = localStorage.getItem('holotable-server') ?? (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:8787';
  let code = '';
  let status = '';

  const squadSelect = (value: number, on: (i: number) => void) => {
    const sq = allSquads();
    const sel = h('select', { onchange: (e: Event) => on(Number((e.target as HTMLSelectElement).value)) },
      ...sq.map((s, i) => h('option', { value: i, selected: i === value }, `${s.name} — ${CONTENT.factions[s.faction]?.name ?? s.faction} (${squadCost(s)} pts)`)));
    return sel;
  };
  const squadSummary = (s: Squad | undefined) => h('ul', { class: 'squadlist' }, ...(s?.ships ?? []).map(sh => {
    const p = CONTENT.pilots[sh.pilotId];
    const ups = (p.standardLoadout ?? sh.upgrades).map(u => CONTENT.upgrades[u].name).join(', ');
    return h('li', {}, h('b', {}, `${p.initiative} · ${p.name}`), ` ${CONTENT.ships[p.shipId].name}`, ups ? h('small', {}, ` — ${ups}`) : null);
  }));

  const render = () => {
    const sq = allSquads();
    a = Math.min(a, sq.length - 1); b = Math.min(b, sq.length - 1);
    const tab = (m: typeof mode, label: string) => h('button', { class: `tab${mode === m ? ' on' : ''}`, onclick: () => { sfx.click(); mode = m; render(); } }, label);
    const body = h('div', { class: 'menu-body' });
    const nameInput = h('input', { value: name, maxlength: 24, oninput: (e: Event) => { name = (e.target as HTMLInputElement).value; localStorage.setItem('holotable-name', name); } });

    if (mode === 'bot') {
      body.append(
        h('label', {}, 'Callsign', nameInput),
        h('label', {}, 'Your squadron', squadSelect(a, i => { a = i; render(); })), squadSummary(sq[a]),
        h('label', {}, 'Enemy squadron', squadSelect(b, i => { b = i; render(); })), squadSummary(sq[b]),
        h('div', { class: 'rowgap' },
          h('label', {}, 'Opponent skill', h('select', { onchange: (e: Event) => (difficulty = (e.target as HTMLSelectElement).value as any) }, ...['rookie', 'veteran', 'ace'].map(d => h('option', { value: d, selected: d === difficulty }, d[0].toUpperCase() + d.slice(1))))),
          h('label', {}, 'Doctrine', h('select', { onchange: (e: Event) => (personality = (e.target as HTMLSelectElement).value as any) }, ...[['jouster', 'Jouster — aggressive'], ['flanker', 'Flanker — cagey'], ['guardian', 'Guardian — protective']].map(([id, l]) => h('option', { value: id, selected: id === personality }, l))))),
        h('button', { class: 'primary big', onclick: () => launch({ mode: 'bot', squads: [sq[a], sq[b]], bot: { difficulty, personality }, name }) }, 'Launch'));
    } else if (mode === 'hotseat') {
      body.append(
        h('label', {}, 'Player 1 squadron', squadSelect(a, i => { a = i; render(); })), squadSummary(sq[a]),
        h('label', {}, 'Player 2 squadron', squadSelect(b, i => { b = i; render(); })), squadSummary(sq[b]),
        h('button', { class: 'primary big', onclick: () => launch({ mode: 'hotseat', squads: [sq[a], sq[b]] }) }, 'Launch'));
    } else {
      const go = (c: string) => { localStorage.setItem('holotable-server', server); launch({ mode: 'online', server, code: c.toUpperCase(), name, squad: sq[a] }); };
      body.append(
        h('label', {}, 'Callsign', nameInput),
        h('label', {}, 'Your squadron', squadSelect(a, i => { a = i; render(); })), squadSummary(sq[a]),
        h('label', {}, 'Match server', h('input', { value: server, oninput: (e: Event) => (server = (e.target as HTMLInputElement).value.replace(/\/$/, '')) })),
        h('div', { class: 'rowgap' },
          h('button', { class: 'primary', onclick: async () => {
            status = 'Opening a room…'; render();
            try { const res = await fetch(`${server}/api/rooms`, { method: 'POST' }); const j = await res.json(); go(j.code); }
            catch { status = 'Could not reach the match server.'; render(); }
          } }, 'Create room'),
          h('input', { placeholder: 'ROOM CODE', maxlength: 5, class: 'code', value: code, oninput: (e: Event) => (code = (e.target as HTMLInputElement).value) }),
          h('button', { onclick: () => (code.trim().length === 5 ? go(code.trim()) : (status = 'Room codes are 5 characters.', render())) }, 'Join')),
        h('p', { class: 'hint' }, status || 'Create a room and send the code to your opponent. Dice and hidden dials are handled by the server.'));
    }

    ui.replaceChildren(h('div', { class: 'menu' },
      h('div', { class: 'menu-card' },
        h('h1', {}, 'SQUADRON HOLOTABLE'),
        h('p', { class: 'tagline' }, activePack ? `Content pack: ${activePack.name}` : 'Tactical starfighter combat'),
        h('div', { class: 'tabs' }, tab('bot', 'Versus AI'), tab('hotseat', 'Hotseat'), tab('online', 'Online')),
        body,
        h('div', { class: 'menu-foot' },
          h('button', { onclick: () => showBuilder(ui, render) }, 'Squad builder'),
          h('button', { onclick: () => {
            const text = prompt('Paste XWS JSON (exported from a squad builder):');
            if (!text) return;
            try { const s = importXws(text); const errs = validateSquad(s); if (errs.length) throw new Error(errs.join(' ')); saveCustom([...loadCustom(), s]); render(); }
            catch (e: any) { alert(e.message); }
          } }, 'Import XWS'),
          h('button', { onclick: () => showCredits(ui, render) }, 'Credits & legal')),
        h('p', { class: 'disclaimer' }, 'Unofficial, non-commercial fan project. Not affiliated with or endorsed by any rights holder. All trademarks belong to their respective owners.'))));
  };
  render();
}

function showCredits(ui: HTMLElement, back: () => void) {
  ui.replaceChildren(h('div', { class: 'menu' }, h('div', { class: 'menu-card' },
    h('h2', {}, 'Credits & legal'),
    h('p', {}, 'Squadron Holotable is a free, open-source (MIT) tactical game engine. It is a non-commercial fan project: no purchases, no ads, no donations.'),
    h('p', {}, 'The engine ships with original placeholder content. Optional presentation packs are maintained separately and credited below.'),
    h('ul', {}, ...(activePack?.credits ?? []).map(c => h('li', {}, `${c.what} — ${c.author} (${c.license}) `, h('a', { href: c.url, target: '_blank', rel: 'noopener' }, 'source')))),
    h('p', { class: 'disclaimer' }, 'This project is not affiliated with, endorsed, sponsored, or approved by Lucasfilm Ltd., The Walt Disney Company, Atomic Mass Games, Asmodee or Fantasy Flight Games. All trademarks and copyrights are the property of their respective owners.'),
    h('button', { class: 'primary', onclick: back }, 'Back'))));
}

function showBuilder(ui: HTMLElement, back: () => void) {
  let squad: Squad = { name: 'My Squadron', faction: Object.keys(CONTENT.factions)[0], ships: [] };
  const render = () => {
    const errs = validateSquad(squad);
    const pilots = Object.values(CONTENT.pilots).filter(p => CONTENT.ships[p.shipId].faction === squad.faction).sort((x, y) => x.shipId.localeCompare(y.shipId) || y.initiative - x.initiative);
    const list = h('div', { class: 'builder-ships' }, ...squad.ships.map((sh, i) => {
      const p = CONTENT.pilots[sh.pilotId];
      const load = sh.upgrades.reduce((n, u) => n + CONTENT.upgrades[u].cost, 0);
      const free = [...p.slots]; for (const u of sh.upgrades) { const k = free.indexOf(CONTENT.upgrades[u].slot); if (k >= 0) free.splice(k, 1); }
      const avail = Object.values(CONTENT.upgrades).filter(u => free.includes(u.slot) && !sh.upgrades.includes(u.id) && !u.restrictions?.standardLoadoutOnly && (!u.restrictions?.needsForce || p.force) && load + u.cost <= p.loadout);
      return h('div', { class: 'builder-ship' },
        h('div', {}, h('b', {}, `${p.initiative} · ${p.name}`), ` ${CONTENT.ships[p.shipId].name} · ${p.cost} pts`, p.standardLoadout ? ' · standard loadout' : ` · loadout ${load}/${p.loadout}`,
          h('button', { class: 'x', onclick: () => { squad.ships.splice(i, 1); render(); } }, '×')),
        p.text ? h('small', {}, p.text) : null,
        h('div', { class: 'upgrades' },
          ...(p.standardLoadout ?? []).map(u => h('span', { class: 'upg', title: CONTENT.upgrades[u].text }, CONTENT.upgrades[u].name)),
          ...sh.upgrades.map((u, k) => h('span', { class: 'upg', title: CONTENT.upgrades[u].text }, `${CONTENT.upgrades[u].name} (${CONTENT.upgrades[u].cost})`, h('button', { class: 'x', onclick: () => { sh.upgrades.splice(k, 1); render(); } }, '×'))),
          avail.length ? h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) { sh.upgrades.push(v); render(); } } }, h('option', { value: '' }, '+ upgrade'), ...avail.map(u => h('option', { value: u.id, title: u.text }, `${u.slot}: ${u.name} (${u.cost})`))) : null));
    }));
    ui.replaceChildren(h('div', { class: 'menu' }, h('div', { class: 'menu-card wide' },
      h('h2', {}, 'Squad builder'),
      h('div', { class: 'rowgap' },
        h('label', {}, 'Name', h('input', { value: squad.name, oninput: (e: Event) => (squad.name = (e.target as HTMLInputElement).value) })),
        h('label', {}, 'Faction', h('select', { onchange: (e: Event) => { squad = { ...squad, faction: (e.target as HTMLSelectElement).value, ships: [] }; render(); } }, ...Object.values(CONTENT.factions).map(f => h('option', { value: f.id, selected: f.id === squad.faction }, f.name))))),
      h('p', { class: squadCost(squad) > SQUAD_LIMIT ? 'err' : '' }, `${squadCost(squad)} / ${SQUAD_LIMIT} squad points`),
      list,
      h('label', {}, 'Add pilot', h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) { squad.ships.push({ pilotId: v, upgrades: [] }); render(); } } },
        h('option', { value: '' }, '+ pilot'), ...pilots.map(p => h('option', { value: p.id }, `${CONTENT.ships[p.shipId].name}: ${p.name}${p.standardLoadout ? ' [SL]' : ''} — I${p.initiative}, ${p.cost} pts`)))),
      errs.length && squad.ships.length ? h('ul', { class: 'err' }, ...errs.map(e => h('li', {}, e))) : null,
      h('div', { class: 'rowgap' },
        h('button', { class: 'primary', disabled: errs.length > 0, onclick: () => { saveCustom([...loadCustom().filter(s => s.name !== squad.name), squad]); back(); } }, 'Save squadron'),
        h('button', { onclick: back }, 'Cancel')))));
  };
  render();
}
