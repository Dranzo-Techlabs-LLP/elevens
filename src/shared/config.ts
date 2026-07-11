// ============================================================
// ALL game tunables live here. Tweak, save — `tsx watch` restarts
// the server and esbuild rebuilds the client automatically.
// Units: world pixels (the client scales the pitch to fit any screen).
// ============================================================
export const CONFIG = {
  PORT: 3011,

  // --- match ---
  TEAM_SIZE: 3,            // players per team (humans + fill-in bots)
  MATCH_SECONDS: 180,      // match length
  GOAL_PAUSE_MS: 1800,     // freeze after a goal before kickoff

  // --- simulation ---
  TICK_RATE: 30,           // server ticks (and snapshot broadcasts) per second

  // --- pitch ---
  PITCH_W: 900,
  PITCH_H: 560,
  GOAL_WIDTH: 180,         // opening in each end wall

  // --- players ---
  PLAYER_RADIUS: 14,
  PLAYER_ACCEL: 1500,      // acceleration toward joystick direction
  PLAYER_SPEED: 230,       // max speed
  PLAYER_FRICTION: 6,      // damping per second when no input

  // --- ball ---
  BALL_RADIUS: 9,
  BALL_FRICTION: 0.9,      // exponential rolling friction per second (on grass)
  BALL_AIR_DRAG: 0.15,     // much lighter drag while airborne
  BALL_GRAVITY: 900,       // height units/s^2 pulling the ball down
  BALL_BOUNCE: 0.55,       // vertical energy kept on landing
  WALL_BOUNCE: 0.65,       // energy kept when bouncing off walls
  DRIBBLE_PUSH: 60,        // extra nudge the ball gets when a player touches it

  // --- ball control / possession ---
  CONTROL_RADIUS: 44,      // within this of the ball = can take possession
  CONTROL_MAX_REL_SPEED: 300, // faster incoming ball must be trapped first
  TRAP_DAMP: 0.35,         // first touch keeps this fraction of ball speed
  CARRY_SPRING: 12,        // how snappily the carried ball sticks to the feet
  DRIBBLE_LEAD: 0.045,     // extra lead per unit of speed (sprint = knock-ons)
  STEAL_RATIO: 0.75,       // challenger must be this fraction closer to steal
  KICKABLE_HEIGHT: 55,     // ball above this is out of reach (no kick/touch)
  KICK_COOLDOWN_TICKS: 8,  // after kicking, can't re-control (~270ms @30Hz)

  // --- kicking (one button, charge picks the ball type) ---
  // tap        -> short ground pass
  // half hold  -> driven long pass, low skimmer
  // full hold  -> lofted long ball / shot
  KICK_RADIUS: 36,         // ball must be within this of player center
  KICK_MIN: 340,           // ball speed for an instant tap
  KICK_MAX: 800,           // ball speed at full charge
  KICK_CHARGE_MS: 800,     // hold duration for full charge
  KICK_LIFT_BASE: 0.04,    // loft at low charge (stays on the deck)
  KICK_LIFT_RANGE: 0.42,   // extra loft gained across the ramp below
  KICK_LIFT_RAMP0: 0.45,   // charge where loft starts ramping in
  KICK_LIFT_RAMP1: 0.95,   // charge where loft is maxed

  // --- goal frame ---
  GOAL_HEIGHT: 110,        // crossbar; ball crossing the line above this bounces

  // --- netcode ---
  INTERP_DELAY_MS: 100,    // client renders this far in the past (jitter buffer)

  // --- misc ---
  BOT_FILL: true,          // fill empty slots with bots when the match starts
} as const;
