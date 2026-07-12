# ELEVENS — Session Handoff / Full Context

> Paste-able context for continuing development in a fresh session.
> Repo: https://github.com/Dranzo-Techlabs-LLP/elevens (public — assets must be redistribution-safe)
> Owner: Shimil (mohamed.shimil@dranzo.com), org Dranzo Techlabs LLP.

## 1. Product vision

Mobile-first football game where **every human controls exactly ONE player**
(no player switching — the core difference from PES). Teams of real humans,
rooms by 4-letter code, bots fill empty slots. Benchmark for feel/graphics:
**eFootball/PES broadcast gameplay** (user-supplied reference video:
"SPAIN vs BELGIUM — eFootball PES Gameplay").

## 2. Two generations in one repo (A/B, both work)

### Legacy 2.5D game (feature-complete, deployed-ready)
- `public/index.html` + `src/client/*` (three.js render of a 2D sim) +
  `src/server/room.ts` (custom 2.5D physics, PES action set)
- Run: `npm run dev` → http://localhost:3011 (esbuild watch + tsx watch)
- Prod: `npm run build` (build.mjs → app.js + public/) — cPanel/Passenger
  ready (`DEPLOY.md`), PORT env supported.
- Has: rooms/lobby/rematch, selfie avatars (camera + webcam modal + gallery),
  PES buttons, 4 cameras w/ camera-relative input, ping HUD, ws heartbeat.

### 3D sim-grade game (current focus — "the game")
- Client `play3d.html` + `src/game3d/*`, served by **Vite** (`npm run lab`,
  port 5173/5175). Server: same Node process as legacy (`npm run dev`,
  :3011) — 3D rooms via `{type:'join', mode:'3d'}` → `src/server/room3d.ts`.
- **Isomorphic Rapier sim** in `src/shared/sim3d/` runs identically on the
  server (authority, 30Hz) and client (prediction):
  - `player.ts` — kinematic capsule, accel/decel, speed-dependent turn-rate
    cap (sprint turn radius ~3.4m), stamina, shield; controller collides
    with WALLS only (collision groups), players separate softly with
    shoulder-slip (no head-on deadlock).
  - `control.ts` — possession model: ownership + **carry spring** (ball
    tracks a point ahead of the feet, capped accel 38 m/s² — turns carry
    the ball; tackle impulses exceed the cap and rip it free), sprint
    knock-ons w/ carry assist between touches, trap for fast incoming
    balls, human-vs-bot contest bias (0.75/0.45/0.6 steal ratios),
    dispossess cooldown.
  - `actions.ts` — kicks fire at the ANIMATION CONTACT FRAME (140ms after
    release, params locked at trigger): PASS (cone-targeted, velocity-led),
    THROUGH (hard lead, goal-biased), SHOOT (charge=power, placement from
    facing, Magnus curl), LOB (backspin), STANDING TACKLE (**shielding
    rule: blocked if carrier's body is between tackler and ball**; pokes
    aim AWAY from carrier), SLIDE (0.45s lunge, miss=stun, from-behind=
    foul), plant-touch settles ball during windup.
  - `match.ts` — world (walls with goal gaps, posts/crossbar colliders),
    phases (lobby/playing/goal/ended), goal detection = interpolated LINE
    CROSSING under the bar (over-bar landings don't count), aero forces
    (quadratic drag + Magnus + spin decay + grass skid: decel = 1.4 +
    0.16·v), formations (humans fill striker-first, bots keeper-first),
    5v5 on 40×20m (all constants in config3d).
  - `bots.ts` v3 — roles (keeper/chaser/runner/holders w/ 1.2m deadband),
    **decelerating collect** (sprinting flat-out fails the claim gate),
    loose ball = nearest teammate goes, pass decision scored by forward
    progress + receiver openness + lane safety, shoots in range unless
    bodily blocked, second presser in defensive third.
    Telemetry (90s all-bot): 6 shots, 16 deliberate passes, loose balls
    claimed 1.2s avg, 1-1.
- **Netcode**: client-side prediction for own player (local Rapier world,
  input replay on snapshot ack); remotes+ball interpolate 100ms; **predicted
  ball carry** — when server says you own it, rendered ball rides your
  predicted feet (zero lag through turns; kick releases hand back to
  interp). Snapshot includes `owner` id.
- **Characters**: Quaternius Universal Animation Library [Standard] (CC0,
  committed at `public/assets/chars/UAL1.glb`, 43 clips, UE-style skeleton).
  `src/game3d/chars.ts`: SkeletonUtils clone per player, locomotion blend
  tree (idle/walk/jog/sprint) with cadence-synced timeScale (no foot slide),
  hysteresis on state switching, procedural kick overlay on thigh_r/calf_r
  (Standard tier has no kick clip), slide = posed overlay (lean back 0.95
  rad, hips -0.62m), stun = Hit_Chest clip, head tracks ball via bind-pose-
  cached local axis (cheap), bank into turns. **Kit painted in-shader from
  bind-pose height bands** (jersey short-sleeves/shorts/socks/boots/hair/
  eyes + per-player skin/hair tones) — deforms perfectly, no bone-axis risk.
  Model faces +Z natively → MODEL_YAW = +π/2 (calibrated; wrong offset was
  the "controls don't match camera" bug).
- **Stadium** (procedural, meters): regulation markings scaled from 105×68
  (penalty areas 11.85×6.29, six-yard 5.38×2.10, spot 4.19, computed D,
  quarter corner arcs, 12cm lines), seat-ROW crowd texture w/ aisles + ~82%
  occupancy, 5-tier covered main stand (lit roof underside, flag row),
  4-tier open ends, angled corner blocks, dugouts w/ perspex roofs, ad-board
  ring (ELEVENS/DRANZO/5v5), corner flags, gradient sky dome, warm
  late-afternoon grade (sun 1.85 @ 0xffe6bd, exposure 1.22), vignette.
- **UI (ui-ux-pro-max design system: esports)**: Russo One + Chakra Petch,
  felt green #15803D + amber #D97706 on navy #0F172A, glass panels;
  broadcast SCOREBUG (ELV bug + BLU/RED chips + tabular score + amber
  clock), stamina bar (reds <30%), skewed lower-third banners, room-ticket
  lobby with team panels, radial-glass touch buttons.
- **Cameras**: broadcast (PES TV: 42° lens, y10.5 z+17.5, ball-led pan),
  third person, first person, overhead. `C` cycles. FP/3P input is
  camera-relative with gesture-anchored yaw (held key keeps its world
  direction — no spiral).

## 3. How to run (dev)

```bash
cd /Users/shinky777/Dranzo11
npm run dev   # game server :3011 (legacy client + 3D rooms) — keep running
npm run lab   # Vite: /play3d.html (3D game), /lab.html (physics lab)
# open http://localhost:5175/play3d.html  (port may be 5173+)
# ?debug=1 → tweakpane; ?q=low → phone tier
```
Desktop keys: WASD move, Shift sprint, E shield/jockey, Space/J pass,
I through, K hold shoot, L lob, V tackle, N slide, C camera.

## 4. Test harnesses (run before/after sim changes)

```bash
npx tsx scripts/test-match.mts  # 11 deterministic sim tests: goals, over-bar
                                # rejection, shot/pass verbs, clash pass-through,
                                # standing receive, run-onto, turn-carry,
                                # tackle strip, shielding block
npx tsx scripts/test-bots.mts   # 90s all-bot telemetry: passes/shots/loose-
                                # ball pickup latency/score
```
Playwright probes used live via window hooks: `__snap` (latest snapshot),
`__models`, `__ballVis`, `__camYaw`, `__camMode`, `__move` (lab).
Beware: 5v5 kickoff scrums contaminate live probes — use `MATCH.teamSize=1`
temporarily (config3d) or the lab for clean measurements. Automation tab
rAF-throttles to ~31fps when backgrounded — not a real perf signal (game
measured 121fps foregrounded).

## 5. Key files

```
src/shared/config3d.ts     ← EVERY tunable, SI units (ball aero, movement,
                             TOUCH carry/trap/steal, KICK, tackle, teamSize)
src/shared/sim3d/{player,control,actions,match,bots}.ts   (isomorphic)
src/server/room3d.ts       ← 30Hz authority, per-client input ack
src/server/{index,room}.ts ← ws entry (mode routing), legacy 2.5D room
src/game3d/main.ts         ← 3D client: net/prediction/render/UI/stadium
src/game3d/chars.ts        ← rigged characters + kit shader + anim tree
src/lab/{main,rig}.ts      ← physics lab (M1/M2/M3 verification)
play3d.html                ← 3D game UI (esports design system)
scripts/test-match.mts, scripts/test-bots.mts, scripts/dbg-tackle.mts
ASSETS.md                  ← Mixamo pipeline (user downloads to assets/raw/,
                             gitignored; Quaternius CC0 is committed)
DEPLOY.md                  ← legacy deploy (cPanel/VPS)
```

## 6. Workflow conventions this project uses

- Caveman mode active (terse replies; code/commits normal).
- Every change: typecheck → deterministic sim tests → live Playwright
  verify (screenshots/telemetry) → commit+push to `main` with detailed
  message ending `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- User verifies by playing at localhost after each push; feedback loops are
  feel-based ("ball not in control") — diagnose with telemetry before
  changing constants; several "feel" bugs were actually presentation
  (render-lag) or rules (poke spam), not physics.

## 7. Known gaps / agreed next steps (in rough priority)

1. **Kick-strike animations**: Standard UAL has no kick clip — procedural
   leg overlay used. Options: UAL Pro tier ($9.99, itch) or user's Mixamo
   drops per ASSETS.md (pipeline documented, assets/raw gitignored).
2. **Match presentation**: kickoff camera sweep, goal celebration/replay
   flash, halftime? crowd audio/SFX (none yet — sound entirely missing).
3. **Kickoff balance**: opposing striker often wins the center ball vs an
   idle human; consider kickoff possession assignment (team A first half)
   instead of a loose ball at center.
4. **Prod packaging for 3D**: vite build output not wired into app.js
   deploy; legacy path deploys fine. Need `vite build` (dist-web) served by
   the node server + ws same-origin.
5. **Mobile pass on 3D client**: touch cluster exists but untested on
   device; quality tier auto = touch→low.
6. **True foot IK, jersey numbers, photoreal stadium GLB** (CC0 download
   would need user approval like the Quaternius one).
7. **Fouls**: currently stun + loose ball; no free kicks/cards.
8. Avatars (selfie faces) not wired into the 3D client (legacy has them);
   protocol supports adding it later.

## 8. Session state at handoff

- All work pushed: `main` @ `0fbdc2b` ("regulation pitch markings, seated
  crowd stands, complete goal frames"). Working tree clean.
- Local processes (restart if dead): `npm run dev` (bg), `npm run lab` (bg).
- All 11 sim tests green; bot telemetry healthy (6 shots/90s, 16 passes).
