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

export type Phase = 'lobby' | 'playing' | 'goal' | 'ended';

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
}

export interface MatchSnapshot {
  tick: number;
  phase: Phase;
  score: [number, number];
  timeLeft: number;
  owner: string | null; // id of the player with close control (carry)
  ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number };
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
  }[];
  events: MatchEvent[];
}

const L = PITCH_5S.length;
const W = PITCH_5S.width;

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
    // arena boards (MVP: futsal-style rebound walls keep play flowing;
    // out-of-bounds restarts are a config flip away)
    const wall = (x: number, z: number, hx: number, hz: number) => {
      const b = this.world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, 1, z));
      this.world.createCollider(R.ColliderDesc.cuboid(hx, 1, hz).setRestitution(0.55), b);
    };
    wall(0, -W / 2 - 0.15, L / 2 + 1, 0.15);
    wall(0, W / 2 + 0.15, L / 2 + 1, 0.15);
    // end walls have goal gaps
    const gapZ = PITCH_5S.goalWidth / 2;
    const endSeg = (W / 2 - gapZ) / 2 + gapZ;
    for (const sx of [-1, 1]) {
      wall(sx * (L / 2 + 0.15), -(gapZ + (W / 2 - gapZ) / 2), 0.15, (W / 2 - gapZ) / 2);
      wall(sx * (L / 2 + 0.15), gapZ + (W / 2 - gapZ) / 2, 0.15, (W / 2 - gapZ) / 2);
      // net-back stops the ball behind the goal line
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
        .setFriction(BALL.friction),
      this.ball,
    );
  }

  addPlayer(id: string, name: string, team: 0 | 1, bot: boolean): number {
    const idx = this.players.length;
    this.meta.push({ id, name, team, bot });
    const spot = this.spotFor(idx);
    this.players.push(new SimPlayer(this.R, this.world, spot.x, spot.z));
    this.ctlStates.push({ cooldown: 0 });
    this.actStates.push(newActionState());
    this.inputs.push(idleFullInput());
    return idx;
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
    return { x: sx * s.x, z: s.z };
  }

  kickoff() {
    this.poss = { owner: -1, ownerSince: 0 };
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
        },
        this.inputs,
      );

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

      // OUT OF PLAY: lofted balls clear the 1m boards or the crossbar and
      // land where nobody can reach (players never leave the field). Natural
      // restart instead of a dead ball:
      //  - over a side board  -> throw-in at the boundary point
      //  - behind a goal line without a goal -> goal kick from the 6-yard box
      if (this.phase === 'playing') {
        const OUT = 0.4;
        if (Math.abs(bp.z) > W / 2 + OUT) {
          this.restartBall(
            Math.max(-L / 2 + 2, Math.min(L / 2 - 2, bp.x)),
            Math.sign(bp.z) * (W / 2 - 0.8),
            'throwin',
          );
        } else if (Math.abs(bp.x) > L / 2 + OUT) {
          // crossed the end line and the crossing detector above didn't award
          // a goal (over the bar / wide behind the frame)
          this.restartBall(Math.sign(bp.x) * (L / 2 - 3), 0, 'goalkick');
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

    return this.events;
  }

  /** dead-ball restart: place the ball, kill motion, release possession */
  private restartBall(x: number, z: number, kind: 'throwin' | 'goalkick') {
    this.ball.setTranslation({ x, y: BALL.radius, z }, true);
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.prevBall = { x, y: BALL.radius, z };
    this.poss = { owner: -1, ownerSince: this.tick };
    for (const s of this.ctlStates) s.cooldown = 0;
    this.events.push({ kind: 'kick', playerIndex: -1, detail: kind });
  }

  private goal(team: 0 | 1) {
    this.score[team]++;
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
      })),
      events: this.events,
    };
  }
}
