import { CONFIG as C } from '../shared/config';
import type { Entity, Room } from './room';

// Fill-in bot brain, runs every tick. Roles:
//  - KEEPER: the bot nearest its own goal guards the mouth, tracks the ball's
//    y, rushes out to smother a ball threatening the box, and clears long
//  - on the ball: shoot in range (with distance-scaled inaccuracy), pass to
//    the most advanced teammate under pressure, otherwise dribble upfield
//  - nearest outfielder chases the ball
//  - everyone else loiters between the ball and their own goal
export function botThink(room: Room, e: Entity) {
  const ball = room.ball;
  const mates = [...room.entities.values()].filter((p) => p.team === e.team);
  const distToBall = (p: Entity) => Math.hypot(ball.x - p.x, ball.y - p.y);

  const attackX = e.team === 'A' ? C.PITCH_W : 0;
  const defendX = e.team === 'A' ? 0 : C.PITCH_W;

  // keeper = the bot currently deepest toward its own goal
  const bots = mates.filter((m) => m.bot);
  const keeper = bots.length
    ? bots.reduce((a, b) => (Math.abs(defendX - a.x) < Math.abs(defendX - b.x) ? a : b))
    : undefined;

  // the chaser is always an OUTFIELDER — the keeper never abandons the goal
  // to chase, otherwise dribblers get a free run at an empty net
  const outfield = mates.filter((m) => m !== keeper);
  let nearest = outfield[0] ?? mates[0];
  for (const p of outfield) if (distToBall(p) < distToBall(nearest)) nearest = p;

  let tx: number, ty: number;

  if (distToBall(e) < C.KICK_RADIUS * 0.9) {
    // ---- on the ball ----
    const dGoal = Math.abs(attackX - e.x);
    const opponents = [...room.entities.values()].filter((p) => p.team !== e.team);
    const pressured = opponents.some((o) => Math.hypot(o.x - e.x, o.y - e.y) < 75);
    const ahead = mates
      .filter((m) => m !== e)
      .sort((a, b) => Math.abs(attackX - a.x) - Math.abs(attackX - b.x))[0];

    if (e === keeper && ahead) {
      // keepers don't dribble out — clear it long to the most advanced mate
      tx = ahead.x;
      ty = ahead.y;
      e.input.kick = e.kickHeldMs < 480;
    } else if (dGoal < C.PITCH_W * 0.33) {
      // shooting range: strike at goal. Aim wobbles more with distance so
      // long shots can miss; close-range pokes are true.
      const wob = Math.sin(room.tick * 0.07 + e.y * 0.13);
      tx = attackX;
      ty = C.PITCH_H / 2 + wob * C.GOAL_WIDTH * 0.9 * (dGoal / (C.PITCH_W * 0.33));
      e.input.kick = e.kickHeldMs < (dGoal > C.PITCH_W * 0.2 ? 340 : 220);
    } else if (pressured && ahead) {
      // pass: face the teammate, charge scales with distance (long = loft)
      tx = ahead.x;
      ty = ahead.y;
      const dm = Math.hypot(ahead.x - e.x, ahead.y - e.y);
      e.input.kick = e.kickHeldMs < Math.min(560, 160 + dm * 0.9);
    } else {
      // dribble upfield (possession carry keeps the ball at the feet)
      tx = attackX;
      ty = C.PITCH_H / 2;
      e.input.kick = false;
    }
  } else {
    e.input.kick = false;
    const mouthTop = C.PITCH_H / 2 - C.GOAL_WIDTH / 2 + 12;
    const mouthBot = C.PITCH_H / 2 + C.GOAL_WIDTH / 2 - 12;

    if (e === keeper) {
      // ---- goalkeeper ----
      const threat =
        Math.abs(ball.x - defendX) < 190 && ball.y > mouthTop - 50 && ball.y < mouthBot + 50;
      if (threat) {
        // rush the ball to smother/clear it
        tx = ball.x;
        ty = ball.y;
      } else {
        // hold the line, tracking the ball's height
        tx = defendX + (e.team === 'A' ? 26 : -26);
        ty = Math.max(mouthTop, Math.min(mouthBot, ball.y));
      }
    } else if (nearest === e) {
      tx = ball.x;
      ty = ball.y;
    } else {
      // hang back between ball and own goal, offset by index for spacing
      const idx = Math.max(0, mates.indexOf(e));
      tx = (ball.x + defendX) / 2;
      ty = C.PITCH_H / 2 + (idx - (mates.length - 1) / 2) * 110;
    }
  }

  const dx = tx - e.x, dy = ty - e.y;
  const d = Math.hypot(dx, dy);
  if (d > 6) {
    e.input.mx = dx / d;
    e.input.my = dy / d;
  } else {
    e.input.mx = 0;
    e.input.my = 0;
  }
}
