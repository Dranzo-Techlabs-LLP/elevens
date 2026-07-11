// ============================================================
// BOT BRAIN for the 3D sim (server-side fill-ins for 5v5).
// Roles: keeper / chaser (nearest outfielder) / support. Uses the same
// PlayerFullInput surface as humans — no cheating.
// ============================================================
import { PITCH_5S } from '../config3d';
import { idleFullInput, type Match, type PlayerFullInput } from './match';

const L = PITCH_5S.length;
const W = PITCH_5S.width;

export function botThink(match: Match, i: number): PlayerFullInput {
  const inp = idleFullInput();
  const me = match.players[i];
  const meta = match.meta[i];
  const bp = match.ball.translation();
  const bv = match.ball.linvel();
  const attackX = meta.team === 0 ? L / 2 : -L / 2;
  const defendX = -attackX;

  const mates = match.meta
    .map((m, idx) => ({ m, idx }))
    .filter((e) => e.m.team === meta.team);
  const distBall = (idx: number) =>
    Math.hypot(bp.x - match.players[idx].pos.x, bp.z - match.players[idx].pos.z);

  // keeper = deepest bot on my team
  let keeperIdx = -1;
  let deep = -1;
  for (const e of mates) {
    if (!e.m.bot) continue;
    const d = Math.abs(defendX - match.players[e.idx].pos.x);
    if (deep < 0 || d < deep) {
      deep = d;
      keeperIdx = e.idx;
    }
  }
  // chaser = nearest non-keeper teammate to the ball
  let chaserIdx = -1;
  let best = 1e9;
  for (const e of mates) {
    if (e.idx === keeperIdx) continue;
    const d = distBall(e.idx);
    if (d < best) {
      best = d;
      chaserIdx = e.idx;
    }
  }

  const myDist = distBall(i);
  const iHaveIt = myDist < 1.0;
  const seek = (tx: number, tz: number, sprint = false) => {
    const dx = tx - me.pos.x;
    const dz = tz - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.25) {
      inp.mx = dx / d;
      inp.mz = dz / d;
      inp.sprint = sprint && d > 3;
    }
  };

  if (iHaveIt) {
    const dGoal = Math.abs(attackX - me.pos.x);
    const opponents = match.meta
      .map((m, idx) => ({ m, idx }))
      .filter((e) => e.m.team !== meta.team);
    const pressured = opponents.some(
      (e) =>
        Math.hypot(match.players[e.idx].pos.x - me.pos.x, match.players[e.idx].pos.z - me.pos.z) < 2.2,
    );
    if (i === keeperIdx) {
      // clear it — hoof upfield (lob release)
      seek(attackX, 0);
      pulse(inp, 'lob', match.tick);
    } else if (dGoal < L * 0.38) {
      seek(attackX, 0);
      // charge a shot: hold shoot for ~0.35s then release
      inp.shoot = match.actStates[i].shootHeldMs < 350;
    } else if (pressured) {
      seek(attackX, me.pos.z);
      pulse(inp, 'pass', match.tick);
    } else {
      seek(attackX, 0, true); // dribble upfield
    }
  } else if (i === keeperIdx) {
    const mouth = PITCH_5S.goalWidth / 2 - 0.3;
    const threat = Math.abs(bp.x - defendX) < 7 && Math.abs(bp.z) < mouth + 2;
    if (threat && Math.abs(bp.x - defendX) < 4) seek(bp.x, bp.z, true);
    else seek(defendX + Math.sign(attackX) * 1.2, Math.max(-mouth, Math.min(mouth, bp.z)));
  } else if (i === chaserIdx) {
    // press the ball; lead it slightly
    seek(bp.x + bv.x * 0.15, bp.z + bv.z * 0.15, true);
    // opponent on the ball close by -> standing tackle poke
    if (myDist < 1.4 && match.lastTouch >= 0 && match.meta[match.lastTouch]?.team !== meta.team) {
      pulse(inp, 'tackle', match.tick);
    }
  } else {
    // support: hold a lane between ball and own goal, spread by index
    const nth = mates.findIndex((e) => e.idx === i);
    const lane = ((nth % 3) - 1) * (W * 0.28);
    seek((bp.x + defendX) / 2, lane);
  }
  return inp;
}

/** rising-edge helper: press for 2 ticks every 12 so edges fire repeatedly */
function pulse(inp: PlayerFullInput, key: 'pass' | 'lob' | 'tackle', tick: number) {
  (inp as any)[key] = tick % 12 < 2;
}
