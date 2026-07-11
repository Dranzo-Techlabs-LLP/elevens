// ============================================================
// BOT BRAIN v2 — plays positional football instead of bee-swarm.
// Roles per team, recomputed each tick (cheap):
//   KEEPER   deepest bot; holds the mouth, rushes only real threats,
//            clears long when he wins it
//   CHASER   closest outfielder to the ball; the ONLY presser when the
//            opponents have it (plus tackles when close)
//   RUNNER   most advanced teammate when WE have it; makes a run beyond
//            the ball for through passes
//   HOLDERS  everyone else keeps a zone HOME SPOT with a deadband — they
//            stand still unless the spot moved >1.2m (no jitter-running)
// On the ball: pass to an OPEN teammate ahead (lane checked), through-ball
// the runner, shoot in range, otherwise carry at goal — sprint only into
// open space.
// ============================================================
import { PITCH_5S } from '../config3d';
import { idleFullInput, type Match, type PlayerFullInput } from './match';

const L = PITCH_5S.length;
const W = PITCH_5S.width;

// per-bot sticky state (module-level, keyed by match+index — fine for one
// process; deterministic across runs is not required for bots)
const holdSpot = new Map<string, { x: number; z: number }>();

export function botThink(match: Match, i: number): PlayerFullInput {
  const inp = idleFullInput();
  const me = match.players[i];
  const meta = match.meta[i];
  const bp = match.ball.translation();
  const bv = match.ball.linvel();
  const attackX = meta.team === 0 ? L / 2 : -L / 2;
  const defendX = -attackX;
  const key = `${meta.id}`;

  const mates = match.meta.map((m, idx) => ({ m, idx })).filter((e) => e.m.team === meta.team);
  const opps = match.meta.map((m, idx) => ({ m, idx })).filter((e) => e.m.team !== meta.team);
  const P = (idx: number) => match.players[idx];
  const distBall = (idx: number) => Math.hypot(bp.x - P(idx).pos.x, bp.z - P(idx).pos.z);

  // possession read
  const myDist = distBall(i);
  const iHaveIt = myDist < 1.0;
  const oppHasIt = match.lastTouch >= 0 && match.meta[match.lastTouch]?.team !== meta.team && Math.min(...opps.map((o) => distBall(o.idx))) < 1.2;
  const weHaveIt = match.lastTouch >= 0 && match.meta[match.lastTouch]?.team === meta.team && !oppHasIt;

  // roles
  let keeperIdx = -1, deep = Infinity;
  for (const e of mates) {
    if (!e.m.bot) continue;
    const d = Math.abs(defendX - P(e.idx).pos.x);
    if (d < deep) { deep = d; keeperIdx = e.idx; }
  }
  let chaserIdx = -1, best = Infinity;
  for (const e of mates) {
    if (e.idx === keeperIdx) continue;
    const d = distBall(e.idx);
    if (d < best) { best = d; chaserIdx = e.idx; }
  }
  let runnerIdx = -1, adv = -Infinity;
  for (const e of mates) {
    if (e.idx === keeperIdx || e.idx === chaserIdx) continue;
    const a = -Math.abs(attackX - P(e.idx).pos.x);
    if (a > adv) { adv = a; runnerIdx = e.idx; }
  }

  const seek = (tx: number, tz: number, opts: { sprint?: boolean; stopAt?: number } = {}) => {
    tx = Math.max(-L / 2 + 0.6, Math.min(L / 2 - 0.6, tx));
    tz = Math.max(-W / 2 + 0.6, Math.min(W / 2 - 0.6, tz));
    const dx = tx - me.pos.x;
    const dz = tz - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > (opts.stopAt ?? 0.6)) {
      inp.mx = dx / d;
      inp.mz = dz / d;
      inp.sprint = !!opts.sprint && d > 3;
    }
  };

  // an open teammate: ahead of me toward goal, lane clear of opponents
  const laneClear = (tx: number, tz: number) => {
    for (const o of opps) {
      const op = P(o.idx).pos;
      // distance from opponent to the pass segment (me -> target)
      const ax = me.pos.x, az = me.pos.z;
      const abx = tx - ax, abz = tz - az;
      const len2 = abx * abx + abz * abz;
      if (len2 < 1e-4) continue;
      let t = ((op.x - ax) * abx + (op.z - az) * abz) / len2;
      t = Math.max(0, Math.min(1, t));
      const cx = ax + abx * t, cz = az + abz * t;
      if (Math.hypot(op.x - cx, op.z - cz) < 1.1) return false;
    }
    return true;
  };

  if (iHaveIt) {
    // ================= ON THE BALL =================
    const dGoal = Math.abs(attackX - me.pos.x);
    const pressure = Math.min(...opps.map((o) => Math.hypot(P(o.idx).pos.x - me.pos.x, P(o.idx).pos.z - me.pos.z)));

    if (i === keeperIdx) {
      seek(defendX + Math.sign(attackX) * 2, 0, { stopAt: 0.3 });
      pulse(inp, 'lob', match.tick); // clear it long
      return inp;
    }

    // shoot when in range with a look at goal
    if (dGoal < L * 0.32 && laneClear(attackX, 0)) {
      seek(attackX, 0, { stopAt: 0.3 });
      inp.shoot = match.actStates[i].shootHeldMs < 320;
      return inp;
    }
    // through ball for the runner when he's ahead of me and open
    if (runnerIdx >= 0) {
      const rp = P(runnerIdx).pos;
      const runnerAhead = Math.sign(attackX) * (rp.x - me.pos.x) > 2;
      if (runnerAhead && laneClear(rp.x + Math.sign(attackX) * 2, rp.z) && match.tick % 18 < 2) {
        inp.through = match.tick % 18 < 1; // edge
        return inp;
      }
    }
    // pass to an open mate that's not behind me, prefer under pressure
    if (pressure < 2.5 || match.tick % 30 < 2) {
      let bestMate = -1, bestScore = Infinity;
      for (const e of mates) {
        if (e.idx === i || e.idx === keeperIdx) continue;
        const mp = P(e.idx).pos;
        const behind = Math.sign(attackX) * (mp.x - me.pos.x) < -3;
        if (behind || !laneClear(mp.x, mp.z)) continue;
        const d = Math.hypot(mp.x - me.pos.x, mp.z - me.pos.z);
        if (d < 3 || d > 16) continue;
        const score = d + (Math.sign(attackX) * (me.pos.x - mp.x)) * 2; // prefer forward
        if (score < bestScore) { bestScore = score; bestMate = e.idx; }
      }
      if (bestMate >= 0) {
        // step toward the target (movement sets facing), release the pass
        const mp = P(bestMate).pos;
        seek(mp.x, mp.z, { stopAt: 0.5 });
        pulse(inp, 'pass', match.tick);
        return inp;
      }
    }
    // carry: sprint only into space
    const spaceAhead = pressure > 3.5;
    seek(attackX, me.pos.z * 0.6, { sprint: spaceAhead, stopAt: 0.3 });
    return inp;
  }

  if (i === keeperIdx) {
    // ================= KEEPER =================
    const mouth = PITCH_5S.goalWidth / 2 - 0.3;
    const threat = Math.abs(bp.x - defendX) < 6.5 && Math.abs(bp.z) < mouth + 1.5 && !weHaveIt;
    if (threat && Math.abs(bp.x - defendX) < 3.5) seek(bp.x, bp.z, { sprint: true, stopAt: 0.2 });
    else seek(defendX + Math.sign(attackX) * 1.1, Math.max(-mouth, Math.min(mouth, bp.z * 0.6)), { stopAt: 0.25 });
    return inp;
  }

  if (i === chaserIdx) {
    // ================= CHASER =================
    // press the ball (lead it); everyone else stays home
    seek(bp.x + bv.x * 0.18, bp.z + bv.z * 0.18, { sprint: distBall(i) > 4, stopAt: 0.2 });
    if (oppHasIt && myDist < 1.5 && match.tick >= match.actStates[i].stunUntilTick) {
      pulse(inp, 'tackle', match.tick);
    }
    return inp;
  }

  // ================= RUNNER / HOLDERS =================
  let spot: { x: number; z: number };
  if (weHaveIt && i === runnerIdx) {
    // make a run: beyond the ball, toward goal, wide-ish
    spot = {
      x: bp.x + Math.sign(attackX) * 7,
      z: Math.sign(me.pos.z || 1) * Math.min(W * 0.3, Math.abs(me.pos.z) + 2),
    };
  } else {
    // zone home: between ball and own goal, spread by index
    const nth = mates.findIndex((e) => e.idx === i);
    const lane = ((nth % 3) - 1) * (W * 0.27);
    spot = { x: (bp.x + defendX) / 2, z: lane };
  }
  // deadband: only move when the spot drifted — kills the jitter-running
  const prev = holdSpot.get(key);
  if (!prev || Math.hypot(prev.x - spot.x, prev.z - spot.z) > 1.2) holdSpot.set(key, spot);
  const target = holdSpot.get(key)!;
  seek(target.x, target.z, { stopAt: 0.8, sprint: weHaveIt && i === runnerIdx });
  return inp;
}

/** rising-edge helper: press for 1 tick in every 12 so edges re-fire */
function pulse(inp: PlayerFullInput, key: 'pass' | 'lob' | 'tackle' | 'through', tick: number) {
  (inp as any)[key] = tick % 12 < 1;
}
