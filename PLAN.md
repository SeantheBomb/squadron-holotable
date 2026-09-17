# Project Plan — Fan-Made Tactical Starfighter Game (X-Wing 2.5 rules, XCOM-style presentation)

Working codename: **"Squadron Holotable"** (placeholder — final name must not contain "Star Wars" or "X-Wing").
Scope of this plan: basic PvP + PvBot dogfight. Scenarios deferred.
Source rules: AMG Core Rulebook 10/30/2023 (the PDF provided — this is the "2.5" ruleset: 20-pt squads, loadout values, random first player each round).

---

## 0. The honest headline

**"100% legal" is not achievable with Star Wars ships and card text.** Nobody but Lucasfilm can grant rights to those designs, and there is no published fan-game policy. What *is* achievable is the same tolerated status that Fly Casual, YASB, the TTS mod, Vassal, and the X-Wing Alliance (XWA) have held for years with zero documented C&Ds. The plan below is built so that:

1. The **engine** (rules, renderer, netcode, bot) is 100% original, clean, MIT-licensed, and contains no Lucasfilm/AMG IP — it can never be legitimately taken down.
2. The **Star Wars layer** is a separable content pack. If a notice ever arrives, the pack goes away and the project survives.

Everything else flows from that split.

---

## 1. Recreating the gameplay faithfully, reimagined as a video game

### 1.1 Principle: tabletop truth underneath, cinema on top
Game mechanics aren't copyrightable; the rulebook's wording is. We implement the *mechanics* exactly and write all our own tooltip/help text.

The simulation is the literal tabletop: a 914×914 mm 2D plane, rectangular bases, maneuver templates, range ruler. The 3D presentation is a skin over it. A **"Tabletop Truth" toggle** shows bases, templates, arcs and the ruler at any time so competitive players can trust it.

### 1.2 Rules engine (pure TypeScript, zero rendering deps)
One package, `@game/rules`, used identically by the client, the multiplayer server, and the bot.

- **Deterministic state machine**: Setup → [Planning → System → Activation → Engagement → End] ×12. State is a plain serializable object; every change is a `Command` (player intent) producing `Event`s (what happened). Event log = replays, reconnects, spectating, bot simulation, and bug reports for free.
- **Seeded RNG injected from outside** — server owns dice in multiplayer.
- **Geometry module** (the part that must be exact):
  - Small base 40 mm (medium 60 / large 80 later). Range bands 100 mm each. Template width 20 mm.
  - Straights: 40 mm × speed. Banks: 45° arcs, centerline radii ≈ 80/130/180 mm. Turns: 90° arcs, radii ≈ 35/62.5/90 mm. *(Community-measured values — verify against Fly Casual (MIT) and TTS mod (GPL) sources in M1.)*
  - Oriented-rectangle SAT for base overlap; swept-template polygon for "moved through"; polygon obstacles.
  - Partial maneuver = walk back along template centerline until clear, place touching (rulebook p.13).
  - Range = closest-point-to-closest-point; attack range = closest point *in arc*; obstruction = ruler line crosses obstacle.
  - Barrel roll (3 end positions × 2 sides), boost (3 templates), K-turn, Tallon roll (3 end positions), Segnor's loop, stationary, reverse.
- **Attack pipeline** exactly per quick-reference: declare → attack dice → defender mods → attacker mods → defense dice → attacker mods → defender mods → neutralize (hits before crits) → damage (shields, then facedown/faceup cards) → aftermath. Range bonuses, range-0 restrictions, simultaneous fire at equal initiative.
- **Tokens/states**: focus, evade, calculate, lock, stress, strain, ion (with ion maneuver), disarm, charges, Force. Damage deck with crit effects.
- **Ability system**: timing windows (`afterExecuteManeuver`, `whileAttacking.modifyDice`, …) as hook points; each card ability is a small script registered against hooks. Stats/dials/costs are data; abilities are code. Player-order resolution queue for simultaneous triggers.
- **Obstacles**: asteroid / debris / gas cloud effects per p.16.

### 1.3 MVP content (matches the starter set in the rulebook)
T-65 X-wing, BTL-A4 Y-wing, TIE/ln, TIE Advanced x1. Generic pilots + ~6 named pilots (Luke, Vader, Valen Rudor, etc.), ~10 upgrades (Proton Torpedoes, Ion Missiles, Shield Upgrade, Afterburners, Elusive, Instinctive Aim…). Enough to exercise every engine system: Force, charges, locks, special weapons, linked actions, turret (Y-wing ion turret).

**MVP win condition** (scenarios deferred): "Dogfight" — mission points = squad-point value of destroyed ships + opponent's deficit; first to 20 at end phase, or most after round 12, or last squad standing. This is the scoring skeleton all four standard scenarios share, so scenarios bolt on later without rework.

**Squad import**: accept XWS JSON (the format YASB / Launch Bay export). We don't need to build a squad builder for v1 — paste a YASB link/XWS and play. Ship a few preset squads for instant play.

### 1.4 The XCOM / Zero Company reimagining
| Tabletop moment | Video game treatment |
|---|---|
| Setting dials in secret | **Holotable planning view**: select ship → **radial dial menu** (echoes Zero Company's radial) with blue/white/red maneuvers → ghost ship previews the end position, arc, and range bands. Both players plan simultaneously; a "locked in" indicator replaces facedown dials. Optional planning timer. |
| "Did I judge that right?" | Tabletop forbids pre-measuring; that *is* the skill. Setting: **Pure** (no ghost, only dial) vs **Assisted** (ghost preview of own move only, never collision results). Ranked/default = decided by you; I recommend Assisted for onboarding, Pure as an option. |
| Activation | Camera leaves the holotable and ships **actually fly the template path** — banking into turns, engine trails, K-turn as a real half-loop, Tallon as a snap roll. Bumps = near-miss swerve + shield flash. Asteroid hits = debris burst. |
| Actions | Radial menu again; barrel roll/boost show the 3 (or 6) legal ghosts, illegal ones greyed with reason. |
| Engagement | Target select shows arc cone + range ruler + obstruction line. Fire → **skippable action camera** (frequency setting Off→Always, per ZC; Kotaku dinged ZC for janky un-skippable cams). **Dice are always shown** — rendered as a targeting-computer readout, with modification steps (spend focus / lock reroll / Force) as explicit prompts in rulebook order. Never hide the math. |
| Damage cards | Crits surface as ship subsystem failures on the ship's status panel with the card's effect. |
| 2D rules in a 3D world | Ships render at slight cosmetic altitude offsets so overlaps-through look like passes, not clips. All logic stays planar. |

---

## 2. Ethically sourcing ship models

**Reality check:** a CC license from a fan modeler covers *their mesh/texture labor only*. It grants nothing in Lucasfilm's underlying ship design. There is no CC0/open Star Wars model library. "Ethical" here therefore means: (a) respect the modeler's license and credit them, (b) never use game rips, (c) never imply we own or license the designs.

### Approach (recommended)
1. **Engine repo ships with original, non-Star-Wars placeholder fighters** (simple original designs — I can generate/greybox these; or CC0 sci-fi kits from Quaternius/Kenney). The game is fully playable with them under generic names.
2. **Star Wars content pack** = separate repo: glTF models + pilot/upgrade names & ability text + icon font. Loaded by URL at runtime. Hosted deployment points at it by default so players get the full experience with zero setup.
3. **Candidate models** (all CC-BY, Sketchfab auto-provides glTF): the **DanielAndersson set** — X-Wing (59k faces), TIE/ln (90k), Y-Wing (53k), TIE Interceptor, A-Wing, B-Wing, TIE Defender, TIE Phantom, plus CR-90/Gozanti — one author = consistent art style across the fleet. TIE Advanced x1: mariusaskvik (83k, CC-BY). Links in research notes.
   - **Before adopting: verify provenance** (confirm original work, not a rip/port) and message the authors — a courtesy ask also buys goodwill and an explicit OK.
   - **Avoid**: anything NC/NC-SA-licensed if we want clean MIT-adjacent terms, anything tagged from SW Galaxies/Battlefront/Squadrons (rips), and X-Wing Alliance Upgrade assets (explicitly no redistribution/modification).
4. **Pipeline**: Blender decimate to ~15–25k tris, bake normals, meshopt/Draco + KTX2 textures, target <2 MB per ship (Cloudflare Pages cap is 25 MiB/file; we'll be nowhere near). `CREDITS.md` + in-game credits screen with author, link, license for every asset (CC-BY requirement).
5. **Longer term**: invite community modelers to contribute original-mesh versions under CC-BY to the pack repo — this is how XWAU and the TTS mod built their fleets.

---

## 3. Building and sharing it free, with minimum shutdown risk

### What history says
Shut down: *Galaxy in Turmoil*, *KOTOR Apeiron* — both **standalone full games, high press visibility, storefront presence (Steam), remaking a commercial title, and competing with a live licensee (EA)**. Being free did not save them.
Tolerated for years: Fly Casual (MIT, even ran a Patreon), YASB, TTS mod, Vassal, XWA — low-profile community tools for a tabletop game. **The licensee that might have cared (AMG) ended the product line June 2024.** No documented C&D against any free X-Wing fan tool.

We are a standalone game, so we sit closer to the risk line than YASB does. Mitigations:

| Rule | Why |
|---|---|
| **No money, ever.** No Patreon, Ko-fi, ads, paid tiers, merch. | The brightest line. (Fly Casual's Patreon was its biggest exposure.) |
| **No storefronts.** No Steam, no itch.io, no app stores. GitHub + our own static site only. | Storefront listing was the common factor in takedowns. |
| **No trademarks in name, logo, domain, repo name.** Describe as "fan-made, compatible with X-Wing 2.5 rules" in body text only. | Trademark is the most enforceable claim. |
| **Engine/content split** (§2). Engine repo has zero Lucasfilm/AMG material. | A takedown can only ever hit the pack. Engine, netcode, bot survive. |
| **No film music, no film/game audio, no card art, no FFG/AMG graphics, no rulebook text.** Original SFX & score (or CC0/CC-BY). | John Williams cues and card art are the fastest DMCA magnets and add nothing we can't replace. |
| **Card text lives only in the pack**, sourced from `xwingtmg/xwing-data2` (MIT wrapper, but the text itself belongs to AMG/LFL — same posture YASB has held since 2018). | Keeps engine clean. |
| **Prominent disclaimer** (site footer, README, title screen): unofficial, non-commercial, not affiliated with/endorsed by Lucasfilm, Disney, AMG, Asmodee, FFG; all trademarks theirs. | Standard across every surviving project. |
| **Don't court press.** Share via XWA Discord, r/XWingTMG, community channels. No "Star Wars fan game!" press releases. | Visibility was a takedown factor. |
| **Comply instantly** if contacted: pull the pack, keep the engine. Documented in the repo up front. | Turns worst case into a content swap, not project death. |
| Align with **XWA** (community rules stewards) — offer it as their online play client; support their points. | Community legitimacy; they're the natural distribution channel. |

Licenses: engine **MIT**. Content pack: per-asset (CC-BY models credited individually), no license claimed over Lucasfilm material.

### Hosting — $0
- **Cloudflare Pages** for the static client (you already have Wrangler set up).
- **One Durable Object per match** (free tier since Apr 2025: 100k req/day incl. WebSocket messages, hibernating sockets). A full game is a few hundred messages → tens of thousands of games/day headroom.
- Fallback if we ever outgrow it: Trystero WebRTC P2P (zero server) with host-authoritative state. Not the default — no free TURN means some players can't connect, and no neutral dice roller.

---

## 4. Architecture

```
packages/
  rules/     pure TS — state, commands, events, geometry, abilities, dice math. No DOM, no engine.
  bot/       GOAP + simulation planner. Depends only on rules.
  client/    Babylon.js + Vite. Renders state, animates events, sends commands.
  server/    Cloudflare Worker + Durable Object. Runs rules authoritatively.
  content-placeholder/   original ships, generic pilots (in engine repo)
(separate repo) content-sw/   the Star Wars pack
```

- **Browser-first: yes.** Turn-based + ≤16 ships + low-poly-ish models is trivially within WebGL2. **Godot isn't needed** — and would cost us the single biggest win: the same TypeScript rules package running in client, server, and bot. Keep Godot as the fallback only if browser rendering quality disappoints.
- **Renderer: Babylon.js** (recommended over Three.js): batteries-included — glTF, PBR, particle systems, GUI, glow/bloom pipeline, inspector, WebGPU path. Closer to the Unity workflow you know. Three.js is the alternative if you'd rather have the bigger ecosystem and hand-assemble.
- **Multiplayer protocol**: client sends `Command`s; DO validates via `rules`, rolls dice, appends `Event`s, broadcasts. **Hidden info**: dials are held server-side and only revealed in events at activation — the client never receives the opponent's dial early, so no cheating via devtools. Room codes, no accounts. Reconnect = replay event log. Per-phase timers optional.
- **PvBot**: the bot implements the same `Player` interface as a remote human. Runs in a **Web Worker** locally (offline play, zero server cost).
- **Testing**: rules package gets heavy unit tests (geometry golden cases from rulebook diagrams) + **bot-vs-bot headless fuzzing** — thousands of full games per minute asserting invariants (no overlapping bases, token conservation, no stuck states).

---

## 5. The GOAP bot

### Honest framing
Classic GOAP (F.E.A.R.-style) plans action *sequences* toward a goal. X-Wing's hard problem is different: **one simultaneous hidden commitment per ship per round** (the dial), evaluated under uncertainty about where enemies will end up. Pure GOAP is a poor fit for the dial choice; it's a great fit for *intent*. So: **GOAP for what the ship is trying to do, simulation + utility for how.**

### Three layers
1. **Squad Commander (GOAP, per round)** — world-state facts (health ratios, points lead, round number, who out-initiatives whom, ordnance remaining) → squad goals: `FocusFire(target)`, `Joust`, `Flank`, `Disengage&Reset`, `ProtectDamagedAce`, `RunTheClock` (when ahead on points late). Assigns each ship a role + priority target. This is what makes it feel like *one mind* running a squad instead of N independent ships — target persistence, formation flying early, committing together.
2. **Pilot Planner (GOAP, per ship)** — goals from role: `GetShotOn(target)`, `DenyShots`, `GetLock→FireTorpedo`, `ClearStress`, `AvoidObstacle/Edge`, `BlockEnemy(lane)`. Actions are the real game verbs with preconditions/effects: `ExecuteManeuver(m)`, `Focus`, `Lock`, `BarrelRoll(pos)`, `Boost(dir)`, `Evade`, `Reload`. Plans span **this round + next** (e.g. "red K-turn now → blue straight next to clear stress and have a shot"; "lock this turn → torpedo next"). That 2-round chaining is where GOAP genuinely earns its keep.
3. **Maneuver Evaluator (simulation + utility)** — costs for the planner's `ExecuteManeuver` actions come from here:
   - Enumerate own dial (~15–20 maneuvers) × follow-up reposition actions using the real `rules` geometry.
   - **Belief model of enemies**: for each enemy, a probability distribution over *its* dial, weighted by simple heuristics (players turn toward targets, avoid rocks, stressed ships pick blues). Bot **never reads the human's dial** — it gets the same information a human would.
   - Score each candidate: Σ over enemy-position samples of (expected damage dealt − expected damage taken × self-preservation weight) + positional terms (arc coverage next round, obstacle/edge risk, bump risk/block value, range-1/range-3 bonuses).
   - **Exact dice math**: closed-form expected damage for N red vs M green with focus/lock/evade/Force — precomputed tables. Also drives in-attack decisions (spend focus now or save for defense? which dice to reroll?).
   - Initiative-aware: low-init ships move first → value blocking and conservative positions; high-init aces move last → value reactive repositioning.

### Feeling human
- **Personalities** = weight vectors (aggressive jouster, cagey flanker, ace-protector). Rookie / Veteran / Ace difficulty = belief-model depth + noise + lookahead (1 vs 2 rounds), *not* dice cheating.
- Target persistence with hysteresis (doesn't flip targets every round), occasional deliberate "reads" (predicting your K-turn), small thinking delays, sensible obstacle/ship placement heuristics at setup.
- Tuned and regression-tested via the headless bot-vs-bot harness; personalities play round-robins and we track win rates.

---

## 6. Making it feel like a high-quality, intentional Star Wars experience

- **Art direction: "holotable → cockpit cinema."** Planning happens on a blue holographic tactical table (the briefing-room look; also Zero Company's in-universe UI language). Lock in → the hologram "resolves" into full-color space and the round plays out cinematically. That single transition is the identity of the game.
- **UI**: diegetic targeting-computer styling, amber/blue/red palette by faction, Aurebesh as decorative accent only (never for information). Radial menus. Ship status panels that look like cockpit MFDs.
- **Space that isn't empty**: HDR skybox (original/CC0 — planet limb, nebula, distant capital-ship silhouettes as set dressing), volumetric-look gas clouds, tumbling 3D asteroids, debris fields from wrecked ships.
- **VFX**: faction-colored bolts with bloom, shield-bubble impact ripples, ion crackle on ionized ships, proton torpedo trails, staged explosions (flash → fireball → debris), engine glow scaling with maneuver speed.
- **Audio**: all-original sound design in the *style* (layered synth/animal/mechanical approach) — no sampled film audio. Original or CC-licensed orchestral score with adaptive layers (planning = tense low strings, engagement = brass). Audio is 50% of "feels like Star Wars" and 90% of the DMCA risk, so we do it ourselves.
- **Pilot presence**: text-only radio chatter barks on events ("I can't shake him!") — original lines, no voice cloning, no actor likenesses.
- **Respect the player's time**: every animation skippable, action-cam frequency slider, 2× speed toggle, full event log panel, Tabletop Truth overlay.
- **Onboarding**: a guided first match vs the Rookie bot teaches the five phases — most players will be lapsed tabletop players, but ZC fans arriving cold need it.

---

## 7. Milestones

| # | Deliverable | Proves |
|---|---|---|
| **M0** | Monorepo, Vite, CI, MIT license, disclaimer, Pages deploy of empty shell | Pipeline |
| **M1** | `rules` geometry + movement; 2D debug canvas: fly every maneuver, bumps, obstacles, arcs, range | The hard math is right |
| **M2** | Full round loop, hotseat, 4 ships w/ generic pilots, dice, tokens, damage deck, Dogfight scoring | It's X-Wing |
| **M3** | Babylon 3D client: holotable planning, animated activation, attack flow, placeholder ships | It's a video game |
| **M4** | Durable Object multiplayer: rooms, hidden dials, server dice, reconnect | PvP |
| **M5** | Bot: evaluator → pilot GOAP → squad GOAP; Web Worker; headless sim harness | PvBot |
| **M6** | Ability hooks, named pilots, upgrades, XWS import, content-pack loader + SW pack repo with vetted models | The real game |
| **M7** | Cinematics, VFX, audio, onboarding, credits → quiet community release (XWA Discord) | Quality bar |
| Later | Standard scenarios, medium/large ships, more factions, spectating/replays, Discord match-result webhook | — |

M1–M2 are the foundation; nothing visual gets built until the rules engine passes its geometry tests.

---

## 8. Decisions needed from you

1. **Engine/content split** (§0, §2) — approve? It's the core risk strategy and shapes the repo from day one.
2. **Renderer**: Babylon.js (recommended) vs Three.js.
3. **Points/format**: rulebook is AMG 2.5 (20-pt). Data layer will be pluggable, but which is the *default* — final AMG points, or XWA's current community points (50-pt system, actively maintained)? I lean AMG 2.5 as shipped in your PDF for v1, XWA as a toggle at M6.
4. **Planning assist** default: Assisted (ghost preview of own move) vs Pure (dial only, like the table).
5. **Codename/name** — anything trademark-free. "Squadron Holotable" is a placeholder.
6. OK to start **M0 + M1** on approval?
