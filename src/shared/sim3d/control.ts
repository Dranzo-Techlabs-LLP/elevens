// ============================================================
// ISOMORPHIC BALL CONTROL — trap + dribble touches + shielding.
// No three.js. Runs on server and in client prediction.
//
// Model (no glue, ever):
//  - TRAP: a ball arriving faster than gripSpeed gets a velocity-kill
//    impulse when it enters your control radius. How much dies depends on
//    what you're doing: standing composed = dead at your feet; jogging =
//    some run-on; sprinting = it bounces 2m+ off you (heavy touch).
//  - DRIBBLE TOUCH: a slow ball in reach gets nudged along your travel
//    direction at touchSpeed x your speed, with deterministic aim noise
//    that grows with sprint and fatigue. Between touches the ball is free —
//    that separation is what makes tackles and interceptions possible.
//  - SHIELD: caps your speed, widens reach a little; the physical capsule
//    between opponent and ball does the actual protecting.
// ============================================================
import type RAPIER from '@dimforge/rapier3d-compat';
import { TOUCH } from '../config3d';
import type { SimPlayer } from './player';

export type ControlTune = { -readonly [K in keyof typeof TOUCH]: number };
export const defaultControlTune = (): ControlTune => ({ ...TOUCH } as ControlTune);

export interface ControlEvent {
  type: 'trap' | 'touch';
  playerIndex: number;
  /** relative speed at contact — anim/sfx intensity */
  intensity: number;
}

/** deterministic per-(tick,player) noise in [-1,1] — same on server & client */
function noise(tick: number, salt: number): number {
  let h = (tick * 374761393 + salt * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h & 0xffff) / 0x8000) - 1;
}

export interface ControlState {
  cooldown: number; // seconds until this player may touch again
}

export function stepBallControl(
  dt: number,
  tick: number,
  ball: RAPIER.RigidBody,
  players: SimPlayer[],
  states: ControlState[],
  shielding: boolean[],
  tune: ControlTune = defaultControlTune(),
): ControlEvent[] {
  const events: ControlEvent[] = [];
  const bp = ball.translation();
  const bv = ball.linvel();
  if (bp.y > tune.ballMaxHeight) {
    for (const s of states) s.cooldown = Math.max(0, s.cooldown - dt);
    return events; // airborne: ground control impossible
  }

  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    const st = states[i];
    st.cooldown = Math.max(0, st.cooldown - dt);
    if (st.cooldown > 0) continue;

    const pp = pl.pos;
    const dx = bp.x - pp.x;
    const dz = bp.z - pp.z;
    const dist = Math.hypot(dx, dz);
    const reach = tune.controlRadius + (shielding[i] ? tune.shieldRadiusBonus : 0);
    if (dist > reach) continue;

    const relX = bv.x - pl.velX;
    const relZ = bv.z - pl.velZ;
    const relSpeed = Math.hypot(relX, relZ);
    const plSpeed = pl.speed;
    const sprinting = plSpeed > 6.5;
    // closing speed: positive = the ball is coming AT me. A ball rolling
    // along with its carrier is never "incoming", however fast we both move —
    // that's a dribble, not a trap.
    const closing = dist > 1e-4 ? (relX * -dx + relZ * -dz) / dist : 0;

    if (relSpeed > tune.gripSpeed && closing > 2) {
      // ---- FIRST TOUCH / TRAP ----
      // kill a fraction of the RELATIVE velocity; what survives is the
      // "heaviness" of the touch and runs on physically
      let kill = tune.trapKill;
      if (sprinting) kill = tune.trapKillSprint;
      else if (plSpeed > 1.2) kill = tune.trapKillMoving;
      // fatigue makes every touch heavier
      kill *= 0.7 + 0.3 * pl.stamina;
      ball.setLinvel(
        {
          x: pl.velX + relX * (1 - kill),
          y: Math.min(bv.y, 0.2), // kill any hop too
          z: pl.velZ + relZ * (1 - kill),
        },
        true,
      );
      // spin mostly dies with the trap
      const w = ball.angvel();
      ball.setAngvel({ x: w.x * 0.25, y: w.y * 0.25, z: w.z * 0.25 }, true);
      st.cooldown = tune.trapCooldown;
      events.push({ type: 'trap', playerIndex: i, intensity: relSpeed });
    } else if (plSpeed > 0.4 && dist > tune.collectRadius) {
      // ---- DRIBBLE TOUCH ----
      // nudge along travel direction with speed- and fatigue-scaled error
      const baseDir = Math.atan2(pl.velZ, pl.velX);
      const errDeg =
        (sprinting ? tune.sprintErrorDeg : tune.touchErrorDeg) +
        tune.tiredErrorDeg * (1 - pl.stamina);
      const err = (noise(tick, i * 7 + 3) * errDeg * Math.PI) / 180;
      const dir = baseDir + err;
      const mult = sprinting ? tune.sprintTouchSpeed : tune.dribbleTouchSpeed;
      const out = Math.max(plSpeed * mult, 1.2); // even a slow walk moves it on
      ball.setLinvel({ x: Math.cos(dir) * out, y: bv.y, z: Math.sin(dir) * out }, true);
      st.cooldown = sprinting ? tune.sprintTouchCooldown : tune.touchCooldown;
      events.push({ type: 'touch', playerIndex: i, intensity: plSpeed });
    }
    // ---- SOFT COLLECT (no cooldown, no glue) ----
    // a close, slow ball is EASED toward a spot ahead of the feet with a
    // capped acceleration. This is the PES-smooth carry between touches:
    // the ball still obeys physics (an opponent's poke still wins it), it
    // just stops ping-ponging off your shins.
    if (dist <= tune.collectRadius && relSpeed < tune.gripSpeed && plSpeed > 0.3) {
      const dirYaw = Math.atan2(pl.velZ, pl.velX);
      const tx = pl.pos.x + Math.cos(dirYaw) * tune.collectLead;
      const tz = pl.pos.z + Math.sin(dirYaw) * tune.collectLead;
      const wantVX = pl.velX + (tx - bp.x) * 6;
      const wantVZ = pl.velZ + (tz - bp.z) * 6;
      const dvx = wantVX - bv.x;
      const dvz = wantVZ - bv.z;
      const dvLen = Math.hypot(dvx, dvz);
      const maxDv = tune.collectAccel * dt;
      const k2 = dvLen > maxDv ? maxDv / dvLen : 1;
      ball.setLinvel({ x: bv.x + dvx * k2, y: bv.y, z: bv.z + dvz * k2 }, true);
    }
  }
  return events;
}
