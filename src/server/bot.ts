import { CONFIG as C } from '../shared/config';
import type { Entity, Room } from './room';

// Dead-simple fill-in bot, runs every tick:
//  - on the ball  -> push toward the opponent goal (which also sets facing)
//                    while charging a kick; releasing fires it goalward
//  - nearest mate -> chase the ball
//  - everyone else-> loiter between the ball and own goal, spread vertically
export function botThink(room: Room, e: Entity) {
  const ball = room.ball;
  const mates = [...room.entities.values()].filter((p) => p.team === e.team);
  const distToBall = (p: Entity) => Math.hypot(ball.x - p.x, ball.y - p.y);

  let nearest = mates[0];
  for (const p of mates) if (distToBall(p) < distToBall(nearest)) nearest = p;

  const attackX = e.team === 'A' ? C.PITCH_W : 0;
  const defendX = e.team === 'A' ? 0 : C.PITCH_W;

  let tx: number, ty: number;
  if (distToBall(e) < C.KICK_RADIUS * 0.9) {
    // On the ball: steer at the goal mouth and charge. Far out = longer
    // charge (bigger kick), close in = quick poke.
    tx = attackX;
    ty = C.PITCH_H / 2;
    const far = Math.abs(attackX - e.x) > C.PITCH_W * 0.45;
    e.input.kick = e.kickHeldMs < (far ? 450 : 250);
  } else {
    e.input.kick = false;
    if (nearest === e) {
      tx = ball.x;
      ty = ball.y;
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
