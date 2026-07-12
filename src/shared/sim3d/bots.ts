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

  // possession read — from the REAL possession state, not guesswork
  const myDist = distBall(i);
  const ownerIdx = match.poss.owner;
  const iHaveIt = ownerIdx === i;
  const ballLoose = ownerIdx < 0;
  const oppHasIt = ownerIdx >= 0 && match.meta[ownerIdx].team !== meta.team;
  const weHaveIt = ownerIdx >= 0 && match.meta[ownerIdx].team === meta.team;

  // KICKOFF DISCIPLINE (real law): until the first touch puts the ball in
  // play, only the restarting team may approach — and only their nearest
  // man. Everyone else holds his kickoff spot. Kills the center scrum.
  if (match.kickoffHold && !iHaveIt) {
    if (meta.team !== match.kickoffTeam) return inp; // stand off the circle
    let takerIdx = -1, td = Infinity;
    for (const e of mates) {
      const d = distBall(e.idx);
      if (d < td) { td = d; takerIdx = e.idx; }
    }
    if (takerIdx !== i) return inp; // one taker, not five
  }

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

  const seek = (tx: number, tz: number, opts: { sprint?: boolean; stopAt?: number; mag?: number } = {}) => {
    tx = Math.max(-L / 2 + 0.6, Math.min(L / 2 - 0.6, tx));
    tz = Math.max(-W / 2 + 0.6, Math.min(W / 2 - 0.6, tz));
    const dx = tx - me.pos.x;
    const dz = tz - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > (opts.stopAt ?? 0.6)) {
      const mag = opts.mag ?? 1;
      inp.mx = (dx / d) * mag;
      inp.mz = (dz / d) * mag;
      inp.sprint = !!opts.sprint && d > 3;
    }
  };

  // COLLECT APPROACH: sprinting flat-out INTO a loose ball fails the claim
  // gate (relative speed too high) — the bot blows straight past it. Real
  // players decelerate into the ball; do the same: sprint far out, ease off
  // inside 3m, arrive slow enough to take possession.
  const collectBall = () => {
    const d = distBall(i);
    const lead = d > 3 ? 0.18 : 0.04;
    seek(bp.x + bv.x * lead, bp.z + bv.z * lead, {
      sprint: d > 4,
      stopAt: 0.12,
      mag: d > 3 ? 1 : 0.5,
    });
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

    // shoot when in range — a keeper on his line is NOT a reason to hold
    // back (placement aims past him); only an opponent physically in your
    // face blocks the strike
    if (dGoal < L * 0.32) {
      let blocked = false;
      for (const o of opps) {
        const op = P(o.idx).pos;
        const toward = Math.sign(attackX) * (op.x - me.pos.x);
        if (toward > 0 && toward < 1.6 && Math.abs(op.z - me.pos.z) < 0.9) blocked = true;
      }
      if (!blocked) {
        seek(attackX, 0, { stopAt: 0.3 });
        inp.shoot = match.actStates[i].shootHeldMs < 320;
        return inp;
      }
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
    // PASS DECISION: score every teammate — forward progress, lane safety,
    // useful distance. Pass under pressure, and proactively every ~0.8s if
    // someone is in a clearly better position.
    let bestMate = -1, bestGain = -Infinity;
    for (const e of mates) {
      if (e.idx === i || e.idx === keeperIdx) continue;
      const mp = P(e.idx).pos;
      const d = Math.hypot(mp.x - me.pos.x, mp.z - me.pos.z);
      if (d < 2.5 || d > 17) continue;
      if (!laneClear(mp.x, mp.z)) continue;
      const forwardGain = Math.sign(attackX) * (mp.x - me.pos.x); // meters toward goal
      // open-ness: nearest opponent to the receiving spot
      let open = 99;
      for (const o of opps) {
        open = Math.min(open, Math.hypot(P(o.idx).pos.x - mp.x, P(o.idx).pos.z - mp.z));
      }
      const gain = forwardGain * 1.5 + Math.min(open, 5) - d * 0.25;
      if (gain > bestGain) { bestGain = gain; bestMate = e.idx; }
    }
    const shouldPass =
      bestMate >= 0 && (pressure < 2.2 ? bestGain > -2 : bestGain > 2.5 && match.tick % 24 < 2);
    if (shouldPass) {
      const mp = P(bestMate).pos;
      seek(mp.x, mp.z, { stopAt: 0.5, mag: 0.6 }); // face the target
      pulse(inp, 'pass', match.tick);
      return inp;
    }
    // carry: sprint only into space
    const spaceAhead = pressure > 3.5;
    seek(attackX, me.pos.z * 0.6, { sprint: spaceAhead, stopAt: 0.3 });
    return inp;
  }

  // ================= LOOSE BALL =================
  // a free ball near me is MINE to win — closest teammate goes, not just
  // the designated chaser watching from his zone
  if (ballLoose) {
    let closest = -1, cd = Infinity;
    for (const e of mates) {
      if (e.idx === keeperIdx) continue;
      const d = distBall(e.idx);
      if (d < cd) { cd = d; closest = e.idx; }
    }
    const inMyBox = Math.abs(bp.x - defendX) < 7 && Math.abs(bp.z) < 6;
    if (i === closest && cd < 14) {
      collectBall();
      return inp;
    }
    if (i === keeperIdx && inMyBox) {
      collectBall();
      return inp;
    }
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
    collectBall(); // decelerating approach — can actually claim it
    // tackle: only when the ball is genuinely on MY side of the carrier
    // (PES shielding), and not more than once every ~1.2s — no poke spam
    if (oppHasIt && myDist < 1.3 && match.tick >= match.actStates[i].stunUntilTick) {
      const carrier = ownerIdx >= 0 ? match.players[ownerIdx] : null;
      const dCarrier = carrier
        ? Math.hypot(carrier.pos.x - me.pos.x, carrier.pos.z - me.pos.z)
        : 99;
      const ballOnMySide = myDist < dCarrier - 0.1;
      if (ballOnMySide) pulse(inp, 'tackle', match.tick, 36); // ~1.2s between pokes
    }
    return inp;
  }

  // second presser when the opponent carries in OUR defensive third
  if (oppHasIt && Math.sign(attackX) * (bp.x - defendX) < L * 0.3) {
    let second = -1, sd = Infinity;
    for (const e of mates) {
      if (e.idx === keeperIdx || e.idx === chaserIdx) continue;
      const d = distBall(e.idx);
      if (d < sd) { sd = d; second = e.idx; }
    }
    if (i === second && sd < 9) {
      collectBall();
      return inp;
    }
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

/** rising-edge helper: press for 1 tick in every `period` so edges re-fire */
function pulse(
  inp: PlayerFullInput,
  key: 'pass' | 'lob' | 'tackle' | 'through',
  tick: number,
  period = 12,
) {
  (inp as any)[key] = tick % period < 1;
}
