// ============================================================
// ISOMORPHIC PLAYER MOVEMENT — runs identically on server (Node) and
// client (prediction). No three.js imports allowed in here, only Rapier.
//
// The model that makes movement feel "weighty":
//  1. Velocity, not position, is what input steers.
//  2. Speed changes are clamped by accel (throttle) / decel (studs dig in).
//  3. The velocity VECTOR can only rotate at a speed-dependent turn rate:
//     near-free pivot at walking pace, ~2.2 rad/s at full sprint. That is
//     the physical "turning radius" (r = v / turnRate ≈ 3.9m at sprint).
//  4. Asking for a near-reversal (>120°) forces braking first — you cannot
//     carry sprint speed through a 180.
//  5. Stamina drains while sprinting, regenerates below jog pace, and a
//     tired player loses top speed (control penalties consumed in M3).
// ============================================================
import type RAPIER from '@dimforge/rapier3d-compat';
import { PLAYER } from '../config3d';

export interface MoveInput {
  x: number; // desired direction, world space (not necessarily unit)
  z: number;
  sprint: boolean;
  shield?: boolean; // hold-up play: slow, wide, body between ball and opponent
}

/** Mutable copy of the movement constants so a debug panel can tune live.
 *  The server just uses the defaults. */
export type MoveTune = {
  walkSpeed: number;
  jogSpeed: number;
  sprintSpeed: number;
  accel: number;
  decel: number;
  turnRateWalk: number;
  turnRateSprint: number;
  staminaDrainSprint: number;
  staminaRegen: number;
  tiredSpeedMult: number;
};
export const defaultMoveTune = (): MoveTune => ({
  walkSpeed: PLAYER.walkSpeed,
  jogSpeed: PLAYER.jogSpeed,
  sprintSpeed: PLAYER.sprintSpeed,
  accel: PLAYER.accel,
  decel: PLAYER.decel,
  turnRateWalk: PLAYER.turnRateWalk,
  turnRateSprint: PLAYER.turnRateSprint,
  staminaDrainSprint: PLAYER.staminaDrainSprint,
  staminaRegen: PLAYER.staminaRegen,
  tiredSpeedMult: PLAYER.tiredSpeedMult,
});

const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class SimPlayer {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  private controller: RAPIER.KinematicCharacterController;

  velX = 0;
  velZ = 0;
  yaw = 0; // facing, radians around +y (0 = +x)
  stamina = 1;
  /** last applied turn rate (rad/s) — telemetry/animation lean */
  yawRate = 0;

  constructor(
    private R: typeof RAPIER,
    private world: RAPIER.World,
    x: number,
    z: number,
  ) {
    const centerY = PLAYER.height / 2;
    this.body = world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, centerY, z),
    );
    const halfCyl = (PLAYER.height - 2 * PLAYER.capsuleRadius) / 2;
    this.collider = world.createCollider(
      R.ColliderDesc.capsule(halfCyl, PLAYER.capsuleRadius).setFriction(0.4),
      this.body,
    );
    // small skin gap; lets us slide around posts/players instead of sticking
    this.controller = world.createCharacterController(0.02);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
  }

  get pos() {
    return this.body.translation();
  }
  get speed() {
    return Math.hypot(this.velX, this.velZ);
  }

  step(dt: number, input: MoveInput, tune: MoveTune = defaultMoveTune()) {
    const mag = clamp(Math.hypot(input.x, input.z), 0, 1);
    let dx = 0, dz = 0;
    if (mag > 0.01) {
      const im = Math.hypot(input.x, input.z);
      dx = input.x / im;
      dz = input.z / im;
    }

    const sp = this.speed;

    // --- stamina-limited target speed ---
    // input magnitude walks the walk->jog range; sprint button reaches for
    // sprintSpeed, scaled down as stamina empties.
    const tiredMult = tune.tiredSpeedMult + (1 - tune.tiredSpeedMult) * this.stamina;
    let target = 0;
    if (mag > 0.01) {
      target = input.sprint ? tune.sprintSpeed * tiredMult : tune.jogSpeed;
      target *= mag;
    }
    // shielding is deliberate: slow, planted steps
    if (input.shield) target = Math.min(target, 1.6);

    // --- turn-rate-capped steering (the turning radius) ---
    this.yawRate = 0;
    if (sp > 0.3 && mag > 0.01) {
      const cur = Math.atan2(this.velZ, this.velX);
      const want = Math.atan2(dz, dx);
      const diff = wrapAngle(want - cur);
      const tr =
        tune.turnRateWalk +
        (tune.turnRateSprint - tune.turnRateWalk) * clamp(sp / tune.sprintSpeed, 0, 1);
      const applied = clamp(diff, -tr * dt, tr * dt);
      const na = cur + applied;
      this.velX = Math.cos(na) * sp;
      this.velZ = Math.sin(na) * sp;
      this.yawRate = applied / dt;
      // asking for a near-reversal: brake — no carrying sprint through a 180
      if (Math.abs(diff) > 2.1) target = Math.min(target, tune.jogSpeed * 0.5);
    }

    // --- accelerate / brake along the (now rotated) travel direction ---
    const rate = target > sp ? tune.accel : tune.decel;
    const ns = sp + clamp(target - sp, -rate * dt, rate * dt);
    if (mag > 0.01) {
      if (sp > 0.3) {
        const inv = 1 / Math.max(sp, 1e-6);
        this.velX = this.velX * inv * ns;
        this.velZ = this.velZ * inv * ns;
      } else {
        // from (near) standstill you step off in the input direction
        this.velX = dx * ns;
        this.velZ = dz * ns;
      }
    } else if (sp > 0) {
      const dec = Math.max(0, sp - tune.decel * dt);
      const inv = sp > 1e-6 ? dec / sp : 0;
      this.velX *= inv;
      this.velZ *= inv;
    }

    // --- stamina ---
    if (input.sprint && this.speed > tune.jogSpeed * 0.9) {
      this.stamina = clamp(this.stamina - tune.staminaDrainSprint * dt, 0, 1);
    } else if (this.speed < tune.jogSpeed) {
      this.stamina = clamp(this.stamina + tune.staminaRegen * dt, 0, 1);
    }

    // --- facing follows travel (or input when stationary) ---
    const faceTarget =
      this.speed > 0.5 ? Math.atan2(this.velZ, this.velX) : mag > 0.01 ? Math.atan2(dz, dx) : this.yaw;
    this.yaw += wrapAngle(faceTarget - this.yaw) * (1 - Math.exp(-10 * dt));

    // --- move through Rapier's character controller (slides on contacts) ---
    this.controller.computeColliderMovement(this.collider, {
      x: this.velX * dt,
      y: 0,
      z: this.velZ * dt,
    });
    const m = this.controller.computedMovement();
    const p = this.body.translation();
    this.body.setNextKinematicTranslation({
      x: p.x + m.x,
      y: PLAYER.height / 2,
      z: p.z + m.z,
    });
  }
}
