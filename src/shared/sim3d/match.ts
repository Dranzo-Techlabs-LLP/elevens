// ============================================================
// ISOMORPHIC MATCH SIM — one function of (inputs, dt) -> state.
// The server steps this at 30Hz as the authority; the client steps the SAME
// code for its own player's prediction. No rendering, no sockets in here.
// ============================================================
import type RAPIER from '@dimforge/rapier3d-compat';
import { BALL, MATCH, PITCH_5S, PLAYER } from '../config3d';
import { SimPlayer, defaultMoveTune, type MoveTune } from './player';
import { defaultControlTune, stepBallControl, type ControlState, type ControlTune, type Possession } from './control';
import { newActionState, stepActions, type ActionInput, type ActionState, type MatchEvent } from './actions';

export type Phase = 'lobby' | 'playing' | 'goal' | 'freekick' | 'ended';

export interface PlayerFullInput {
  mx: number;
  mz: number;
  sprint: boolean;
  shield: boolean; // doubles as jockey when defending
  pass: boolean;
  through: boolean;
  shoot: boolean;
  lob: boolean;
  tackle: boolean;
  slide: boolean;
}
export const idleFullInput = (): PlayerFullInput => ({
  mx: 0, mz: 0, sprint: false, shield: false,
  pass: false, through: false, shoot: false, lob: false, tackle: false, slide: false,
});

export interface MatchPlayerMeta {
  id: string;
  name: string;
  team: 0 | 1;
  bot: boolean;
  /** the designated goalkeeper of his team (spot 0) — may use hands in his
   *  own penalty area and takes the goal kicks */
  keeper?: boolean;
}

export interface MatchSnapshot {
  tick: number;
  phase: Phase;
  score: [number, number];
  timeLeft: number;
  owner: string | null; // id of the player with close control (carry)
  ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number };
  ref: { x: number; z: number; yaw: number; speed: number };
  players: {
    id: string;
    x: number;
    z: number;
    vx: number;
    vz: number;
    yaw: number;
    stamina: number;
    charge: number;
    stunned: boolean;
    sliding: boolean;
    shielding: boolean;
    holding: boolean;
    keeper: boolean;
  }[];
  events: MatchEvent[];
}

const L = PITCH_5S.length;
const W = PITCH_5S.width;

// Box geometry shared with the pitch markings (proportions of a 105x68
// pitch scaled to ours) — the sim's penalty/goal-kick/keeper-hands rules
// must agree with the painted lines.
export const BOX = {
  penDepth: (16.5 / 105) * L,  // penalty area depth  (~6.29m)
  penWidth: (40.3 / 68) * W,   // penalty area width  (~11.85m)
  sixDepth: (5.5 / 105) * L,   // goal area depth     (~2.10m)
  spotDist: (11 / 105) * L,    // penalty spot        (~4.19m)
};

export type RestartKind = 'throwin' | 'goalkick' | 'corner' | 'freekick' | 'penalty';
export interface RestartState {
  kind: RestartKind;
  team: 0 | 1;     // team awarded the restart
  taker: number;   // player index who takes it
  x: number;
  z: number;
  readyTick: number; // ceremony ends; taker may play the ball
}

export class Match {
  world: RAPIER.World;
  ball: RAPIER.RigidBody;
  players: SimPlayer[] = [];
  meta: MatchPlayerMeta[] = [];
  ctlStates: ControlState[] = [];
  actStates: ActionState[] = [];
  inputs: PlayerFullInput[] = [];
  lastTouch = -1;
  poss: Possession = { owner: -1, ownerSince: 0 };
  tick = 0;
  phase: Phase = 'playing';
  score: [number, number] = [0, 0];
  timeLeft = 180;
  private pauseUntil = 0;
  private prevBall: { x: number; y: number; z: number } = { x: 0, y: BALL.radius, z: 0 };
  events: MatchEvent[] = [];

  // ---- kickoff discipline ----
  // Real law: the team that concedes restarts, and only they may play the
  // ball until it's in play. Bots read these; a kickoff stops being a scrum.
  kickoffTeam: 0 | 1 = 0;
  kickoffHold = false;

  // ---- dead-ball restarts (throw-in / corner / goal kick / free kick /
  // penalty): ball is placed, a taker steps up, opponents retreat, and
  // until the taker's first touch nobody else may play it ----
  restartState: RestartState | null = null;

  // ---- goalkeeper hands: index of a keeper holding the ball (-1 none) ----
  holdIdx = -1;
  private holdSince = 0;
  private pickupCooldownUntil = 0; // after a release: play with the feet a while

  // ---- referee ----
  ref = { x: 0, z: 6, vx: 0, vz: 0, yaw: Math.PI };
  private yellows = new Map<number, number>(); // playerIndex -> yellow count
  private pendingFoul: null | { tick: number; x: number; z: number; victimTeam: 0 | 1; offender: number } = null;

  moveTune: MoveTune = defaultMoveTune();
  ctlTune: ControlTune = defaultControlTune();

  constructor(private R: typeof RAPIER, public tickRate = MATCH.tickRate) {
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = 1 / tickRate;

    // ground
    const g = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    this.world.createCollider(
      R.ColliderDesc.cuboid(80, 0.5, 60).setTranslation(0, -0.5, 0).setFriction(0.8),
      g,
    );
    // REAL FOOTBALL BOUNDARIES: no boards. The ball crossing a line is out
    // of play and restarts per the laws (throw-in / corner / goal kick).
    // Only the goal frame, a net-back stop, and the player-only mouth seals
    // remain physical.
    const wall = (x: number, z: number, hx: number, hz: number) => {
      const b = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, 1, z));
      this.world.createCollider(R.ColliderDesc.cuboid(hx, 1, hz).setRestitution(0.55), b);
    };
    // PLAYER-ONLY seals across the goal mouths (group 0x8): the ball sails
    // through into the net, players cannot — physical backup to the
    // position clamp in SimPlayer
    for (const sx of [-1, 1]) {
      const b = this.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(sx * (L / 2 + 0.15), 1, 0),
      );
      this.world.createCollider(
        R.ColliderDesc.cuboid(0.15, 1, PITCH_5S.goalWidth / 2 + 0.4).setCollisionGroups((0x0008 << 16) | 0x0002),
        b,
      );
    }
    const gapZ = PITCH_5S.goalWidth / 2;
    for (const sx of [-1, 1]) {
      // net-back stops the ball behind the goal line (a goal stays a goal)
      wall(sx * (L / 2 + PITCH_5S.goalDepth + 0.2), 0, 0.15, gapZ + 0.3);
      // crossbar
      const bar = this.world.createRigidBody(
        R.RigidBodyDesc.fixed().setTranslation(sx * L / 2, PITCH_5S.goalHeight, 0),
      );
      const barDesc = R.ColliderDesc.capsule(gapZ - 0.04, 0.04)
        .setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 })
        .setRestitution(0.7);
      this.world.createCollider(barDesc, bar);
      // posts
      for (const sz of [-1, 1]) {
        const post = this.world.createRigidBody(
          R.RigidBodyDesc.fixed().setTranslation(sx * L / 2, PITCH_5S.goalHeight / 2, sz * gapZ),
        );
        this.world.createCollider(
          R.ColliderDesc.capsule(PITCH_5S.goalHeight / 2 - 0.04, 0.04).setRestitution(0.7),
          post,
        );
      }
    }

    this.ball = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, BALL.radius, 0).setCcdEnabled(true),
    );
    this.world.createCollider(
      R.ColliderDesc.ball(BALL.radius)
        .setMass(BALL.mass)
        .setRestitution(BALL.restitution)
        .setFriction(BALL.friction)
        // ball hits walls (0x1) and players (0x2) but passes the player-only
        // goal-mouth seals (0x8) — otherwise no goals
        .setCollisionGroups((0x0004 << 16) | 0x0003),
      this.ball,
    );
  }

  addPlayer(id: string, name: string, team: 0 | 1, bot: boolean): number {
    const idx = this.players.length;
    this.meta.push({ id, name, team, bot });
    const spot = this.spotFor(idx);
    this.meta[idx].keeper = spot.nth === 0; // spot 0 = the goalkeeper
    this.players.push(new SimPlayer(this.R, this.world, spot.x, spot.z));
    this.ctlStates.push({ cooldown: 0 });
    this.actStates.push(newActionState());
    this.inputs.push(idleFullInput());
    return idx;
  }

  /** the designated keeper of a team (falls back to the deepest player) */
  keeperOf(team: 0 | 1): number {
    for (let i = 0; i < this.meta.length; i++) {
      if (this.meta[i].team === team && this.meta[i].keeper) return i;
    }
    let best = -1, deep = -Infinity;
    const own = team === 0 ? -1 : 1;
    for (let i = 0; i < this.meta.length; i++) {
      if (this.meta[i].team !== team) continue;
      const d = own * this.players[i].pos.x;
      if (d > deep) { deep = d; best = i; }
    }
    return best;
  }

  /** Humans fill from the STRIKER backward (fun roles first); bots fill from
   *  the KEEPER forward — a solo human is never stuck in goal. */
  private spotFor(idx: number) {
    const m = this.meta[idx];
    const teamMates = this.meta.filter((o) => o.team === m.team);
    const before = teamMates.filter((o, j) => this.meta.indexOf(o) < idx);
    const sx = m.team === 0 ? -1 : 1;
    const spots = [
      { x: 0.44 * L, z: 0 },        // 0 GK
      { x: 0.25 * L, z: 0 },        // 1 D
      { x: 0.12 * L, z: -0.25 * W },// 2 wide L
      { x: 0.12 * L, z: 0.25 * W }, // 3 wide R
      { x: 0.03 * L, z: 0 },        // 4 striker
    ];
    let nth: number;
    if (m.bot) {
      const botsBefore = before.filter((o) => o.bot).length;
      nth = Math.min(botsBefore, spots.length - 1); // bots: GK first
    } else {
      const humansBefore = before.filter((o) => !o.bot).length;
      nth = Math.max(0, spots.length - 1 - humansBefore); // humans: striker first
    }
    const s = spots[nth];
    return { x: sx * s.x, z: s.z, nth };
  }

  kickoff() {
    this.kickoffHold = true;
    this.restartState = null;
    this.holdIdx = -1;
    this.poss = { owner: -1, ownerSince: this.tick }; // stamps the failsafe clock

    this.prevBall = { x: 0, y: BALL.radius, z: 0 };
    this.ball.setTranslation({ x: 0, y: BALL.radius, z: 0 }, true);
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.meta.forEach((m, i) => {
      const s = this.spotFor(i);
      this.players[i].body.setTranslation({ x: s.x, y: PLAYER.height / 2, z: s.z }, true);
      this.players[i].velX = 0;
      this.players[i].velZ = 0;
      this.players[i].yaw = m.team === 0 ? 0 : Math.PI;
      this.actStates[i] = newActionState();
      this.ctlStates[i] = { cooldown: 0 };
    });
    this.lastTouch = -1;
  }

  setInput(idx: number, input: PlayerFullInput) {
    this.inputs[idx] = input;
  }

  /** One fixed step. Returns events raised this tick. */
  step(): MatchEvent[] {
    this.events = [];
    this.tick++;
    const dt = 1 / this.tickRate;

    if (this.phase === 'goal' && this.tick >= this.pauseUntil) {
      this.kickoff();
      this.phase = 'playing';
      this.events.push({ kind: 'kick', playerIndex: -1, detail: 'kickoff' });
    }

    if (this.phase === 'playing') {
      // movement (stun gates input; slide overrides velocity inside actions)
      for (let i = 0; i < this.players.length; i++) {
        const st = this.actStates[i];
        const stunned = this.tick < st.stunUntilTick;
        const sliding = this.tick < st.slideUntilTick;
        const inp = stunned || sliding ? idleFullInput() : this.inputs[i];
        this.players[i].step(
          dt,
          { x: inp.mx, z: inp.mz, sprint: inp.sprint, shield: inp.shield },
          this.moveTune,
        );
      }

      // soft player-player separation: overlapping capsules shove apart at a
      // capped rate (replaces hard controller blocking, which deadlocked
      // head-on runners in place)
      const MIN_D = PLAYER.capsuleRadius * 2 - 0.04;
      for (let i = 0; i < this.players.length; i++) {
        for (let j = i + 1; j < this.players.length; j++) {
          const a = this.players[i].body.translation();
          const b = this.players[j].body.translation();
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const d = Math.hypot(dx, dz);
          if (d > 1e-5 && d < MIN_D) {
            const push = Math.min((MIN_D - d) / 2, 2.5 * dt); // capped shove
            let nx = dx / d;
            let nz = dz / d;
            // shoulder-slip: dead head-on contact has no lateral component
            // and grinds forever — bias the push sideways so bodies slide
            // past each other like real shoulder charges
            const pi_ = this.players[i], pj = this.players[j];
            const vDot = pi_.velX * pj.velX + pi_.velZ * pj.velZ;
            if (vDot < -1) {
              const sx = -nz, sz = nx; // perpendicular
              nx = (nx + sx * 0.85);
              nz = (nz + sz * 0.85);
              const nl = Math.hypot(nx, nz);
              nx /= nl; nz /= nl;
            }
            // clamp to the field — direct setTranslation bypasses walls, so a
            // scrum against the boards must never tunnel players outside
            const BX = L / 2 - PLAYER.capsuleRadius * 0.9;
            const BZ = W / 2 - PLAYER.capsuleRadius * 0.9;
            const cl = (v: number, b2: number) => Math.max(-b2, Math.min(b2, v));
            this.players[i].body.setTranslation(
              { x: cl(a.x - nx * push * 1.6, BX), y: a.y, z: cl(a.z - nz * push * 1.6, BZ) },
              true,
            );
            this.players[j].body.setTranslation(
              { x: cl(b.x + nx * push * 1.6, BX), y: b.y, z: cl(b.z + nz * push * 1.6, BZ) },
              true,
            );
          }
        }
      }

      // keeper hands (saves/catches/hold maintenance) BEFORE control so a
      // caught ball is glued this tick, not fought over
      this.stepKeeperHands();

      // THROW-IN: the ball is IN THE TAKER'S HANDS, overhead — it rides
      // above him until the two-handed release (his kick verb becomes the
      // throw). This is what makes it read as a real throw-in, not a kick.
      if (this.restartState?.kind === 'throwin' && this.restartState.taker >= 0) {
        const t = this.players[this.restartState.taker];
        this.ball.setTranslation(
          { x: t.pos.x + Math.cos(t.yaw) * 0.18, y: 2.05, z: t.pos.z + Math.sin(t.yaw) * 0.18 },
          true,
        );
        this.ball.setLinvel({ x: t.velX, y: 0, z: t.velZ }, true);
        this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
      }

      // dead-ball lock: during a restart ceremony only the taker (and only
      // after the ceremony) may play the ball; a keeper hold locks to him
      const rs = this.restartState;
      const lockedTo = this.holdIdx >= 0
        ? this.holdIdx
        : rs ? rs.taker : -1;

      // ball control (traps + dribble touches) — skip for stunned/sliding
      const ctlEvents = stepBallControl(
        dt,
        this.tick,
        this.ball,
        this.players,
        this.ctlStates,
        this.inputs.map((inp, i) => !!inp.shield && this.tick >= this.actStates[i].stunUntilTick),
        this.poss,
        this.ctlTune,
        this.meta.map((m) => m.bot),
        lockedTo,
      );
      for (const ev of ctlEvents) this.lastTouch = ev.playerIndex;
      if (this.poss.owner >= 0) this.lastTouch = this.poss.owner;

      // verbs
      stepActions(
        {
          tick: this.tick,
          dt,
          tickRate: this.tickRate,
          ball: this.ball,
          players: this.players,
          teams: this.meta.map((m) => m.team),
          states: this.actStates,
          lastTouch: this.lastTouch,
          events: this.events,
          poss: this.poss,
          ctlStates: this.ctlStates,
          holdIdx: this.holdIdx,
          handHeldBy: this.holdIdx >= 0
            ? this.holdIdx
            : rs?.kind === 'throwin' ? rs.taker : -1,
          canPlay: rs
            ? (i: number) => i === rs.taker && this.tick >= rs.readyTick
            : undefined,
        },
        this.inputs,
      );

      // restart release: the taker's first touch puts the ball in play
      if (this.restartState) {
        const rst = this.restartState;
        const b = this.ball.translation();
        const VERBS = ['pass', 'through', 'shoot', 'lob'];
        const kicked = this.events.some(
          (e) => e.kind === 'kick' && e.playerIndex === rst.taker && VERBS.includes(e.detail ?? ''),
        );
        // throw-ins release ONLY on the throw itself (the ball rides the
        // taker's hands, so "ball moved" would misfire while he walks)
        const moved = rst.kind !== 'throwin' && Math.hypot(b.x - rst.x, b.z - rst.z) > 1.0;
        if (this.tick >= rst.readyTick && (kicked || moved)) {
          if (rst.kind === 'throwin' && kicked) {
            // A THROW-IN GOES TO A TEAMMATE. Pick the best infield receiver
            // (open, ~6m ideal) and deliver to his feet — never back over
            // the line the ball just left.
            const t = this.players[rst.taker];
            const bpNow = this.ball.translation();
            let best = -1, bs = -Infinity;
            for (let i = 0; i < this.players.length; i++) {
              if (i === rst.taker || this.meta[i].team !== rst.team) continue;
              const p = this.players[i].pos;
              const d = Math.hypot(p.x - t.pos.x, p.z - t.pos.z);
              if (d < 2 || d > 14) continue;
              if (Math.abs(p.z) > W / 2 - 0.8) continue; // receiver must be infield
              let open = 99;
              for (let j = 0; j < this.players.length; j++) {
                if (this.meta[j].team === rst.team) continue;
                const o = this.players[j].pos;
                open = Math.min(open, Math.hypot(o.x - p.x, o.z - p.z));
              }
              const score = Math.min(open, 6) - Math.abs(d - 6) * 0.3;
              if (score > bs) { bs = score; best = i; }
            }
            if (best >= 0) {
              const r = this.players[best];
              const lx = r.pos.x + r.velX * 0.3;
              const lz = r.pos.z + r.velZ * 0.3;
              const dx = lx - bpNow.x, dz = lz - bpNow.z;
              const dd = Math.max(0.5, Math.hypot(dx, dz));
              const speed = Math.min(10.5, Math.max(5, 3.5 + dd * 0.75));
              this.ball.setLinvel(
                { x: (dx / dd) * speed, y: 1.2 + dd * 0.07, z: (dz / dd) * speed },
                true,
              );
            } else {
              // no receiver: at least throw INFIELD, capped to throw pace
              const v = this.ball.linvel();
              const h = Math.hypot(v.x, v.z);
              const cap = Math.min(Math.max(h, 6.5), 10.5);
              let vx = v.x, vz = v.z;
              if (vz * Math.sign(rst.z) > 0) vz = -vz; // never back over the line
              const k2 = h > 0.01 ? cap / Math.hypot(vx, vz) : 1;
              this.ball.setLinvel({ x: vx * k2, y: 1.6, z: vz * k2 }, true);
            }
            this.events.push({ kind: 'kick', playerIndex: rst.taker, detail: 'throw' });
          }
          this.restartState = null;
        } else if (this.tick > rst.readyTick + 6 * this.tickRate) {
          // failsafe: never deadlock the match — a held throw-in ball is
          // put down on the line, playable by anyone
          if (rst.kind === 'throwin') this.placeBall(rst.x, rst.z);
          this.restartState = null;
        }
      }
      // a keeper's kick out of his hands ends the hold
      if (
        this.holdIdx >= 0 &&
        this.events.some(
          (e) => e.kind === 'kick' && e.playerIndex === this.holdIdx
            && ['pass', 'through', 'shoot', 'lob'].includes(e.detail ?? ''),
        )
      ) {
        this.holdIdx = -1;
        this.pickupCooldownUntil = this.tick + 2 * this.tickRate;
      }

      // the referee rules on fouls raised above (advantage / free kick / cards)
      this.refereeLaws();

      // ball in play: first touch off the spot releases the kickoff hold
      // (with a failsafe — a wandering human taker must never freeze play)
      if (this.kickoffHold) {
        const b = this.ball.translation();
        if (
          Math.hypot(b.x, b.z) > 1.0 ||
          this.events.some((e) => e.kind === 'kick' && e.playerIndex >= 0) ||
          this.tick - this.poss.ownerSince > 6 * this.tickRate
        ) {
          this.kickoffHold = false;
        }
      }

      // aero + integrate
      this.applyBallAero(dt);
      this.world.step();

      // goals: detect the actual LINE CROSSING (interpolated between ticks)
      // so a ball sailing over the bar and landing behind the goal never
      // counts — only what passes under the bar, between the posts.
      const bp = this.ball.translation();
      const line = L / 2 + BALL.radius;
      for (const side of [1, -1] as const) {
        const prev = side === 1 ? this.prevBall.x : -this.prevBall.x;
        const cur = side === 1 ? bp.x : -bp.x;
        if (prev <= line && cur > line) {
          const t = (line - prev) / Math.max(1e-6, cur - prev);
          const yc = this.prevBall.y + (bp.y - this.prevBall.y) * t;
          const zc = this.prevBall.z + (bp.z - this.prevBall.z) * t;
          if (yc < PITCH_5S.goalHeight && Math.abs(zc) < PITCH_5S.goalWidth / 2) {
            this.goal(side === 1 ? 0 : 1);
          }
        }
      }
      this.prevBall = { x: bp.x, y: bp.y, z: bp.z };

      // OUT OF PLAY — the actual laws, decided by who touched it last:
      //  - over a touchline            -> THROW-IN, other team
      //  - over a goal line, attacker last -> GOAL KICK (keeper takes)
      //  - over a goal line, defender last -> CORNER for the attackers
      if (this.phase === 'playing' && !this.restartState) {
        const OUT = BALL.radius + 0.15;
        const lastTeam = this.lastTouch >= 0 ? this.meta[this.lastTouch].team : (0 as 0 | 1);
        if (Math.abs(bp.z) > W / 2 + OUT) {
          const toTeam = (1 - lastTeam) as 0 | 1;
          this.setupRestart(
            'throwin', toTeam,
            Math.max(-L / 2 + 1, Math.min(L / 2 - 1, bp.x)),
            Math.sign(bp.z) * (W / 2 - 0.3),
          );
        } else if (Math.abs(bp.x) > L / 2 + OUT) {
          const side = Math.sign(bp.x); // which goal line it crossed
          // team defending that goal line
          const defTeam = (side === -1 ? 0 : 1) as 0 | 1;
          if (lastTeam === defTeam) {
            // defender put it behind his own line: corner for the attackers
            const atkTeam = (1 - defTeam) as 0 | 1;
            this.setupRestart(
              'corner', atkTeam,
              side * (L / 2 - 0.25),
              (bp.z >= 0 ? 1 : -1) * (W / 2 - 0.25),
            );
          } else {
            // attacker put it out: goal kick from the goal area
            this.setupRestart('goalkick', defTeam, side * (L / 2 - BOX.sixDepth - 0.2), 0);
          }
        }
      }

      this.timeLeft -= dt;
      if (this.timeLeft <= 0 && this.phase === 'playing') {
        this.phase = 'ended';
        this.events.push({ kind: 'kick', playerIndex: -1, detail: 'fulltime' });
      }
    } else {
      this.world.step(); // let the ball settle during pauses
    }

    // the official keeps moving through pauses (runs to the spot, backs off
    // for kickoffs) — he is scenery to the physics, never to the eye
    if (this.phase !== 'lobby') this.stepRef(dt);

    return this.events;
  }

  // ---------------- referee ----------------

  /**
   * Referee movement — models a real official on a diagonal patrol:
   * shadow play from ~7m, biased to the classic bottom-left <-> top-right
   * diagonal, never inside the penalty boxes, backing off when play comes
   * at him. Jogs normally, sprints on transitions. No collider — a real
   * ref dodges; ours never alters play.
   */
  private stepRef(dt: number) {
    const bp = this.ball.translation();
    // diagonal anchor: offset from the ball toward the diagonal side away
    // from the attacking direction of the team in possession
    const diag = bp.x * 0.5; // stay on the ball's half, trailing
    let tx = bp.x - Math.sign(bp.x || 1) * 4;
    let tz = bp.z > 0 ? bp.z - 6 : bp.z + 6; // opposite flank, ~6m
    // clear of the penalty boxes
    tx = Math.max(-L / 2 + 8, Math.min(L / 2 - 8, tx + diag * 0.2));
    tz = Math.max(-W / 2 + 1.5, Math.min(W / 2 - 1.5, tz));
    // never crowd the ball: if inside 4m of it, back away radially
    const dbx = tx - bp.x, dbz = tz - bp.z;
    const db = Math.hypot(dbx, dbz);
    if (db < 4 && db > 0.01) {
      tx = bp.x + (dbx / db) * 4;
      tz = bp.z + (dbz / db) * 4;
    }
    // seek with jog/sprint speeds and player-like accel
    const dx = tx - this.ref.x, dz = tz - this.ref.z;
    const d = Math.hypot(dx, dz);
    const want = d > 7 ? 6.6 : d > 1.2 ? 3.6 : 0; // sprint / jog / hold
    const wvx = d > 0.01 ? (dx / d) * want : 0;
    const wvz = d > 0.01 ? (dz / d) * want : 0;
    const k = 1 - Math.exp(-4 * dt); // accel ease
    this.ref.vx += (wvx - this.ref.vx) * k;
    this.ref.vz += (wvz - this.ref.vz) * k;
    this.ref.x += this.ref.vx * dt;
    this.ref.z += this.ref.vz * dt;
    // always watching the ball
    const face = Math.atan2(bp.z - this.ref.z, bp.x - this.ref.x);
    let dy = face - this.ref.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.ref.yaw += dy * (1 - Math.exp(-6 * dt));
  }

  /**
   * The laws: a foul raises a pending decision. If the fouled team keeps
   * the ball (0.7s window) the ref plays ADVANTAGE; otherwise he whistles,
   * awards a FREE KICK at the spot, and books the offender — slide fouls
   * are a straight yellow, a second yellow is a red + 20s sin-bin.
   */
  private refereeLaws() {
    // collect new fouls raised this tick by the action layer
    for (const ev of this.events) {
      if (ev.kind === 'foul' && !this.pendingFoul && ev.playerIndex >= 0) {
        const victimTeam = (1 - this.meta[ev.playerIndex].team) as 0 | 1;
        const bp = this.ball.translation();
        this.pendingFoul = { tick: this.tick, x: bp.x, z: bp.z, victimTeam, offender: ev.playerIndex };
      }
    }
    if (!this.pendingFoul) return;
    const pf = this.pendingFoul;
    const ownerTeam = this.poss.owner >= 0 ? this.meta[this.poss.owner].team : -1;
    if (ownerTeam === pf.victimTeam && this.tick - pf.tick > 3) {
      // fouled team has it — play the advantage
      this.events.push({ kind: 'kick', playerIndex: pf.offender, detail: 'advantage' });
      this.bookOffender(pf.offender); // the card still comes
      this.pendingFoul = null;
      return;
    }
    if (this.tick - pf.tick > Math.round(0.7 * this.tickRate)) {
      // whistle. A foul by a defender inside HIS OWN penalty area is a
      // PENALTY KICK; anywhere else it's a direct free kick at the spot.
      this.bookOffender(pf.offender);
      const offTeam = this.meta[pf.offender].team;
      const ownSign = offTeam === 0 ? -1 : 1;
      const inOwnBox = Math.sign(pf.x) === ownSign && Math.abs(pf.x) > L / 2 - BOX.penDepth
        && Math.abs(pf.z) < BOX.penWidth / 2;
      if (inOwnBox) {
        const attack = pf.victimTeam === 0 ? 1 : -1;
        this.setupRestart('penalty', pf.victimTeam, attack * (L / 2 - BOX.spotDist), 0);
      } else {
        const fx = Math.max(-L / 2 + 1.0, Math.min(L / 2 - 1.0, pf.x));
        const fz = Math.max(-W / 2 + 1.0, Math.min(W / 2 - 1.0, pf.z));
        this.setupRestart('freekick', pf.victimTeam, fx, fz);
      }
      this.pendingFoul = null;
    }
  }

  private bookOffender(i: number) {
    const n = (this.yellows.get(i) ?? 0) + 1;
    this.yellows.set(i, n);
    if (n === 1) {
      this.events.push({ kind: 'kick', playerIndex: i, detail: 'yellow' });
    } else {
      // second yellow: red card + sin-bin — 20s frozen at his own bench
      this.events.push({ kind: 'kick', playerIndex: i, detail: 'red' });
      this.yellows.set(i, 0);
      const st = this.actStates[i];
      st.stunUntilTick = this.tick + Math.round(20 * this.tickRate);
      const benchX = this.meta[i].team === 0 ? -L / 4 : L / 4;
      this.players[i].body.setTranslation(
        { x: benchX, y: PLAYER.height / 2, z: W / 2 - 0.8 },
        true,
      );
    }
  }

  /** place a dead ball: kill motion, release possession, clear hand-holds */
  private placeBall(x: number, z: number) {
    this.ball.setTranslation({ x, y: BALL.radius, z }, true);
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevBall = { x, y: BALL.radius, z };
    this.poss = { owner: -1, ownerSince: this.tick };
    this.holdIdx = -1;
    for (const s of this.ctlStates) s.cooldown = 0;
  }

  /** move every opponent of `team` at least `r` meters from (x,z) */
  private pushOpponents(team: 0 | 1, x: number, z: number, r: number) {
    const BX = L / 2 - PLAYER.capsuleRadius;
    const BZ = W / 2 - PLAYER.capsuleRadius;
    for (let i = 0; i < this.players.length; i++) {
      if (this.meta[i].team === team) continue;
      const p = this.players[i].pos;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d >= r) continue;
      // radially out, biased toward their own goal so retreats look natural
      const own = this.meta[i].team === 0 ? -1 : 1;
      let nx = d > 0.05 ? (p.x - x) / d : own;
      let nz = d > 0.05 ? (p.z - z) / d : 0;
      nx = nx * 0.7 + own * 0.3;
      const nl = Math.hypot(nx, nz) || 1;
      this.players[i].body.setTranslation(
        {
          x: Math.max(-BX, Math.min(BX, x + (nx / nl) * r)),
          y: PLAYER.height / 2,
          z: Math.max(-BZ, Math.min(BZ, z + (nz / nl) * r)),
        },
        true,
      );
      this.players[i].velX = 0;
      this.players[i].velZ = 0;
    }
  }

  /**
   * Set up a dead-ball restart per the laws: ball placed at the spot, the
   * right taker steps up (keeper for goal kicks, nearest outfielder
   * otherwise), opponents retreat the legal distance (everyone out of the
   * box for penalties), and the ball is locked to the taker until his
   * first touch puts it back in play.
   */
  setupRestart(kind: RestartKind, team: 0 | 1, x: number, z: number) {
    const attack = team === 0 ? 1 : -1; // direction this team attacks
    this.placeBall(x, z);

    // choose the taker
    let taker = -1;
    if (kind === 'goalkick') taker = this.keeperOf(team);
    if (taker < 0) {
      let td = Infinity;
      for (let i = 0; i < this.players.length; i++) {
        if (this.meta[i].team !== team) continue;
        if (kind !== 'goalkick' && this.meta[i].keeper && this.players.length > 2) continue;
        const p = this.players[i].pos;
        const d = Math.hypot(p.x - x, p.z - z);
        if (d < td) { td = d; taker = i; }
      }
    }
    if (taker < 0) taker = this.keeperOf(team); // degenerate teams

    // stand the taker a step behind the ball, facing his attacking end
    if (taker >= 0) {
      const BX = L / 2 - PLAYER.capsuleRadius;
      const BZ = W / 2 - PLAYER.capsuleRadius;
      const tx = Math.max(-BX, Math.min(BX, x - attack * 1.1));
      const tz = Math.max(-BZ, Math.min(BZ, z + (z > 0 ? -0.4 : 0.4)));
      this.players[taker].body.setTranslation({ x: tx, y: PLAYER.height / 2, z: tz }, true);
      this.players[taker].velX = 0;
      this.players[taker].velZ = 0;
      this.players[taker].yaw = Math.atan2(z - tz, x - tx);
    }

    // legal retreat distances (9.15m scaled to our pitch for free kicks)
    if (kind === 'penalty') {
      // everyone except the taker and the defending keeper leaves the box
      const defTeam = (1 - team) as 0 | 1;
      const gk = this.keeperOf(defTeam);
      const goalX = attack * (L / 2);
      const edgeX = attack * (L / 2 - BOX.penDepth - 0.8);
      for (let i = 0; i < this.players.length; i++) {
        if (i === taker || i === gk) continue;
        const p = this.players[i].pos;
        const inBox = Math.abs(p.x) > L / 2 - BOX.penDepth && Math.sign(p.x) === Math.sign(goalX)
          && Math.abs(p.z) < BOX.penWidth / 2 + 0.5;
        if (inBox) {
          this.players[i].body.setTranslation(
            { x: edgeX, y: PLAYER.height / 2, z: Math.max(-W / 2 + 1, Math.min(W / 2 - 1, p.z)) },
            true,
          );
          this.players[i].velX = 0;
          this.players[i].velZ = 0;
        }
      }
      // keeper on his line
      if (gk >= 0) {
        this.players[gk].body.setTranslation(
          { x: attack * (L / 2 - 0.45), y: PLAYER.height / 2, z: 0 },
          true,
        );
        this.players[gk].velX = 0;
        this.players[gk].velZ = 0;
        this.players[gk].yaw = Math.atan2(0, -attack);
      }
    } else if (kind === 'goalkick') {
      // opponents out of the penalty area while the kick is taken
      const own = -attack;
      for (let i = 0; i < this.players.length; i++) {
        if (this.meta[i].team === team) continue;
        const p = this.players[i].pos;
        const inBox = Math.abs(p.x) > L / 2 - BOX.penDepth && Math.sign(p.x) === Math.sign(own)
          && Math.abs(p.z) < BOX.penWidth / 2 + 0.5;
        if (inBox) {
          this.players[i].body.setTranslation(
            { x: own * (L / 2 - BOX.penDepth - 1.0), y: PLAYER.height / 2, z: p.z },
            true,
          );
          this.players[i].velX = 0;
          this.players[i].velZ = 0;
        }
      }
    } else {
      this.pushOpponents(team, x, z, kind === 'freekick' ? 3.5 : 2.0);
    }

    const ceremony = kind === 'penalty' ? 2.0 : 1.1;
    this.restartState = {
      kind, team, taker, x, z,
      readyTick: this.tick + Math.round(ceremony * this.tickRate),
    };
    this.events.push({ kind: 'kick', playerIndex: taker, detail: kind });
  }

  /**
   * GOALKEEPER HANDS — inside his own penalty area a keeper meets shots
   * with his hands: a catchable shot is HELD (play flows through his
   * distribution), a screamer is PARRIED away. While held the ball rides
   * at his chest and cannot be challenged.
   */
  private stepKeeperHands() {
    // maintain an active hold: ball glued at chest height, auto-release
    // after ~3.5s (the six-second law, scaled to arena tempo)
    if (this.holdIdx >= 0) {
      const k = this.players[this.holdIdx];
      const hx = k.pos.x + Math.cos(k.yaw) * 0.35;
      const hz = k.pos.z + Math.sin(k.yaw) * 0.35;
      this.ball.setTranslation({ x: hx, y: 0.95, z: hz }, true);
      this.ball.setLinvel({ x: k.velX, y: 0, z: k.velZ }, true);
      this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.poss.owner = this.holdIdx;
      if (this.tick - this.holdSince > 3.5 * this.tickRate) {
        this.holdIdx = -1; // put it down and play with the feet
        this.pickupCooldownUntil = this.tick + 2 * this.tickRate;
      }
      return;
    }
    if (this.restartState) return; // dead ball: no diving on ceremonies

    const bp = this.ball.translation();
    const bv = this.ball.linvel();
    const sp = Math.hypot(bv.x, bv.y, bv.z);
    for (const team of [0, 1] as const) {
      const gi = this.keeperOf(team);
      if (gi < 0) continue;
      const own = team === 0 ? -1 : 1;
      // ball inside this keeper's own penalty area?
      const inBox = Math.sign(bp.x) === own && Math.abs(bp.x) > L / 2 - BOX.penDepth
        && Math.abs(bp.z) < BOX.penWidth / 2;
      if (!inBox) continue;
      const k = this.players[gi];
      const d = Math.hypot(bp.x - k.pos.x, bp.z - k.pos.z);
      const notStunned = this.actStates[gi].stunUntilTick <= this.tick;

      // GROUND PICKUP: a slow ball in his box, opponents closing — a real
      // keeper bends down and gathers it into his gloves
      if (
        notStunned && sp < 6 && bp.y < 0.5 && d < 1.0 &&
        this.tick >= this.pickupCooldownUntil &&
        this.holdIdx < 0
      ) {
        let oppNear = false;
        for (let i = 0; i < this.players.length; i++) {
          if (this.meta[i].team === team) continue;
          const p = this.players[i].pos;
          if (Math.hypot(p.x - bp.x, p.z - bp.z) < 7) { oppNear = true; break; }
        }
        if (oppNear) {
          this.holdIdx = gi;
          this.holdSince = this.tick;
          this.poss = { owner: gi, ownerSince: this.tick };
          this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
          this.actStates[gi].stunUntilTick = this.tick + Math.round(0.45 * this.tickRate);
          this.events.push({ kind: 'save', playerIndex: gi, detail: 'pickup', side: 0 });
          this.lastTouch = gi;
          continue;
        }
      }

      // moving toward our goal = a shot to deal with
      const towardGoal = bv.x * own > 1.5;

      // COMMIT THE DIVE even for balls passing BEYOND reach — a real keeper
      // goes down for everything near the frame; sometimes he's just beaten.
      // Only for laterally-unreachable balls: a reachable shot must never be
      // wasted on an early dive (the save block below handles those).
      const latNow = Math.cos(k.yaw) * (bp.z - k.pos.z) - Math.sin(k.yaw) * (bp.x - k.pos.x);
      if (
        sp > 8.5 && towardGoal && notStunned && bp.y < 2.2 &&
        Math.abs(latNow) > 2.0 && Math.abs(latNow) < 3.6 && d < 4.5
      ) {
        k.velX += (bp.x - k.pos.x) * 2.4;
        k.velZ += (bp.z - k.pos.z) * 2.4;
        this.actStates[gi].stunUntilTick = this.tick + Math.round(0.8 * this.tickRate);
        this.events.push({ kind: 'save', playerIndex: gi, detail: 'dive', side: Math.sign(latNow) || 1 });
        continue;
      }

      // a keeper's reach is his BODY plus a full-stretch dive
      if (d > 2.1 || bp.y > 2.2) continue;
      if (sp > 8.5 && towardGoal && notStunned) {
        // which side of his body the ball is on (for the dive animation):
        // signed lateral offset relative to his facing
        const lat = Math.cos(k.yaw) * (bp.z - k.pos.z) - Math.sin(k.yaw) * (bp.x - k.pos.x);
        const side = Math.abs(lat) < 0.5 ? 0 : Math.sign(lat);
        // the dive itself: his body lunges toward the ball's line
        if (side !== 0) {
          k.velX += (bp.x - k.pos.x) * 3.2;
          k.velZ += (bp.z - k.pos.z) * 3.2;
        }
        if (sp < 15 && Math.abs(lat) < 1.4) {
          // CATCH: dead in the gloves (a full-stretch ball can't be held)
          this.holdIdx = gi;
          this.holdSince = this.tick;
          this.poss = { owner: gi, ownerSince: this.tick };
          this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
          this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
          this.actStates[gi].stunUntilTick = this.tick + Math.round(0.35 * this.tickRate);
          this.events.push({ kind: 'save', playerIndex: gi, detail: 'catch', side });
        } else {
          // PARRY: too hot (or full stretch) — beaten away from goal, wide
          const away = -own;
          this.ball.setLinvel(
            { x: away * sp * 0.4, y: Math.max(2.5, bv.y * 0.3 + 2), z: (bp.z >= k.pos.z ? 1 : -1) * sp * 0.35 },
            true,
          );
          this.actStates[gi].stunUntilTick = this.tick + Math.round(0.7 * this.tickRate);
          this.events.push({ kind: 'save', playerIndex: gi, detail: 'parry', side: side || 1 });
        }
        this.lastTouch = gi;
      }
    }
  }

  private goal(team: 0 | 1) {
    this.score[team]++;
    this.kickoffTeam = (1 - team) as 0 | 1; // conceding side restarts
    this.phase = 'goal';
    this.pauseUntil = this.tick + Math.round(2.2 * this.tickRate);
    this.events.push({ kind: 'kick', playerIndex: team, detail: 'goal' });
  }

  restart(seconds: number) {
    this.score = [0, 0];
    this.timeLeft = seconds;
    this.kickoff();
    this.phase = 'playing';
  }

  private applyBallAero(dt: number) {
    const AREA = Math.PI * BALL.radius * BALL.radius;
    const v = this.ball.linvel();
    const w = this.ball.angvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    this.ball.resetForces(true);
    if (speed > 0.05) {
      const dragMag = 0.5 * BALL.airDensity * BALL.dragCd * AREA * speed;
      this.ball.addForce(
        {
          x: -dragMag * v.x + BALL.magnusK * (w.y * v.z - w.z * v.y),
          y: -dragMag * v.y + BALL.magnusK * (w.z * v.x - w.x * v.z),
          z: -dragMag * v.z + BALL.magnusK * (w.x * v.y - w.y * v.x),
        },
        true,
      );
    }
    const dec = Math.exp(-BALL.spinDecay * dt);
    this.ball.setAngvel({ x: w.x * dec, y: w.y * dec, z: w.z * dec }, true);
    const bp = this.ball.translation();
    if (bp.y < BALL.radius + 0.01 && Math.abs(v.y) < 0.5) {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.03) {
        const decel = BALL.rollFriction + BALL.rollSkid * hs;
        const k = Math.max(0, hs - decel * dt) / hs;
        this.ball.setLinvel({ x: v.x * k, y: v.y, z: v.z * k }, true);
      } else {
        this.ball.setLinvel({ x: 0, y: v.y, z: 0 }, true);
      }
    }
  }

  snapshot(): MatchSnapshot {
    const bp = this.ball.translation();
    const bv = this.ball.linvel();
    const r1 = (n: number) => Math.round(n * 1000) / 1000;
    return {
      tick: this.tick,
      phase: this.phase,
      score: [this.score[0], this.score[1]],
      timeLeft: Math.max(0, Math.ceil(this.timeLeft)),
      owner: this.poss.owner >= 0 ? this.meta[this.poss.owner].id : null,
      ball: { x: r1(bp.x), y: r1(bp.y), z: r1(bp.z), vx: r1(bv.x), vy: r1(bv.y), vz: r1(bv.z) },
      ref: {
        x: r1(this.ref.x),
        z: r1(this.ref.z),
        yaw: Math.round(this.ref.yaw * 100) / 100,
        speed: r1(Math.hypot(this.ref.vx, this.ref.vz)),
      },
      players: this.players.map((p, i) => ({
        id: this.meta[i].id,
        x: r1(p.pos.x),
        z: r1(p.pos.z),
        vx: r1(p.velX),
        vz: r1(p.velZ),
        yaw: Math.round(p.yaw * 100) / 100,
        stamina: Math.round(p.stamina * 100) / 100,
        charge: Math.min(1, this.actStates[i].shootHeldMs / 900),
        stunned: this.tick < this.actStates[i].stunUntilTick,
        sliding: this.tick < this.actStates[i].slideUntilTick,
        shielding: !!this.inputs[i].shield,
        holding: this.holdIdx === i,
        keeper: !!this.meta[i].keeper,
      })),
      events: this.events,
    };
  }
}
