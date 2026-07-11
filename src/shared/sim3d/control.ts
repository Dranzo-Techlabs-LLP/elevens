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

    if (relSpeed > tune.gripSpeed) {
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
    } else if (plSpeed > 0.4) {
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
    // slow ball + slow player inside reach: leave it — walking up to a dead
    // ball shouldn't teleport it; your next movement tick will touch it
  }
  return events;
}
