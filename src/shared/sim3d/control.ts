// ============================================================
// ISOMORPHIC BALL CONTROL — ownership + carry spring (PES close control).
// No three.js. Runs on server and in client prediction.
//
// Model:
//  - OWNERSHIP: the nearest eligible player inside collectRadius with the
//    ball slow-relative owns it (hysteresis keeps the owner unless a
//    challenger is clearly closer; a fresh victim of a tackle is locked out
//    for dispossessCooldown).
//  - CARRY: below sprint pace the owned ball is spring-tracked to a spot
//    ahead of the feet with a CAPPED acceleration — turning carries the
//    ball around with you. The cap means a tackle/kick impulse (which
//    instantly puts the ball far outside what the spring can counter)
//    breaks control naturally: that is how the ball "leaves him when
//    kicked or tackled".
//  - SPRINT: knock-on touches — ball punched ahead, chased, still yours
//    inside the chase band.
//  - TRAP: a genuinely fast INCOMING ball gets a velocity-kill first touch;
//    quality depends on standing/moving/sprinting and stamina.
// ============================================================
import type RAPIER from '@dimforge/rapier3d-compat';
import { TOUCH } from '../config3d';
import type { SimPlayer } from './player';

export type ControlTune = { -readonly [K in keyof typeof TOUCH]: number };
export const defaultControlTune = (): ControlTune => ({ ...TOUCH } as ControlTune);

export interface ControlEvent {
  type: 'trap' | 'touch' | 'steal';
  playerIndex: number;
  intensity: number;
}

export interface ControlState {
  cooldown: number; // seconds until this player may touch/own again
}

/** shared possession state — lives on the Match, passed in every tick */
export interface Possession {
  owner: number;       // player index, -1 none
  ownerSince: number;  // tick ownership last changed
}

function noise(tick: number, salt: number): number {
  let h = (tick * 374761393 + salt * 668265263) | 0;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h & 0xffff) / 0x8000) - 1;
}

export function stepBallControl(
  dt: number,
  tick: number,
  ball: RAPIER.RigidBody,
  players: SimPlayer[],
  states: ControlState[],
  shielding: boolean[],
  poss: Possession,
  tune: ControlTune = defaultControlTune(),
  isBot: boolean[] = [],
  // dead-ball lock: while a restart ceremony (or a keeper's hand-hold) is
  // active, ONLY this player may claim or touch the ball (-1 = open play)
  lockedTo = -1,
): ControlEvent[] {
  const events: ControlEvent[] = [];
  const bp = ball.translation();
  const bv = ball.linvel();

  for (const s of states) s.cooldown = Math.max(0, s.cooldown - dt);

  if (bp.y > tune.ballMaxHeight) {
    // airborne: nobody has close control — EXCEPT a keeper holding the
    // ball in his hands at chest height (the match glues it there)
    if (lockedTo < 0) poss.owner = -1;
    return events;
  }

  const dist = (i: number) => Math.hypot(bp.x - players[i].pos.x, bp.z - players[i].pos.z);
  const relSpeedOf = (i: number) =>
    Math.hypot(bv.x - players[i].velX, bv.z - players[i].velZ);

  // ---------- ownership resolution ----------
  const reach = (i: number) => tune.collectRadius + (shielding[i] ? tune.shieldRadiusBonus : 0);
  const eligible = (i: number) =>
    states[i].cooldown <= 0 && (lockedTo < 0 || i === lockedTo);

  // current owner keeps the ball while it stays playable
  if (poss.owner >= 0) {
    const o = poss.owner;
    const band = players[o].speed > 6.0 ? tune.sprintChaseBand : reach(o) * 1.5;
    if (!eligible(o) || dist(o) > band || relSpeedOf(o) > tune.carryBreakSpeed + players[o].speed) {
      poss.owner = -1; // lost it (kicked away / tackled / outran it)
    }
  }
  // nearest eligible challenger takes a free ball, or clearly beats the owner
  let nearest = -1;
  let nd = Infinity;
  const ballAbs = Math.hypot(bv.x, bv.z);
  for (let i = 0; i < players.length; i++) {
    if (!eligible(i)) continue;
    const d = dist(i);
    // claimable if the BALL is slow (running onto a still ball at any pace)
    // or the relative speed is low (moving together)
    const claimable = ballAbs < tune.carryBreakSpeed || relSpeedOf(i) < tune.carryBreakSpeed + 2;
    if (d < reach(i) && d < nd && claimable) {
      nearest = i;
      nd = d;
    }
  }
  if (nearest >= 0) {
    if (poss.owner < 0) {
      poss.owner = nearest;
      poss.ownerSince = tick;
    } else if (
      nearest !== poss.owner &&
      // contest bias: humans win 50/50s a bit more often than bots
      nd < dist(poss.owner) * (isBot[nearest] && !isBot[poss.owner] ? 0.45 : !isBot[nearest] && isBot[poss.owner] ? 0.75 : 0.6) &&
      tick - poss.ownerSince > 8
    ) {
      // clean steal: previous owner is locked out briefly
      states[poss.owner].cooldown = tune.dispossessCooldown;
      poss.owner = nearest;
      poss.ownerSince = tick;
      events.push({ type: 'steal', playerIndex: nearest, intensity: 1 });
    }
  }

  // ---------- per-player ball interaction ----------
  for (let i = 0; i < players.length; i++) {
    const pl = players[i];
    const st = states[i];
    if (st.cooldown > 0) continue;
    if (lockedTo >= 0 && i !== lockedTo) continue; // dead ball: hands off

    const d = dist(i);
    if (d > reach(i) && i !== poss.owner) continue;

    const relX = bv.x - pl.velX;
    const relZ = bv.z - pl.velZ;
    const relSpeed = Math.hypot(relX, relZ);
    const ballSpeed = Math.hypot(bv.x, bv.z);
    const plSpeed = pl.speed;
    const sprinting = plSpeed > 6.0;
    const closing = d > 1e-4
      ? (relX * (pl.pos.x - bp.x) + relZ * (pl.pos.z - bp.z)) / d
      : 0;

    // TRAP: genuinely incoming fast ball
    if (ballSpeed > tune.gripSpeed && relSpeed > tune.gripSpeed && closing > 2 && d < reach(i)) {
      let kill = tune.trapKill;
      if (sprinting) kill = tune.trapKillSprint;
      else if (plSpeed > 1.2) kill = tune.trapKillMoving;
      kill *= 0.7 + 0.3 * pl.stamina;
      ball.setLinvel(
        { x: pl.velX + relX * (1 - kill), y: Math.min(bv.y, 0.2), z: pl.velZ + relZ * (1 - kill) },
        true,
      );
      const w = ball.angvel();
      ball.setAngvel({ x: w.x * 0.25, y: w.y * 0.25, z: w.z * 0.25 }, true);
      st.cooldown = tune.trapCooldown;
      poss.owner = i;
      poss.ownerSince = tick;
      events.push({ type: 'trap', playerIndex: i, intensity: relSpeed });
      continue;
    }

    if (i !== poss.owner) continue;

    if (sprinting) {
      // SPRINT KNOCK-ON: punch it ahead on a cooldown, chase onto it
      if (d < reach(i) && st.cooldown <= 0) {
        const baseDir = Math.atan2(pl.velZ, pl.velX);
        const err =
          (noise(tick, i * 7 + 3) *
            (tune.sprintErrorDeg + tune.tiredErrorDeg * (1 - pl.stamina)) *
            Math.PI) /
          180;
        const out = Math.max(plSpeed * tune.sprintTouchSpeed, 1.2);
        ball.setLinvel(
          { x: Math.cos(baseDir + err) * out, y: bv.y, z: Math.sin(baseDir + err) * out },
          true,
        );
        st.cooldown = tune.sprintTouchCooldown;
        events.push({ type: 'touch', playerIndex: i, intensity: plSpeed });
      } else if (d < tune.sprintChaseBand) {
        // SPRINT CARRY ASSIST: between knock-ons the ball gets a weak steer
        // toward your CURRENT heading line — sprint-turning bends the ball
        // with your arc instead of it flying straight off your run
        const dirYaw = Math.atan2(pl.velZ, pl.velX);
        const tx = pl.pos.x + Math.cos(dirYaw) * Math.min(d, 1.2);
        const tz = pl.pos.z + Math.sin(dirYaw) * Math.min(d, 1.2);
        const wantVX = pl.velX + (tx - bp.x) * 4;
        const wantVZ = pl.velZ + (tz - bp.z) * 4;
        const dvx = wantVX - bv.x;
        const dvz = wantVZ - bv.z;
        const dvLen = Math.hypot(dvx, dvz);
        const maxDv = 10 * dt; // weak — a defender's body still wins the race
        const k2 = dvLen > maxDv ? maxDv / dvLen : 1;
        ball.setLinvel({ x: bv.x + dvx * k2, y: bv.y, z: bv.z + dvz * k2 }, true);
      }
    } else {
      // CARRY SPRING (the PES close control): ball continuously tracks a
      // point ahead of the feet — turning sweeps it around with you. The
      // acceleration cap keeps it honest physics: tackle impulses exceed
      // it and take the ball clean off you.
      const moving = plSpeed > 0.3;
      const dirYaw = moving ? Math.atan2(pl.velZ, pl.velX) : pl.yaw;
      const lead = moving ? tune.collectLead : tune.collectLead * 0.55;
      const tx = pl.pos.x + Math.cos(dirYaw) * lead;
      const tz = pl.pos.z + Math.sin(dirYaw) * lead;
      const wantVX = pl.velX + (tx - bp.x) * 10;
      const wantVZ = pl.velZ + (tz - bp.z) * 10;
      const dvx = wantVX - bv.x;
      const dvz = wantVZ - bv.z;
      const dvLen = Math.hypot(dvx, dvz);
      const maxDv = tune.collectAccel * dt;
      const k = dvLen > maxDv ? maxDv / dvLen : 1;
      ball.setLinvel({ x: bv.x + dvx * k, y: bv.y, z: bv.z + dvz * k }, true);
    }
  }
  return events;
}
