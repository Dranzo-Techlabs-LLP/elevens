import { CONFIG as C } from '../shared/config';
import type { Entity, Room } from './room';

// Fill-in bot brain using the PES action set (pass/shoot/lob/tackle/sprint).
// Roles:
//  - KEEPER: bot nearest its own goal guards the mouth, rushes a ball that
//    threatens the box, and LOBS clear when it wins possession
//  - on the ball: shoot in range (placement handled by the shot logic),
//    pass under pressure, otherwise sprint-dribble upfield
//  - nearest outfielder chases; when the opponent has the ball close by it
//    taps PASS to lunge-tackle (server treats that edge as pressure)
//  - everyone else loiters between the ball and their own goal
export function botThink(room: Room, e: Entity) {
  const ball = room.ball;
  const mates = [...room.entities.values()].filter((p) => p.team === e.team);
  const distToBall = (p: Entity) => Math.hypot(ball.x - p.x, ball.y - p.y);

  const attackX = e.team === 'A' ? C.PITCH_W : 0;
  const defendX = e.team === 'A' ? 0 : C.PITCH_W;

  const bots = mates.filter((m) => m.bot);
  const keeper = bots.length
    ? bots.reduce((a, b) => (Math.abs(defendX - a.x) < Math.abs(defendX - b.x) ? a : b))
    : undefined;

  // chaser is always an outfielder — keeper never abandons the net
  const outfield = mates.filter((m) => m !== keeper);
  let nearest = outfield[0] ?? mates[0];
  for (const p of outfield) if (distToBall(p) < distToBall(nearest)) nearest = p;

  const iHaveBall = room.ownerId === e.id;
  const opponentHasBall =
    room.ownerId !== null && room.entities.get(room.ownerId)?.team !== e.team;

  // default: buttons off (rising edges below re-trigger as needed)
  e.input.pass = false;
  e.input.shoot = false;
  e.input.lob = false;
  e.input.sprint = false;

  let tx: number, ty: number;

  if (iHaveBall || distToBall(e) < C.KICK_RADIUS * 0.9) {
    // ---- on the ball ----
    const dGoal = Math.abs(attackX - e.x);
    const opponents = [...room.entities.values()].filter((p) => p.team !== e.team);
    const pressured = opponents.some((o) => Math.hypot(o.x - e.x, o.y - e.y) < 75);

    if (e === keeper) {
      // clear it long, no dribbling out of the box
      tx = attackX;
      ty = C.PITCH_H / 2;
      e.input.lob = e.lobHeldMs < 120;
    } else if (dGoal < C.PITCH_W * 0.33) {
      // shooting range: face goal, charge a shot (placement is automatic)
      tx = attackX;
      ty = C.PITCH_H / 2;
      e.input.shoot = e.shootHeldMs < (dGoal > C.PITCH_W * 0.2 ? 340 : 200);
    } else if (pressured) {
      // play the pass — targeting is automatic, just face upfield-ish
      tx = attackX;
      ty = e.y;
      e.input.pass = e.passHeldMs < 80;
    } else {
      // sprint-dribble upfield
      tx = attackX;
      ty = C.PITCH_H / 2;
      e.input.sprint = true;
    }
  } else {
    const mouthTop = C.PITCH_H / 2 - C.GOAL_WIDTH / 2 + 12;
    const mouthBot = C.PITCH_H / 2 + C.GOAL_WIDTH / 2 - 12;

    if (e === keeper) {
      // ---- goalkeeper ----
      const threat =
        Math.abs(ball.x - defendX) < 190 && ball.y > mouthTop - 50 && ball.y < mouthBot + 50;
      if (threat) {
        tx = ball.x;
        ty = ball.y;
      } else {
        tx = defendX + (e.team === 'A' ? 26 : -26);
        ty = Math.max(mouthTop, Math.min(mouthBot, ball.y));
      }
    } else if (nearest === e) {
      // chase; when the opponent is carrying it close by, lunge-tackle
      tx = ball.x;
      ty = ball.y;
      e.input.sprint = distToBall(e) > 120;
      if (opponentHasBall && distToBall(e) < 110 && room.tick >= e.tackleCooldownUntil) {
        e.input.pass = room.tick % 4 < 2; // pulsed press -> rising edge -> lunge
      }
    } else {
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
