// ============================================================
// SIM-GRADE CONFIG — ALL SI UNITS (meters, kilograms, seconds, newtons)
// Single source of truth for the Rapier simulation on BOTH server and
// client. Everything here is live-tunable via the Tweakpane debug panel
// (?debug=1 / physics lab), so tune feel without rebuilding.
// ============================================================

// ---------- BALL — FIFA Size 5 ----------
export const BALL = {
  radius: 0.11,          // m  (circumference ~69cm)
  mass: 0.43,            // kg
  restitution: 0.8,      // bounce energy kept (FIFA spec range on turf)
  friction: 0.4,         // surface friction vs grass/players

  // aerodynamics (applied manually each tick — Rapier has no aero)
  airDensity: 1.225,     // kg/m^3 at sea level
  dragCd: 0.25,          // drag coefficient for a scuffed match ball
  // Magnus force scalar: F = magnusK * (omega x v). Physically
  // ~= Cl * rho * A * r, folded into one tunable knob because Cl itself
  // varies with spin ratio — this is the "how much does it bend" dial.
  magnusK: 0.0011,
  spinDecay: 0.12,       // 1/s exponential angular velocity decay in flight
  // grass decel while grounded: base rolling resistance PLUS a skid term
  // that scales with speed (a hard pass skids before it rolls, shedding
  // pace fast; a trickling ball just rolls). decel = base + skid * speed
  rollFriction: 1.4,     // m/s^2 base rolling resistance
  rollSkid: 0.16,        // extra decel per m/s of ground speed
  rollSpinCouple: 0.9,   // how strongly rolling re-aligns spin with travel
} as const;

// ---------- PLAYERS ----------
export const PLAYER = {
  height: 1.82,          // m  (avg; physique variants scale 1.70-1.95)
  mass: 78,              // kg
  capsuleRadius: 0.3,    // m collider radius
  eyeHeight: 1.7,

  // locomotion (m/s, m/s^2) — the momentum model lives on these
  walkSpeed: 1.8,
  jogSpeed: 3.6,
  sprintSpeed: 8.5,      // top sprint 8-9 m/s
  accel: 5.0,            // ground acceleration
  decel: 7.0,            // braking (stronger than accel — studs dig in)
  // turn rate CAP in rad/s, interpolated by speed: at walk you pivot almost
  // freely, at full sprint you carve a ~4m radius arc. This is what kills
  // ice-skating 180s.
  turnRateWalk: 12.0,
  turnRateSprint: 2.2,

  // stamina (0..1)
  staminaDrainSprint: 0.06, // per second sprinting
  staminaRegen: 0.035,      // per second below jog speed
  tiredSpeedMult: 0.82,     // top-speed multiplier at zero stamina
  tiredControlMult: 1.5,    // touch error multiplier at zero stamina
} as const;

// ---------- PITCHES ----------
// Small-sided 5v5 (default): 40m x 20m, futsal-class goals 3m x 2m.
export const PITCH_5S = {
  length: 40,            // m (x axis, goals at each end)
  width: 20,             // m
  goalWidth: 3,
  goalHeight: 2,
  goalDepth: 1.2,
  wallRebound: false,    // out of bounds = restart (no arena walls)
} as const;

// Full-size constants kept available for the 11v11 future.
export const PITCH_FULL = {
  length: 105,
  width: 68,
  goalWidth: 7.32,
  goalHeight: 2.44,
  goalDepth: 2.0,
  wallRebound: false,
} as const;

export const MATCH = {
  teamSize: 5,           // 5v5 default (config constant, not hardcoded)
  tickRate: 30,          // server fixed step Hz
  labTickRate: 60,       // physics lab runs finer for feel evaluation
} as const;

// ---------- BALL CONTROL / TOUCH MODEL ----------
// The whole feel of the game. The ball is NEVER parented/glued: control is a
// sequence of physical impulses — a trap kills incoming velocity, dribble
// touches nudge it ahead, and between touches the ball obeys pure physics.
export const TOUCH = {
  controlRadius: 0.9,    // m — reachable ball distance for a touch
  ballMaxHeight: 0.5,    // m — above this the ball is out of ground-control reach
  gripSpeed: 4.0,        // m/s relative speed below which dribble touches engage
                         // (faster balls must be trapped first)

  // dribble touches: ball velocity set to player direction * player speed *
  // touchSpeed. >1 means the ball runs ahead and you chase onto it.
  dribbleTouchSpeed: 1.10,
  sprintTouchSpeed: 1.26, // sprinting: bigger knock-ons (but playable)
  touchCooldown: 0.22,    // s between contacts at jog
  sprintTouchCooldown: 0.30,
  // soft collect: between touches, a nearby slow ball is eased toward a spot
  // just ahead of the feet with a CAPPED acceleration — kills the shin-pong
  // jitter without ever gluing the ball
  collectRadius: 0.65,
  collectAccel: 14,       // m/s^2 cap
  collectLead: 0.38,      // m ahead of the feet
  touchErrorDeg: 4,       // aim noise per touch (deterministic rng)
  sprintErrorDeg: 9,      // sprint touches are wilder
  tiredErrorDeg: 14,      // added at zero stamina

  // first touch / trap: fraction of incoming relative velocity KILLED.
  // standing + composed = ball dies at your feet; at sprint it bounces off.
  trapKill: 0.85,
  trapKillMoving: 0.55,
  trapKillSprint: 0.32,
  trapCooldown: 0.22,

  // shielding: slow, wide stance between opponent and ball
  shieldSpeed: 1.6,       // m/s cap while shielding
  shieldRadiusBonus: 0.25 // extra control reach while shielding
} as const;

// ---------- KICKS (M4 consumers) ----------
export const KICK = {
  passSpeed: 14,         // m/s ground pass
  drivenSpeed: 22,
  shotSpeedMin: 18,
  shotSpeedMax: 34,
  lobSpeed: 19,
  lobLoftDeg: 28,
  chargeTimeMs: 900,
  contactDelayMs: 140,   // animation contact frame — kick fires this long
                         // after the trigger, masking net latency honestly
} as const;
