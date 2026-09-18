// Hangar: mode select, squad selection/builder, online lobby.
import { CONTENT, PRESET_SQUADS, SQUAD_LIMIT, squadCost, validateSquad } from '@holotable/rules';
import type { Squad } from '@holotable/rules';
import type { BotOptions } from '@holotable/bot';
import type { LobbyState, RemoteSession } from './session';
import { h } from './hud';
import { activePack, importXws } from './pack';
import { sfx } from './audio';
import * as Acct from './account';

export type Launch =
  | { mode: 'bot'; squads: [Squad, Squad]; bot: BotOptions; name: string }
  | { mode: 'hotseat'; squads: [Squad, Squad] }
  | { mode: 'online'; server: string; code: string; name: string; squad: Squad };

const CUSTOM_KEY = 'holotable-squads';
const loadCustom = (): Squad[] => { try { return JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]'); } catch { return []; } };
const saveCustom = (s: Squad[]) => { try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(s)); } catch { /* ignore */ } };
export const allSquads = (): Squad[] => [...(activePack?.squads ?? []), ...PRESET_SQUADS, ...loadCustom()].filter(s => !validateSquad(s).length);

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
            try { go(await Acct.createRoom('live')); }
            catch (e: any) { status = e?.message ?? 'Could not reach the match server.'; render(); }
          } }, 'Create room'),
          h('input', { placeholder: 'ROOM CODE', maxlength: 5, class: 'code', value: code, oninput: (e: Event) => (code = (e.target as HTMLInputElement).value) }),
          h('button', { onclick: () => (code.trim().length === 5 ? go(code.trim()) : (status = 'Room codes are 5 characters.', render())) }, 'Join')),
        h('p', { class: 'hint' }, status || 'Create a room and send the code to your opponent. Dice and hidden dials are handled by the server.'));
    }

    ui.replaceChildren(h('div', { class: 'menu' },
      h('div', { class: 'menu-card' },
        accountBar(ui, render),
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
          h('button', { onclick: () => showCredits(ui, render) }, 'Credits & legal'),
          h('button', { onclick: () => (location.href = '/#first-game') }, 'How to play')),
        h('p', { class: 'disclaimer' }, 'Unofficial, non-commercial fan project. Not affiliated with or endorsed by any rights holder. All trademarks belong to their respective owners.'))));
  };
  render();
}


/** Pre-match room: both sides choose a squadron, see each other's, and ready up. */
export function showLobby(ui: HTMLElement, session: RemoteSession, code: string, onLeave: () => void) {
  const sq = allSquads();
  let picked = Math.max(0, sq.findIndex(s => s.name === (session.lobby?.seats[session.lobby.you]?.squad ?? '')));
  let ready = false;
  let started = false;

  const render = (l: LobbyState | null) => {
    if (started) return;
    if (l?.started) { started = true; return; } // the Game takes the screen from here
    const you = l?.you ?? 0;
    const seats = l?.seats ?? [];
    const mine = seats[you], theirs = seats[1 - you];
    const clash = !!(mine?.faction && theirs?.faction && mine.faction === theirs.faction);

    const seatRow = (seat: typeof mine, label: string, isYou: boolean) => h('div', { class: `seat${seat?.ready ? ' ready' : ''}` },
      h('div', { class: 'seat-who' }, h('b', {}, seat?.name ?? 'Waiting for a pilot…'), h('small', {}, label)),
      h('div', { class: 'seat-squad' },
        seat?.squad ? h('span', {}, seat.squad, h('em', {}, ` ${seat.faction ? CONTENT.factions[seat.faction]?.name ?? seat.faction : ''}`)) : h('span', { class: 'dim' }, isYou ? 'Choose a squadron' : 'Choosing…')),
      h('div', { class: 'seat-state' }, seat ? (seat.ready ? 'READY' : 'Not ready') : ''));

    ui.replaceChildren(h('div', { class: 'menu' }, h('div', { class: 'menu-card' },
      h('h2', {}, 'Room ' + code),
      h('p', { class: 'hint' }, theirs ? 'Both pilots choose a squadron, then ready up.' : 'Send this code to your opponent. The battle starts when you are both ready.'),
      h('div', { class: 'bigcode' }, code),
      h('div', { class: 'seats' }, seatRow(mine, 'you', true), seatRow(theirs, 'opponent', false)),
      clash ? h('p', { class: 'warn-line' }, `Both squadrons are ${CONTENT.factions[mine!.faction!]?.name ?? mine!.faction}. That is legal, but the two sides will look alike — consider switching.`) : null,
      h('label', {}, 'Your squadron', h('select', {
        disabled: ready,
        onchange: (e: Event) => { picked = Number((e.target as HTMLSelectElement).value); session.setSquad(sq[picked]); },
      }, ...sq.map((s, i) => h('option', { value: i, selected: i === picked }, `${s.name} — ${CONTENT.factions[s.faction]?.name ?? s.faction} (${squadCost(s)} pts)`)))),
      h('ul', { class: 'squadlist' }, ...sq[picked].ships.map(sh => {
        const p = CONTENT.pilots[sh.pilotId];
        const ups = (p.standardLoadout ?? sh.upgrades).map(u => CONTENT.upgrades[u].name).join(', ');
        return h('li', {}, h('b', {}, `${p.initiative} · ${p.name}`), ` ${CONTENT.ships[p.shipId].name}`, ups ? h('small', {}, ` — ${ups}`) : null);
      })),
      h('div', { class: 'rowgap' },
        h('button', {
          class: ready ? 'primary big on' : 'primary big', style: { flex: '2' },
          onclick: () => { ready = !ready; sfx.click(); session.setReady(ready); render(session.lobby); },
        }, ready ? 'Ready — waiting…' : 'Ready up'),
        h('button', { onclick: onLeave }, 'Leave')))));
  };

  session.onLobby(l => render(l));
  // Publish the opening pick so the opponent sees a squadron straight away.
  if (sq[picked]) session.setSquad(sq[picked]);
  render(session.lobby);
}


// ---------------- accounts ----------------

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

/** The strip at the top of the hangar: who you are, or a way to become someone. */
function accountBar(ui: HTMLElement, back: () => void): HTMLElement {
  if (!Acct.signedIn()) {
    return h('div', { class: 'acctbar' },
      h('span', { class: 'dim' }, 'Playing as a guest'),
      h('button', { class: 'chip', onclick: () => showAccount(ui, back) }, 'Sign in / create account'));
  }
  return h('div', { class: 'acctbar' },
    h('span', {}, 'Signed in as ', h('b', {}, Acct.account!.username)),
    h('div', { class: 'rowgap' },
      h('button', { class: 'chip', onclick: () => showGames(ui, back) }, 'My games'),
      h('button', { class: 'chip', onclick: () => showAccount(ui, back) }, 'Account')));
}

export function showAccount(ui: HTMLElement, back: () => void) {
  let mode: 'in' | 'up' = Acct.signedIn() ? 'in' : 'up';
  let busy = false, error = '', note = '';

  const render = () => {
    if (Acct.signedIn()) {
      const a = Acct.account!;
      ui.replaceChildren(h('div', { class: 'menu' }, h('div', { class: 'menu-card' },
        h('h2', {}, 'Account'),
        h('p', {}, 'Signed in as ', h('b', {}, a.username)),
        h('label', {}, 'Email (optional)',
          h('input', { id: 'acct-email', type: 'email', value: a.email ?? '', placeholder: 'none' })),
        h('p', { class: 'hint' }, 'Only ever used to reset your password and to tell you it is your turn. Leave it blank and we will not ask again — you can still get turn alerts in the browser.'),
        note ? h('p', { class: 'ok-line' }, note) : null,
        error ? h('p', { class: 'err' }, error) : null,
        h('div', { class: 'rowgap' },
          h('button', { class: 'primary', onclick: async () => {
            const v = (document.getElementById('acct-email') as HTMLInputElement).value.trim();
            try { await Acct.updateEmail(v || null); a.email = v || null; note = 'Saved.'; error = ''; }
            catch (e: any) { error = e.message; note = ''; }
            render();
          } }, 'Save'),
          h('button', { onclick: async () => { await Acct.signOut(); back(); } }, 'Sign out'),
          h('button', { onclick: back }, 'Back')),
        h('hr'),
        h('p', { class: 'hint' }, 'Deleting your account removes your sign-in, your email if you gave one, and your turn alerts. Games you played stay, with your seat unclaimed.'),
        h('button', { class: 'danger', onclick: async () => {
          if (!confirm('Delete your account? This cannot be undone.')) return;
          await Acct.deleteAccount(); back();
        } }, 'Delete my account'))));
      return;
    }

    const field = (id: string, label: string, type = 'text', placeholder = '') =>
      h('label', {}, label, h('input', { id, type, placeholder, autocomplete: type === 'password' ? (mode === 'up' ? 'new-password' : 'current-password') : 'username' }));

    const submit = async () => {
      if (busy) return;
      const u = (document.getElementById('acct-user') as HTMLInputElement).value.trim();
      const p = (document.getElementById('acct-pass') as HTMLInputElement).value;
      const e = mode === 'up' ? (document.getElementById('acct-mail') as HTMLInputElement).value.trim() : '';
      busy = true; error = ''; note = 'Working…'; render();
      try {
        if (mode === 'up') await Acct.register(u, p, e || undefined); else await Acct.signIn(u, p);
        back();
      } catch (err: any) { error = err.message; note = ''; busy = false; render(); }
    };

    ui.replaceChildren(h('div', { class: 'menu' }, h('div', { class: 'menu-card' },
      h('h2', {}, mode === 'up' ? 'Create an account' : 'Sign in'),
      h('p', { class: 'hint' }, 'You only need an account for correspondence games. Live and solo play never ask for one.'),
      h('div', { class: 'tabs' },
        h('button', { class: `tab${mode === 'up' ? ' on' : ''}`, onclick: () => { mode = 'up'; error = ''; render(); } }, 'Create'),
        h('button', { class: `tab${mode === 'in' ? ' on' : ''}`, onclick: () => { mode = 'in'; error = ''; render(); } }, 'Sign in')),
      field('acct-user', 'Username'),
      field('acct-pass', 'Password', 'password'),
      mode === 'up' ? field('acct-mail', 'Email (optional)', 'email', 'leave blank if you prefer') : null,
      mode === 'up' ? h('p', { class: 'hint' }, 'No email means no password reset — if you forget it, the account is gone. Your password is scrambled in this browser and never sent.') : null,
      note ? h('p', { class: 'ok-line' }, note) : null,
      error ? h('p', { class: 'err' }, error) : null,
      h('div', { class: 'rowgap' },
        h('button', { class: 'primary', disabled: busy, onclick: submit }, mode === 'up' ? 'Create account' : 'Sign in'),
        h('button', { onclick: back }, 'Back')))));
    const u = document.getElementById('acct-user') as HTMLInputElement | null;
    u?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') submit(); });
    (document.getElementById('acct-pass') as HTMLInputElement | null)?.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') submit(); });
  };
  render();
}

/** Every match this account is in, the ones waiting on you first. */
export function showGames(ui: HTMLElement, back: () => void, onOpen?: (code: string) => void) {
  let rows: Acct.MatchSummary[] | null = null, error = '';

  const render = () => {
    const list = rows === null
      ? [h('p', { class: 'hint' }, 'Loading…')]
      : rows.length === 0
        ? [h('p', { class: 'hint' }, 'No games yet. Start a correspondence match and it will show up here.')]
        : rows.map(m => {
          const them = (m.you === 0 ? m.p1_name : m.p0_name) ?? 'waiting for an opponent';
          return h('div', { class: `gamerow${m.yourTurn ? ' yours' : ''}` },
            h('div', {},
              h('b', {}, `vs ${them}`),
              h('small', {}, ` ${m.mode === 'correspondence' ? 'correspondence' : 'live'} · ${m.status === 'lobby' ? 'not started' : m.status === 'over' ? 'finished' : `round ${m.round}`} · ${ago(m.updated_at)}`)),
            h('div', { class: 'gamerow-state' },
              m.status === 'over' ? 'Finished'
                : m.status === 'lobby' ? (them === 'waiting for an opponent' ? 'Waiting for an opponent' : 'Getting ready')
                : m.yourTurn ? 'YOUR TURN' : 'Their turn'),
            h('button', { class: m.yourTurn ? 'primary' : '', onclick: () => onOpen?.(m.code) }, m.status === 'over' ? 'Review' : 'Open'));
        });

    ui.replaceChildren(h('div', { class: 'menu' }, h('div', { class: 'menu-card wide' },
      h('h2', {}, 'My games'),
      error ? h('p', { class: 'err' }, error) : null,
      h('div', { class: 'gamelist' }, ...list),
      h('div', { class: 'rowgap' }, h('button', { onclick: back }, 'Back')))));
  };
  render();
  Acct.myMatches().then(m => { rows = m; render(); }).catch(e => { error = e.message; rows = []; render(); });
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
