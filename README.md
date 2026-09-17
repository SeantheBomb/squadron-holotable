# Squadron Holotable

A free, open-source, browser-based tactical starfighter game: simultaneous hidden maneuver planning on a
holotable, then cinematic resolution. The rules engine implements a tabletop-accurate miniatures ruleset
(templates, arcs, range bands, dice, damage deck) on a 3 ft × 3 ft plane.

**Non-commercial fan project.** No purchases, ads or donations — ever. The engine in this repository
contains only original code, names, meshes and synthesized audio. Themed names/text/models live in
separate, optional *presentation packs* that overlay the engine at runtime and never change mechanics.
This project is not affiliated with or endorsed by any rights holder. If a rights holder objects to a
pack, the pack goes away and the engine carries on.

## Play modes
- **Versus AI** — three-layer bot (squad commander → per-pilot GOAP intent → simulation-based maneuver
  evaluation with exact dice math). Runs in a Web Worker, sees only a redacted view (never your dials).
- **Hotseat** — two players, one screen, with a hand-off screen for secret planning.
- **Online** — room codes; a Cloudflare Durable Object per match runs the rules, rolls dice and holds dials.

## Layout
| Package | What |
|---|---|
| `packages/rules` | Pure TypeScript rules engine: geometry, decision-driven state machine, abilities, redacted views |
| `packages/bot` | GOAP planner, dice math, evaluator, `npm run sim` tournament harness |
| `packages/client` | Babylon.js + Vite client: holotable planning, polar maneuver dial, action camera, dice tray |
| `packages/server` | Cloudflare Worker + Durable Object match server |

## Develop
```bash
npm install
npm test            # geometry + 60-game engine fuzz
npm run dev         # client on :5173
npm run dev:server  # match server on :8787 (wrangler dev)
npm run sim -- 40 ace veteran   # headless bot tournament
npx tsx packages/server/e2e.ts  # two-socket online game against the local server
```
The client loads a presentation pack from `?pack=<url>`, `localStorage['holotable-pack']`, `VITE_PACK_URL`,
or (dev only) a sibling `content-sw/pack.json`. `?pack=none` forces the neutral built-in content.

## Deploy (all free tier)
- Client: `npm run build` → Cloudflare Pages (`packages/client/dist`). Set `VITE_SERVER_URL` and `VITE_PACK_URL` at build time.
- Server: `npm run deploy -w @holotable/server`.

## Known gaps (v0.1)
Obstacles are auto-placed (rulebook has players place them); scenarios/objectives, devices (bombs/mines),
medium/large bases, and half-points scoring are not implemented yet. Template radii and the 40.5° arc
half-angle are community-measured values.

## Ground rules for contributors
No money. No storefronts. No trademarks in the project name, logo or domain. No film/game audio, card art,
publisher graphics or rulebook text in this repository. Write rules explanations in your own words.
