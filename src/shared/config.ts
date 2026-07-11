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

  // --- PES-style actions ---
  KICK_RADIUS: 36,         // ball must be within this of player center
  KICK_CHARGE_MS: 800,     // hold duration for full charge (shoot/lob)

  // pass: power is AUTOMATIC from target distance (PES-style), ground ball
  PASS_MIN: 360,
  PASS_MAX: 640,
  PASS_LIFT: 0.03,
  PASS_CONE_DEG: 100,      // teammates within this cone of facing are targets

  // lob / through ball: lofted, aimed at the most advanced open teammate
  LOB_MIN: 480,
  LOB_MAX: 800,
  LOB_LIFT: 0.58,          // apex must clear KICKABLE_HEIGHT or it's not a lob

  // shoot: hold = power; aim locks to the goal with placement from facing
  SHOT_MIN: 520,
  SHOT_MAX: 840,
  SHOT_LIFT_BASE: 0.06,
  SHOT_LIFT_RANGE: 0.26,
  SHOT_PLACE_MAX: 0.42,    // fraction of goal half-width you can place away from center

  // sprint (hold): faster, but the ball runs further ahead of your feet
  SPRINT_MULT: 1.35,
  SPRINT_ACCEL_MULT: 1.25,
  SPRINT_LEAD_MULT: 1.9,

  // tackle / pressure (PASS button while defending): lunge at the ball;
  // win it clean or stumble and recover
  TACKLE_SPEED: 540,
  TACKLE_TICKS: 6,          // lunge duration
  TACKLE_RECOVER_TICKS: 14, // stumble after a missed lunge (or being tackled)
  TACKLE_COOLDOWN_TICKS: 26,

  // --- goal frame ---
  GOAL_HEIGHT: 110,        // crossbar; ball crossing the line above this bounces

  // --- netcode ---
  INTERP_DELAY_MS: 100,    // client renders this far in the past (jitter buffer)

  // --- misc ---
  BOT_FILL: true,          // fill empty slots with bots when the match starts
} as const;
