# Correspondence Mode — feasibility and scope

Assessment only. Nothing here is built. Measurements are from the current engine (24 bot-vs-bot
games, 235 rounds, 5,461 decisions) — reproduce with the script in "How the numbers were taken".

---

## 0. The short version

Three of the four asks are far closer than they look, and the fourth is the whole project.

| Ask | Reality |
|---|---|
| Storage for matches in progress | **Already done.** Each match is a Durable Object that writes to durable storage on every command, addressed by room code forever. A match already survives both players closing their browsers. |
| Accounts | Needed, but small — and the cheapest version needs no accounts at all. |
| Notifications | Needed, small, and free. |
| A correspondence rules variant | **The real work.** A naive port is unplayable, by a factor of about 35. |

The thing that makes this tractable: **the variant needs no changes to the rules engine.** See §3.

---

## 1. The measurement that decides everything

A naive "correspondence = the same game, but slowly" port costs each player:

| | median | mean | 90th pct | worst seen |
|---|---|---|---|---|
| decisions per **round** | **10** | 11.6 | 22 | 37 |
| decisions per **game** | **107** | 114 | 166 | 214 |

At one move a day, a single game takes **three to seven months**. That is not a correspondence
game, it is a pen pal. Every design decision below follows from this number.

Where the decisions go:

| Decision | Share | Can a policy answer it? |
|---|---|---|
| `action` (what to do after moving) | 28.7% | Partly — depends on where you ended up |
| `attack` (pick target and weapon) | 15.9% | Partly — depends on final positions |
| `planning` (set dials) | 12.9% | **No — this is the game.** Already simultaneous |
| `modifyAttack` / `modifyDefense` (spend focus, lock, evade) | 15.9% | **Yes** — depends only on the roll |
| `activateShip` / `engageShip` (order your own tied ships) | **16.7%** | **Yes, almost free** — a low-stakes tie-break |
| `ability` (use this card? yes/no) | 4.4% | **Yes** — always / never / ask, per card |
| `tallon` (which of 3 end positions) | 0.9% | Yes |

**A third of all decisions are ordering tie-breaks and dice modifiers** — mechanical choices that a
stated policy can answer with little or no loss of agency. That is the compression headroom.

---

## 2. The correspondence variant

The obstacle is not turn order, it is **information**. You cannot pre-commit an action without
knowing where your ship ended up, or a dice modifier without knowing the roll. So the variant has to
either give players that information earlier, or let them state a policy in advance.

Two candidate shapes:

### A. Conservative — 3 submissions per round

1. **Dials.** Both players submit simultaneously. Unchanged from the tabletop.
2. *Server resolves all movement* in initiative order. Ordering ties use a preset.
3. **Actions.** Each player sees the settled board and submits actions for **all** their ships at once.
4. **Attacks.** Each player declares every attack (target + weapon) plus a dice-modifier policy.
5. *Server resolves attacks* in initiative order, applying policies.

**10 decisions per round becomes 3.** A 12-round game is ~36 exchanges — a few weeks at a couple of
moves a day, which is normal for correspondence.

**What it changes about the game, honestly:** in the tabletop a ship moves *and acts* before higher
initiative ships have moved, so low-initiative pilots act half blind. Batching actions to after all
movement hands everyone perfect information and quietly devalues initiative, which is one of the
most important stats on the card. That is a real balance change, not a cosmetic one.

### B. Aggressive — 2 submissions per round

Merge steps 3 and 4: declare actions and attacks together ("focus, then shoot the lead TIE with
primary"). ~24 exchanges per game.

Costs more: you declare attacks before seeing the effect of your own actions, and any attack whose
ship dies first needs a stated fallback. I would not start here.

### Open rules questions either way
- A ship declares an attack, then is destroyed before its initiative step. Attack lost? (Simultaneous
  fire at equal initiative already exists in the rules and gives us a precedent to extend.)
- Do abilities that trigger "after you defend" get a policy, or a prompt?
- Ordnance is the sharp edge: spending a charge on a target that is already dead wastes it.

**Recommendation:** build A, keep live mode rules-faithful, and label the variant clearly so nobody
thinks it is the tabletop game.

---

## 3. The architecture win: no engine fork

The rules engine is already a deterministic state machine — `applyCommand(state, command)` answers
whatever `state.pending` asks, and `viewFor()` redacts per player. The bot already drives it by
answering prompts one at a time.

So a correspondence turn is just **the bot pattern with a human's policy**:

1. A player submits a *turn packet*: explicit choices where they can foresee the decision, plus
   policies where they cannot ("spend focus if it converts two or more results").
2. The server runs the engine forward, answering each `pending` from the packet.
3. It stops at the first decision the packet does not cover, and notifies whoever owns it.

**This needs zero changes to `packages/rules`.** Live and correspondence share one engine, so the
rules cannot drift apart. The variant lives in a policy layer above it.

Better still, `packages/bot` already contains principled dice-modification and action-valuation
logic, so the default policies are largely written — "let the flight computer decide" can be a real,
sensible option rather than a coin flip.

---

## 4. Accounts

Ranked by how little they cost to build and how little of a user's data they hold.

| Option | Cross-device | Holds PII | Notes |
|---|---|---|---|
| **Secret claim link** | Yes, if they keep the link | None | No accounts at all. Play-by-email model. Lose the link, lose the game. |
| **Passkey** | Awkward | None | No passwords, but recovery is hard and the flow confuses people. |
| **Discord OAuth** | Yes | Discord id + handle | Best fit for this community, and it solves notifications in the same stroke. |
| **Email magic link** | Yes | Email addresses | Needs a mail provider, and it is the only option that makes you a data controller over real contact details. |

There is also a **bug today**: the seat token lives in `sessionStorage`, which is cleared when the
tab closes. Even a live match cannot currently be rejoined from a fresh tab. Moving it to
`localStorage` is a one-line fix and is worth doing regardless of whether correspondence happens.

**Recommendation:** secret links first (no accounts, no PII, proves the plumbing), Discord OAuth as
the real answer. Avoid email.

---

## 5. Notifications

- **In-site "your turn" list** — free, needed regardless, and the only one that always works. Build first.
- **Web Push** — free, no PII, works on desktop browsers and on iOS when installed to the home
  screen. Needs a service worker and a permission prompt. This is the right default for a web game.
- **Discord** — strongest community fit. A bot can DM players who share a server with it, and it
  matches how this project already works. Comes free with Discord OAuth.
- **Email** — most friction, most obligation. Skip.

**Turn timers** ("you have three days to move") need a scheduler. Durable Object alarms do this and
are on the free tier, so timeouts and nudges are feasible without a cron host.

---

## 6. Storage and cost

Match state is already persisted per match. What is missing is that **Durable Objects cannot be
listed or queried** — they are addressed by id. So "what games am I in, and whose turn is it?"
needs an index: a D1 table of `match id, players, whose turn, last activity, status`. That is the
only new storage primitive required.

Replays come nearly free — the engine already emits a full event log per command.

**Correspondence is cheaper to run than live play.** A live match spends hundreds of WebSocket
messages, each counting against the Durable Object request budget; a correspondence move costs a
handful of HTTP requests. Free-tier limits (~100k requests/day, 5 GB storage) comfortably cover a
community of this size. *These figures came from research earlier in this project and should be
re-checked against Cloudflare's current published limits before anyone relies on them.*

The hard constraint is not technical: **staying non-commercial means never accepting donations for
hosting.** If usage ever outgrows the free tier, it comes out of your pocket or it stops. That caps
the ambition on purpose.

---

## 7. What an ecosystem costs (the chess.com / OGS question)

| Feature | Cost | Notes |
|---|---|---|
| Match list / "your turn" dashboard | Small | Needed anyway |
| Replays and game archive | **Small** | The event log already exists |
| Spectating | Small | Redacted views already exist |
| Profiles | Small | Once identity exists |
| Open challenges / seeks | Medium | A lobby queue plus matchmaking rules |
| Ratings / ladder | Medium | See the caveat below |
| Tournaments | Large | Brackets, scheduling, dropouts |
| Moderation | **Ongoing human cost** | Accounts mean usernames, and usernames mean someone will eventually type something vile |

**The ratings caveat.** The AI ships inside the client. Anyone can ask it for the best move, and
nothing can stop them — this is correspondence chess's engine problem with none of the enforcement.
Chess.com and OGS ban engine use and invest heavily in detection. That is not an option here. So
either ratings are understood as casual and unpoliced, or there are no ratings. I would be upfront
about it rather than pretend.

---

## 8. Risk posture

Accounts and a persistent service change how this project looks. The research earlier in this
project found that the fan games Lucasfilm shut down were distinguished by standalone distribution,
storefront presence and press visibility. A community site with accounts and ladders raises
visibility, which was one of those factors.

Mitigations, all cheap:
- Minimise data held — Discord ids or nothing, never real names or emails.
- A short privacy note and a working "delete my account and my games" path.
- Keep the fan-project disclaimer prominent on the new surfaces too, not just the landing page.
- Keep the name and domain free of trademarks, as now.
- Still no money, ever — including "help with server costs".

---

## 9. Suggested phasing

| Phase | Deliverable | Size |
|---|---|---|
| **0** | `localStorage` seat tokens + rejoin-by-URL. Fixes live play too. | Hours |
| **1** | Secret claim links + async turns on the **existing** rules. Proves the plumbing end to end. Only playable by the very patient — that is the point, it is a test. | Small |
| **2** | **The correspondence variant** (§2A) as a policy layer. The bulk of the design and playtesting work. | **Large** |
| **3** | D1 match index + in-site "your turn" dashboard. | Medium |
| **4** | Web Push, then Discord OAuth and DMs. Turn timers on Durable Object alarms. | Medium |
| **5** | Replays, profiles, open challenges. Ratings only if §7 is acceptable. | Medium+ |

Phases 0 and 1 are worth doing even if correspondence is abandoned, since they fix real gaps in the
live game.

---

## How the numbers were taken

24 bot-vs-bot games at ace difficulty across the four preset squads, counting every `pending`
decision by owner, round and kind. The script drives the public engine API only
(`createGame` / `applyCommand`) and is reproducible in `packages/bot`.
