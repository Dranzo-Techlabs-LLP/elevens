// ============================================================
// ISOMORPHIC ACTIONS — the full control verb set (M4).
// Kicks fire at the ANIMATION CONTACT FRAME: trigger schedules the strike
// ~140ms ahead (KICK.contactDelayMs); if the ball is still playable at that
// tick the impulse lands. This reads honest AND masks net latency.
//
// Verbs:
//  pass     — context pass to best teammate in the facing cone, weighted
//  through  — leading pass into a teammate's RUN (velocity extrapolated)
//  shoot    — HOLD to charge power; placement from facing; slight curl
//  lob      — lofted ball/cross with backspin
//  standing tackle — poke a reachable ball away; body-first = foul risk
//  slide    — committed lunge (reuses lunge physics); miss = long stun,
//             from-behind body contact = foul
//  jockey   — contain: slow, faces the ball, wider interception reach
// ============================================================
import type RAPIER from '@dimforge/rapier3d-compat';
import { BALL, KICK, PITCH_5S, TOUCH } from '../config3d';
import type { SimPlayer } from './player';
import type { ControlState, Possession } from './control';

export interface ActionInput {
  pass: boolean;
  through: boolean;
  shoot: boolean;
  lob: boolean;
  tackle: boolean; // tap = standing poke; SLIDE is separate
  slide: boolean;
}

export interface ActionState {
  shootHeldMs: number;
  prevPass: boolean;
  prevThrough: boolean;
  prevLob: boolean;
  prevTackle: boolean;
  prevSlide: boolean;
  prevShoot: boolean;
  /** scheduled strike: fires at `tick` */
  pending: null | {
    tick: number;
    kind: 'pass' | 'through' | 'shoot' | 'lob' | 'clear';
    charge: number; // 0..1 (shoot power)
    yaw: number;    // facing locked at trigger
  };
  stunUntilTick: number;
  slideUntilTick: number;
  slideDirX: number;
  slideDirZ: number;
  kickCooldownUntil: number;
}

export const newActionState = (): ActionState => ({
  shootHeldMs: 0,
  prevPass: false,
  prevThrough: false,
  prevLob: false,
  prevTackle: false,
  prevSlide: false,
  prevShoot: false,
  pending: null,
  stunUntilTick: 0,
  slideUntilTick: 0,
  slideDirX: 0,
  slideDirZ: 0,
  kickCooldownUntil: 0,
});

export interface MatchEvent {
  kind: 'kick' | 'foul' | 'tackle' | 'slide';
  playerIndex: number;
  detail?: string;
}

const KICK_RANGE = 1.9; // m from feet at the contact frame — generous enough
                        // that a sprint knock-on doesn't outrun your own strike
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface ActionCtx {
  tick: number;
  dt: number;
  tickRate: number;
  ball: RAPIER.RigidBody;
  players: SimPlayer[];
  teams: number[]; // 0 | 1 per player index
  states: ActionState[];
  /** which player last touched/controlled the ball (foul attribution) */
  lastTouch: number;
  events: MatchEvent[];
  /** possession — tackles/kicks break it so the carry spring lets go */
  poss: Possession;
  ctlStates: ControlState[];
}

export function stepActions(ctx: ActionCtx, inputs: ActionInput[]) {
  const { tick, dt, tickRate, ball, players, states } = ctx;
  const delayTicks = Math.max(1, Math.round((KICK.contactDelayMs / 1000) * tickRate));
  const bp = ball.translation();

  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    const st = states[i];
    const inp = inputs[i];
    const stunned = tick < st.stunUntilTick;

    const dx = bp.x - pl.pos.x;
    const dz = bp.z - pl.pos.z;
    const distToBall = Math.hypot(dx, dz);
    const ballPlayable = bp.y < TOUCH.ballMaxHeight + 0.4;

    // ---- charge / trigger edges (ignored while stunned/sliding) ----
    if (!stunned && tick >= st.slideUntilTick) {
      if (inp.shoot) st.shootHeldMs += dt * 1000;
      const fire = (kind: 'pass' | 'through' | 'shoot' | 'lob', charge = 0) => {
        if (tick < st.kickCooldownUntil || st.pending) return;
        st.pending = { tick: tick + delayTicks, kind, charge, yaw: pl.yaw };
        // plant touch: settle the ball during the windup so the strike is
        // clean — how pros take a touch before hitting it
        if (distToBall < 1.4 && ballPlayable) {
          const bv = ball.linvel();
          ball.setLinvel({ x: bv.x * 0.45 + pl.velX * 0.3, y: bv.y * 0.5, z: bv.z * 0.45 + pl.velZ * 0.3 }, true);
        }
      };
      if (!inp.pass && st.prevPass) fire('pass');
      if (!inp.through && st.prevThrough) fire('through');
      if (!inp.lob && st.prevLob) fire('lob');
      if (!inp.shoot && st.prevShoot) {
        fire('shoot', clamp(st.shootHeldMs / KICK.chargeTimeMs, 0, 1));
        st.shootHeldMs = 0;
      }

      // ---- standing tackle (tap) ----
      // SHIELDING RULE (PES): if the carrier's body is between you and the
      // ball, the poke fails — you cannot tackle through a player. The ball
      // must be on YOUR side of the carrier.
      let pokeBlocked = false;
      if (ctx.poss.owner >= 0 && ctx.poss.owner !== i) {
        const carrier = players[ctx.poss.owner];
        const dCarrier = Math.hypot(carrier.pos.x - pl.pos.x, carrier.pos.z - pl.pos.z);
        pokeBlocked = dCarrier < distToBall + 0.15; // carrier closer than the ball = shielded
      }
      if (inp.tackle && !st.prevTackle && distToBall < 1.3 && ballPlayable && !pokeBlocked) {
        // poke the ball AWAY FROM ITS CARRIER (aiming tackler->ball drives
        // it into the carrier's shins and it just parks at his feet again),
        // and BREAK possession so the carry spring lets go
        let pokeYaw: number;
        if (ctx.poss.owner >= 0 && ctx.poss.owner !== i) {
          const carrier = players[ctx.poss.owner];
          pokeYaw = Math.atan2(bp.z - carrier.pos.z, bp.x - carrier.pos.x);
        } else {
          pokeYaw = Math.atan2(dz, dx);
        }
        pokeYaw += (noiseSign(tick, i) ? 0.35 : -0.35);
        ball.setLinvel(
          { x: Math.cos(pokeYaw) * 8, y: 0.6, z: Math.sin(pokeYaw) * 8 },
          true,
        );
        if (ctx.poss.owner >= 0 && ctx.poss.owner !== i) {
          ctx.ctlStates[ctx.poss.owner].cooldown = TOUCH.dispossessCooldown;
        }
        ctx.poss.owner = -1;
        ctx.events.push({ kind: 'tackle', playerIndex: i });
        // body-first challenge on a recent carrier = foul risk
        if (ctx.lastTouch >= 0 && ctx.lastTouch !== i && ctx.teams[ctx.lastTouch] !== ctx.teams[i]) {
          const victim = players[ctx.lastTouch];
          const pd = Math.hypot(victim.pos.x - pl.pos.x, victim.pos.z - pl.pos.z);
          if (pd < 0.75 && distToBall > 0.75) {
            st.stunUntilTick = tick + Math.round(1.1 * tickRate);
            ctx.events.push({ kind: 'foul', playerIndex: i });
          }
        }
      }

      // ---- slide tackle ----
      if (inp.slide && !st.prevSlide && tick >= st.slideUntilTick) {
        const yaw = pl.speed > 0.5 ? Math.atan2(pl.velZ, pl.velX) : pl.yaw;
        st.slideDirX = Math.cos(yaw);
        st.slideDirZ = Math.sin(yaw);
        st.slideUntilTick = tick + Math.round(0.45 * tickRate);
        ctx.events.push({ kind: 'slide', playerIndex: i });
      }
    }

    // ---- slide motion + resolution ----
    if (tick < st.slideUntilTick) {
      // committed low lunge: velocity overridden, big reach
      pl.velX = st.slideDirX * 7.5;
      pl.velZ = st.slideDirZ * 7.5;
      if (distToBall < 1.35 && ballPlayable) {
        // won it: ball knocked on in slide direction, carrier dispossessed
        ball.setLinvel(
          { x: st.slideDirX * 7, y: 0.8, z: st.slideDirZ * 7 },
          true,
        );
        if (ctx.poss.owner >= 0 && ctx.poss.owner !== i) {
          ctx.ctlStates[ctx.poss.owner].cooldown = TOUCH.dispossessCooldown;
        }
        ctx.poss.owner = -1;
        st.slideUntilTick = tick; // slide consumed
        st.stunUntilTick = tick + Math.round(0.45 * tickRate); // get up
      } else if (ctx.lastTouch >= 0 && ctx.teams[ctx.lastTouch] !== ctx.teams[i]) {
        // body contact with the carrier without playing the ball = FOUL
        const victim = players[ctx.lastTouch];
        const pd = Math.hypot(victim.pos.x - pl.pos.x, victim.pos.z - pl.pos.z);
        if (pd < 0.7 && distToBall > 1.0) {
          st.slideUntilTick = tick;
          st.stunUntilTick = tick + Math.round(1.6 * tickRate);
          ctx.events.push({ kind: 'foul', playerIndex: i });
        }
      }
      if (tick === st.slideUntilTick && st.stunUntilTick <= tick) {
        // slide expired without winning it — recovery stun
        st.stunUntilTick = tick + Math.round(0.9 * tickRate);
      }
    }

    // stun: no movement input (caller zeroes input when stunned via player.step)
    // handled by match.ts gating inputs.

    // ---- scheduled strike lands at the contact frame ----
    if (st.pending && tick >= st.pending.tick) {
      const k = st.pending;
      st.pending = null;
      const d2 = Math.hypot(bp.x - pl.pos.x, bp.z - pl.pos.z);
      if (d2 <= KICK_RANGE && ballPlayable) {
        executeKick(ctx, i, k.kind, k.charge, k.yaw);
        st.kickCooldownUntil = tick + Math.round(0.4 * tickRate);
        // the ball is away — release it so the carry spring doesn't chase it
        ctx.poss.owner = -1;
        ctx.ctlStates[i].cooldown = 0.35;
        ctx.events.push({ kind: 'kick', playerIndex: i, detail: k.kind });
      }
    }
  }

  for (let i = 0; i < players.length; i++) {
    const st = states[i];
    const inp = inputs[i];
    st.prevPass = inp.pass;
    st.prevThrough = inp.through;
    st.prevShoot = inp.shoot;
    st.prevLob = inp.lob;
    st.prevTackle = inp.tackle;
    st.prevSlide = inp.slide;
  }
}

function noiseSign(tick: number, salt: number): boolean {
  let h = (tick * 2654435761 + salt * 40503) | 0;
  h ^= h >> 13;
  return (h & 1) === 1;
}

function executeKick(
  ctx: ActionCtx,
  i: number,
  kind: 'pass' | 'through' | 'shoot' | 'lob' | 'clear',
  charge: number,
  yaw: number,
) {
  const { ball, players, teams } = ctx;
  const pl = players[i];
  const attackX = teams[i] === 0 ? PITCH_5S.length / 2 : -PITCH_5S.length / 2;

  let dirX = Math.cos(yaw);
  let dirZ = Math.sin(yaw);
  let speed: number = KICK.passSpeed;
  let loft = 0.02;
  let sideSpin = 0; // rad/s around +y — curls the ball via Magnus

  const mates = players
    .map((p, idx) => ({ p, idx }))
    .filter((m) => m.idx !== i && teams[m.idx] === teams[i]);

  const bestInCone = (coneDeg: number, lead: number) => {
    let best: { x: number; z: number; d: number } | null = null;
    let bestScore = Infinity;
    for (const m of mates) {
      const mdx = m.p.pos.x - pl.pos.x;
      const mdz = m.p.pos.z - pl.pos.z;
      const d = Math.hypot(mdx, mdz);
      if (d < 1.5) continue;
      let ang = Math.atan2(mdz, mdx) - yaw;
      while (ang > Math.PI) ang -= Math.PI * 2;
      while (ang < -Math.PI) ang += Math.PI * 2;
      if (Math.abs(ang) > (coneDeg * Math.PI) / 360) continue;
      const score = d + Math.abs(ang) * 8;
      if (score < bestScore) {
        bestScore = score;
        const v = Math.max(8, 6 + d * 0.9);
        const t = (d / v) * lead;
        best = { x: m.p.pos.x + m.p.velX * t, z: m.p.pos.z + m.p.velZ * t, d };
      }
    }
    return best;
  };

  if (kind === 'pass') {
    const t = bestInCone(110, 0.9);
    if (t) {
      const a = Math.atan2(t.z - pl.pos.z, t.x - pl.pos.x);
      dirX = Math.cos(a);
      dirZ = Math.sin(a);
      speed = clamp(6 + t.d * 0.95, 8, KICK.drivenSpeed);
    } else {
      speed = 11;
    }
    loft = 0.02;
  } else if (kind === 'through') {
    // lead the runner HARD, and bias the target toward goal
    const t = bestInCone(140, 1.8);
    if (t) {
      const gx = t.x + Math.sign(attackX) * 2.0;
      const a = Math.atan2(t.z - pl.pos.z, gx - pl.pos.x);
      dirX = Math.cos(a);
      dirZ = Math.sin(a);
      speed = clamp(8 + t.d * 1.0, 10, 20);
    } else {
      speed = 14;
    }
    loft = 0.06;
  } else if (kind === 'shoot') {
    // aim at goal mouth; placement from how far off-axis you're facing
    const gz = clamp(Math.sin(yaw) * 2.2, -1, 1) * (PITCH_5S.goalWidth / 2 - 0.25);
    const a = Math.atan2(gz - pl.pos.z, attackX - pl.pos.x);
    dirX = Math.cos(a);
    dirZ = Math.sin(a);
    speed = KICK.shotSpeedMin + (KICK.shotSpeedMax - KICK.shotSpeedMin) * charge;
    loft = 0.04 + 0.20 * charge;
    // a touch of curl away from the placement side — shots feel alive
    sideSpin = -Math.sign(gz) * (2 + 5 * charge);
  } else if (kind === 'lob') {
    speed = KICK.lobSpeed;
    loft = Math.tan((KICK.lobLoftDeg * Math.PI) / 180);
    const t = bestInCone(150, 1.2);
    if (t) {
      const a = Math.atan2(t.z - pl.pos.z, t.x - pl.pos.x);
      dirX = Math.cos(a);
      dirZ = Math.sin(a);
      speed = clamp(9 + t.d * 0.85, 12, 21);
    }
  } else {
    // clear: keeper hoof upfield
    const a = Math.atan2(0 - pl.pos.z, attackX - pl.pos.x);
    dirX = Math.cos(a);
    dirZ = Math.sin(a);
    speed = 20;
    loft = Math.tan((26 * Math.PI) / 180);
  }

  const vh = speed / Math.hypot(1, loft);
  const vy = vh * loft;
  ball.setLinvel({ x: dirX * vh, y: vy, z: dirZ * vh }, true);
  // spin: backspin on lofted balls, side spin for curl
  const backspin = kind === 'lob' ? -4 : kind === 'shoot' ? -1 : 0;
  ball.setAngvel(
    {
      x: -dirZ * backspin * Math.PI * 2,
      y: sideSpin,
      z: dirX * backspin * Math.PI * 2,
    },
    true,
  );
  ctx.lastTouch = i;
}
