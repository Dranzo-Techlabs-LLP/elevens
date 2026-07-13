// Deterministic sim checks, no client: goal detection, crossbar rejection,
// kick verbs firing. Run: npx tsx scripts/test-match.mts
import RAPIER from '@dimforge/rapier3d-compat';
import { Match, idleFullInput } from '../src/shared/sim3d/match';
import { PITCH_5S, BALL } from '../src/shared/config3d';

await RAPIER.init();

function fresh() {
  const m = new Match(RAPIER, 30);
  m.addPlayer('h1', 'Tester', 0, false);
  m.restart(180);
  return m;
}

const out: Record<string, unknown> = {};

// 1. GOAL: ball rolled straight into the +x goal mouth
{
  const m = fresh();
  m.ball.setTranslation({ x: PITCH_5S.length / 2 - 2, y: BALL.radius, z: 0 }, true);
  m.ball.setLinvel({ x: 10, y: 0, z: 0 }, true);
  for (let i = 0; i < 60 && m.phase === 'playing'; i++) m.step();
  out.goalRolled = { phase: m.phase, score: m.score };
}

// 2. NO GOAL over the bar: ball flying at 3m height through the mouth plane
{
  const m = fresh();
  m.ball.setTranslation({ x: PITCH_5S.length / 2 - 3, y: 3.0, z: 0 }, true);
  m.ball.setLinvel({ x: 14, y: 2, z: 0 }, true);
  for (let i = 0; i < 45 && m.phase === 'playing'; i++) m.step();
  out.overBar = { phase: m.phase, score: m.score };
}

// 3. WIDE shot: misses the mouth, boards keep it in
{
  const m = fresh();
  m.ball.setTranslation({ x: PITCH_5S.length / 2 - 3, y: BALL.radius, z: 4 }, true);
  m.ball.setLinvel({ x: 12, y: 0, z: 0 }, true);
  for (let i = 0; i < 60 && m.phase === 'playing'; i++) m.step();
  const bp = m.ball.translation();
  out.wide = { phase: m.phase, ballX: +bp.x.toFixed(2), stillInPlay: Math.abs(bp.x) < PITCH_5S.length / 2 + 0.5 };
}

// 4. SHOT VERB: player near ball facing +x, charged release -> ball launches at goal
{
  const m = fresh();
  const p = m.players[0];
  p.body.setTranslation({ x: 10, y: 0.91, z: 0 }, true);
  p.yaw = 0;
  m.ball.setTranslation({ x: 10.7, y: BALL.radius, z: 0 }, true);
  m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  // hold shoot 12 ticks (400ms), release, wait for contact frame
  for (let t = 0; t < 30; t++) {
    const inp = idleFullInput();
    inp.shoot = t < 12;
    m.setInput(0, inp);
    m.step();
  }
  const bv = m.ball.linvel();
  out.shotVerb = { speed: +Math.hypot(bv.x, bv.y, bv.z).toFixed(1), vx: +bv.x.toFixed(1), vy: +bv.y.toFixed(1) };
  // keep stepping — should be a goal shortly
  for (let i = 0; i < 60 && m.phase === 'playing'; i++) m.step();
  out.shotVerbGoal = { phase: m.phase, score: m.score };
}

// 5. PASS VERB fires at contact frame
{
  const m = fresh();
  m.addPlayer('h2', 'Mate', 0, false); // teammate ahead for targeting
  m.restart(180);
  const p = m.players[0];
  p.body.setTranslation({ x: 0, y: 0.91, z: 0 }, true);
  p.yaw = 0;
  m.players[1].body.setTranslation({ x: 8, y: 0.91, z: 2 }, true);
  m.ball.setTranslation({ x: 0.7, y: BALL.radius, z: 0 }, true);
  m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  for (let t = 0; t < 20; t++) {
    const inp = idleFullInput();
    inp.pass = t < 3; // press, release -> edge
    m.setInput(0, inp);
    m.step();
  }
  const bv = m.ball.linvel();
  const ang = (Math.atan2(bv.z, bv.x) * 180) / Math.PI;
  out.passVerb = { speed: +Math.hypot(bv.x, bv.z).toFixed(1), angleDeg: +ang.toFixed(0) };
}

// 6. CLASH: two players sprint head-on — must NOT deadlock in place
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('a', 'A', 0, false);
  m.addPlayer('b', 'B', 1, false);
  m.restart(180);
  m.players[0].body.setTranslation({ x: -3, y: 0.91, z: 5 }, true);
  m.players[1].body.setTranslation({ x: 3, y: 0.91, z: 5 }, true);
  m.ball.setTranslation({ x: 0, y: 0.11, z: -8 }, true); // ball far away
  for (let t = 0; t < 90; t++) {
    const ia = idleFullInput(); ia.mx = 1;  // A runs +x
    const ib = idleFullInput(); ib.mx = -1; // B runs -x
    m.setInput(0, ia);
    m.setInput(1, ib);
    m.step();
  }
  const ax = m.players[0].pos.x;
  const bx = m.players[1].pos.x;
  out.clash = { aX: +ax.toFixed(2), bX: +bx.toFixed(2), passedThrough: ax > 1.5 && bx < -1.5 };
}

// 7. STANDING RECEIVE: 10 m/s pass arrives — ball must settle AT the feet
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('h1', 'Rec', 0, false);
  m.restart(180);
  const p = m.players[0];
  p.body.setTranslation({ x: 5, y: 0.91, z: 5 }, true);
  p.yaw = Math.PI; // facing the incoming ball
  m.ball.setTranslation({ x: 12, y: 0.11, z: 5 }, true);
  m.ball.setLinvel({ x: -10, y: 0, z: 0 }, true);
  for (let t = 0; t < 75; t++) { m.setInput(0, idleFullInput()); m.step(); }
  const bp = m.ball.translation();
  const bv = m.ball.linvel();
  const rest = Math.hypot(bp.x - p.pos.x, bp.z - p.pos.z);
  out.standingReceive = {
    restDist: +rest.toFixed(2),
    ballSpeed: +Math.hypot(bv.x, bv.z).toFixed(2),
    held: rest < 0.8 && Math.hypot(bv.x, bv.z) < 1,
  };
}

// 8. RUN ONTO BALL: sprint at a still ball — must carry it, not squirt it
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('h1', 'Run', 0, false);
  m.restart(180);
  const p = m.players[0];
  p.body.setTranslation({ x: -6, y: 0.91, z: 5 }, true);
  m.ball.setTranslation({ x: -2, y: 0.11, z: 5 }, true);
  m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  const seps: number[] = [];
  for (let t = 0; t < 120; t++) {
    const inp = idleFullInput();
    inp.mx = 1;
    inp.sprint = true;
    m.setInput(0, inp);
    m.step();
    if (t > 30) {
      const bp2 = m.ball.translation();
      seps.push(Math.hypot(bp2.x - p.pos.x, bp2.z - p.pos.z));
    }
  }
  const maxSep = Math.max(...seps);
  const inBand = seps.filter((s) => s < 2.8).length / seps.length; // chase band
  const bpEnd = m.ball.translation();
  out.runOnto = {
    maxSep: +maxSep.toFixed(2),
    inBandPct: Math.round(inBand * 100),
    ownerAtEnd: m.poss.owner === 0,
    ballProgressM: +(bpEnd.x - -2).toFixed(1), // net downfield carry
    held: inBand > 0.9 && bpEnd.x - -2 > 10, // stayed in the chase band, carried 10m+
  };
}

// 9. TURN WITH BALL: jog +x with the ball, hard 90° turn — ball must stay
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('h1', 'T', 0, false);
  m.restart(180);
  const p = m.players[0];
  p.body.setTranslation({ x: -8, y: 0.91, z: 0 }, true);
  m.ball.setTranslation({ x: -7.4, y: 0.11, z: 0 }, true);
  const seps: number[] = [];
  for (let t = 0; t < 150; t++) {
    const inp = idleFullInput();
    if (t < 60) inp.mx = 1;            // jog +x, gain control
    else { inp.mz = 1; }               // hard 90° turn to +z
    m.setInput(0, inp);
    m.step();
    if (t > 20) {
      const b = m.ball.translation();
      seps.push(Math.hypot(b.x - p.pos.x, b.z - p.pos.z));
    }
  }
  const turnSeps = seps.slice(40); // samples during/after the turn
  out.turnCarry = {
    maxSepTurn: +Math.max(...turnSeps).toFixed(2),
    inControlPct: Math.round((turnSeps.filter((s) => s < 1.0).length / turnSeps.length) * 100),
    owned: m.poss.owner === 0,
  };
}

// 10. TACKLE STRIPS: carrier jogs, defender pokes — ball must leave clean
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('h1', 'Carrier', 0, false);
  m.addPlayer('h2', 'Def', 1, false);
  m.restart(180);
  m.players[0].body.setTranslation({ x: 0, y: 0.91, z: 5 }, true);
  m.players[1].body.setTranslation({ x: 1.1, y: 0.91, z: 5.4 }, true);
  m.ball.setTranslation({ x: 0.4, y: 0.11, z: 5 }, true);
  m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  // carrier walks; defender stands and pokes on tick 20
  for (let t = 0; t < 45; t++) {
    const ic = idleFullInput(); ic.mx = 0.4;
    const idf = idleFullInput(); idf.tackle = t === 20;
    m.setInput(0, ic);
    m.setInput(1, idf);
    m.step();
  }
  const b = m.ball.translation();
  const dCarrier = Math.hypot(b.x - m.players[0].pos.x, b.z - m.players[0].pos.z);
  out.tackleStrip = {
    distFromCarrier: +dCarrier.toFixed(2),
    stripped: dCarrier > 1.2,
    carrierStillOwner: m.poss.owner === 0,
  };
}

// 11. SHIELDING: presser BEHIND the carrier pokes — must be blocked;
//     the same poke from the ball side must strip
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('c', 'Car', 0, false);
  m.addPlayer('d', 'Def', 1, false);
  m.restart(180);
  // carrier faces +x, ball ahead (+x); defender directly BEHIND (-x)
  m.players[0].body.setTranslation({ x: 0, y: 0.91, z: 5 }, true);
  m.players[0].yaw = 0;
  m.players[1].body.setTranslation({ x: -0.9, y: 0.91, z: 5 }, true);
  m.ball.setTranslation({ x: 0.45, y: 0.11, z: 5 }, true);
  m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  for (let t = 0; t < 30; t++) {
    const ic = idleFullInput(); ic.mx = 0.3; // walk forward, shielding
    const idf = idleFullInput(); idf.tackle = t === 10 || t === 22;
    m.setInput(0, ic);
    m.setInput(1, idf);
    m.step();
  }
  const b1 = m.ball.translation();
  const dBehind = Math.hypot(b1.x - m.players[0].pos.x, b1.z - m.players[0].pos.z);
  out.shieldBlocksPoke = { sepAfter: +dBehind.toFixed(2), kept: dBehind < 1.0 && m.poss.owner === 0 };
}

// 12. FIELD BOUNDS: nobody leaves the pitch — not through the goal mouth,
//     not shoved through the boards by a scrum
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('a', 'A', 0, false);
  m.addPlayer('b', 'B', 1, false);
  m.restart(180);
  // A tries to run straight through the goal mouth; B grinds A against the board
  m.players[0].body.setTranslation({ x: 18, y: 0.91, z: 0 }, true);
  m.players[1].body.setTranslation({ x: 0, y: 0.91, z: 9.4 }, true);
  m.ball.setTranslation({ x: 0, y: 0.11, z: -8 }, true);
  for (let t = 0; t < 120; t++) {
    const ia = idleFullInput(); ia.mx = 1; ia.sprint = true;   // through the mouth
    const ib = idleFullInput(); ib.mz = 1; ib.sprint = true;   // into the board
    m.setInput(0, ia);
    m.setInput(1, ib);
    m.step();
  }
  const pa = m.players[0].pos;
  const pb2 = m.players[1].pos;
  out.fieldBounds = {
    aX: +pa.x.toFixed(2),
    bZ: +pb2.z.toFixed(2),
    inside: pa.x <= 20 - 0.25 && Math.abs(pb2.z) <= 10 - 0.25,
  };
}

// 13. OUT OF PLAY: lob over the side board -> throw-in; ball behind the
//     goal (over the bar) -> goal kick. Never a dead unreachable ball.
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('a', 'A', 0, false);
  m.restart(180);
  // fire the ball over the side board
  m.ball.setTranslation({ x: 0, y: 0.11, z: 5 }, true);
  m.ball.setLinvel({ x: 0, y: 9, z: 12 }, true);
  let restarted = '';
  for (let t = 0; t < 120 && !restarted; t++) {
    m.setInput(0, idleFullInput());
    const ev = m.step();
    for (const e of ev) if (e.detail === 'throwin' || e.detail === 'goalkick') restarted = e.detail;
  }
  const b1 = m.ball.translation();
  out.throwIn = { kind: restarted, ballBack: Math.abs(b1.z) < 10 && Math.abs(b1.x) < 20 };

  // fire the ball over the crossbar, behind the goal
  m.ball.setTranslation({ x: 15, y: 0.11, z: 0 }, true);
  m.ball.setLinvel({ x: 16, y: 10, z: 0 }, true);
  restarted = '';
  for (let t = 0; t < 150 && !restarted; t++) {
    m.setInput(0, idleFullInput());
    const ev = m.step();
    for (const e of ev) if (e.detail === 'throwin' || e.detail === 'goalkick') restarted = e.detail;
  }
  const b2 = m.ball.translation();
  out.goalKick = { kind: restarted, score: m.score, ballBack: Math.abs(b2.x) < 20 };
}

// 14. REFEREE MOVEMENT: patrols with play, stays inside the field, never
//     crowds the ball, never parks inside a penalty area
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('a', 'A', 0, false);
  m.restart(180);
  let minBallD = Infinity, out2 = 0, inBox = 0;
  const L2 = PITCH_5S.length / 2, W2 = PITCH_5S.width / 2;
  for (let t = 0; t < 400; t++) {
    // sweep the ball around the pitch to drag the ref through his patrol
    const ang = t * 0.02;
    m.ball.setTranslation({ x: Math.cos(ang) * 14, y: 0.11, z: Math.sin(ang * 1.7) * 7 }, true);
    m.setInput(0, idleFullInput());
    m.step();
    const bp = m.ball.translation();
    const d = Math.hypot(m.ref.x - bp.x, m.ref.z - bp.z);
    if (t > 60) {
      minBallD = Math.min(minBallD, d);
      if (Math.abs(m.ref.x) > L2 || Math.abs(m.ref.z) > W2) out2++;
      if (Math.abs(m.ref.x) > L2 - 8) inBox++;
    }
  }
  out.refPatrol = {
    minBallDist: +minBallD.toFixed(2),
    ticksOutOfBounds: out2,
    ticksInBoxZone: inBox,
    ok: minBallD > 1.5 && out2 === 0,
  };
}

// 15. FREE KICK: slide foul from behind, victim team does NOT regain the
//     ball -> whistle, free kick at the spot, yellow card for the offender
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('c', 'Car', 0, false);
  m.addPlayer('d', 'Def', 1, false);
  m.restart(180);
  m.players[0].body.setTranslation({ x: 5, y: 0.91, z: 3 }, true);
  m.players[0].yaw = 0;
  m.players[1].body.setTranslation({ x: 3.6, y: 0.91, z: 3 }, true);
  m.players[1].yaw = 0;
  m.ball.setTranslation({ x: 5.5, y: 0.11, z: 3 }, true);
  m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  const got: string[] = [];
  let foulSpot: { x: number; z: number } | null = null;
  for (let t = 0; t < 120; t++) {
    const ic = idleFullInput(); ic.mx = 0.25;            // carrier ambles on
    const idf = idleFullInput(); idf.mx = 1; idf.sprint = true; idf.slide = t === 8;
    m.setInput(0, ic);
    m.setInput(1, idf);
    const ev = m.step();
    for (const e of ev) {
      if (e.kind === 'foul' && !foulSpot) {
        const bp = m.ball.translation();
        foulSpot = { x: bp.x, z: bp.z };
        // knock the ball clear so the fouled team CANNOT retain it — the
        // advantage window must lapse and the whistle must come
        m.ball.setTranslation({ x: -14, y: 0.11, z: -7 }, true);
        m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      if (e.detail && ['freekick', 'advantage', 'yellow', 'red'].includes(e.detail)) got.push(e.detail);
    }
    if (got.includes('freekick') || got.includes('advantage')) break;
  }
  const bp = m.ball.translation();
  const nearSpot = foulSpot ? Math.hypot(bp.x - foulSpot.x, bp.z - foulSpot.z) : 99;
  out.freeKick = {
    events: got,
    phase: m.phase,
    ballNearSpot: +nearSpot.toFixed(2),
    ok: (got.includes('freekick') && got.includes('yellow') && nearSpot < 3) || got.includes('advantage'),
  };
}

// 16. SECOND YELLOW = RED + SIN-BIN: same offender fouls twice -> red card,
//     long stun, parked at the touchline bench
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('c', 'Car', 0, false);
  m.addPlayer('d', 'Def', 1, false);
  m.restart(180);
  const cards: string[] = [];
  for (const round of [0, 1]) {
    m.players[0].body.setTranslation({ x: 5, y: 0.91, z: 3 }, true);
    m.players[0].yaw = 0;
    m.players[1].body.setTranslation({ x: 3.6, y: 0.91, z: 3 }, true);
    m.players[1].yaw = 0;
    m.ball.setTranslation({ x: 5.5, y: 0.11, z: 3 }, true);
    m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    // clear any leftover stun from round 1 so the defender can slide again
    if (round === 1) m.actStates[1].stunUntilTick = 0;
    for (let t = 0; t < 150; t++) {
      const ic = idleFullInput(); ic.mx = 0.25;
      const idf = idleFullInput(); idf.mx = 1; idf.sprint = true; idf.slide = t === 8;
      m.setInput(0, ic);
      m.setInput(1, idf);
      const ev = m.step();
      let decided = false;
      for (const e of ev) {
        if (e.detail === 'yellow' || e.detail === 'red') cards.push(e.detail);
        if (e.detail === 'freekick' || e.detail === 'advantage') decided = true;
      }
      if (decided) break;
    }
    // let the free-kick pause elapse before round 2
    for (let t = 0; t < 60 && m.phase !== 'playing'; t++) m.step();
  }
  const stunTicks = m.actStates[1].stunUntilTick - m.tick;
  const pd = m.players[1].pos;
  out.cards = {
    sequence: cards,
    sinBinSeconds: +(stunTicks / 30).toFixed(1),
    atBench: +pd.z.toFixed(2),
    ok: cards.join(',') === 'yellow,red' && stunTicks > 15 * 30 && Math.abs(pd.z) > PITCH_5S.width / 2 - 2,
  };
}

// 17. KICKOFF DISCIPLINE: only the kicking team's nearest man approaches;
//     the opposition holds its half until the first touch releases the ball
{
  const { botThink } = await import('../src/shared/sim3d/bots');
  const m = new Match(RAPIER, 30);
  for (let n = 0; n < 5; n++) m.addPlayer(`bot-0-${n}`, `A${n}`, 0, true);
  for (let n = 0; n < 5; n++) m.addPlayer(`bot-1-${n}`, `B${n}`, 1, true);
  m.restart(180);
  let oppCrossed = 0, releasedAt = -1;
  for (let t = 0; t < 90; t++) {
    for (let i = 0; i < 10; i++) m.setInput(i, botThink(m, i));
    m.step();
    if (m.kickoffHold) {
      // team 1 defends +x: nobody may cross toward the ball early
      for (let i = 5; i < 10; i++) if (m.players[i].pos.x < -0.3) oppCrossed++;
    } else if (releasedAt < 0) releasedAt = t;
  }
  out.kickoffDiscipline = {
    oppCrossedDuringHold: oppCrossed,
    releasedAtTick: releasedAt,
    ok: oppCrossed === 0 && releasedAt > 0 && releasedAt < 90,
  };
}

// 18. THROW-IN LAW: last touched by team 0 -> throw-in to team 1, ball on
//     the line, taker from team 1, locked to him until he plays it
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('a', 'A', 0, false);
  m.addPlayer('b', 'B', 1, false);
  m.restart(180);
  // team 0 (index 0) touches, then the ball is sent over the touchline
  m.players[0].body.setTranslation({ x: 2, y: 0.91, z: 5 }, true);
  m.ball.setTranslation({ x: 2.4, y: 0.11, z: 5 }, true);
  for (let t = 0; t < 12; t++) { m.setInput(0, idleFullInput()); m.setInput(1, idleFullInput()); m.step(); }
  const touched = m.lastTouch;
  m.ball.setLinvel({ x: 0, y: 4, z: 14 }, true);
  let ev = '';
  for (let t = 0; t < 90 && !ev; t++) {
    m.setInput(0, idleFullInput()); m.setInput(1, idleFullInput());
    for (const e of m.step()) if (e.detail === 'throwin') ev = e.detail;
  }
  const rs = m.restartState;
  // ball must be IN THE TAKER'S HANDS overhead during the ceremony
  for (let t = 0; t < 5; t++) { m.setInput(0, idleFullInput()); m.setInput(1, idleFullInput()); m.step(); }
  const bp = m.ball.translation();
  const inHands = bp.y > 1.6;
  // then the taker throws (pass verb becomes the two-handed release)
  let thrown = false, releaseSpeed = 0;
  const taker = rs?.taker ?? -1;
  for (let t = 0; t < 120 && !thrown; t++) {
    const it = idleFullInput();
    if (m.restartState && m.tick >= m.restartState.readyTick) it.pass = t % 8 < 4;
    m.setInput(taker, it);
    m.setInput(1 - taker, idleFullInput());
    for (const e of m.step()) {
      if (e.detail === 'throw') {
        thrown = true;
        const v = m.ball.linvel();
        releaseSpeed = Math.hypot(v.x, v.z);
      }
    }
  }
  // after the throw the ball must STAY IN and reach the throwing team
  let reOut = false;
  for (let t = 0; t < 40; t++) {
    m.setInput(0, idleFullInput()); m.setInput(1, idleFullInput());
    for (const e of m.step()) if (e.detail === 'throwin') reOut = true;
  }
  const bpAfter = m.ball.translation();
  out.throwInLaw = {
    lastTouchWas: touched,
    event: ev,
    awardedTo: rs?.team,
    takerTeam: rs ? m.meta[rs.taker].team : -1,
    ballInHands: inHands,
    thrown,
    releaseSpeed: +releaseSpeed.toFixed(1),
    stayedIn: !reOut && Math.abs(bpAfter.z) < 10,
    ok: ev === 'throwin' && touched === 0 && rs?.team === 1 && inHands && thrown
      && releaseSpeed <= 10.6 && !reOut && Math.abs(bpAfter.z) < 10,
  };
}

// 18b. THROW-IN TARGETING: with teammates infield, the throw is delivered
//      to the best receiver — the receiving team keeps the ball
{
  const { botThink } = await import('../src/shared/sim3d/bots');
  const m = new Match(RAPIER, 30);
  for (let n = 0; n < 3; n++) m.addPlayer(`bot-0-${n}`, `A${n}`, 0, true);
  for (let n = 0; n < 3; n++) m.addPlayer(`bot-1-${n}`, `B${n}`, 1, true);
  m.restart(180);
  // team 0 touches, ball out over the touchline -> throw-in to team 1
  m.players[1].body.setTranslation({ x: 2, y: 0.91, z: 5 }, true);
  m.ball.setTranslation({ x: 2.4, y: 0.11, z: 5 }, true);
  for (let t = 0; t < 10; t++) { for (let i = 0; i < 6; i++) m.setInput(i, idleFullInput()); m.step(); }
  m.ball.setLinvel({ x: 0, y: 4, z: 14 }, true);
  let thrownTo = -1, reOut2 = false, sawThrow = false;
  for (let t = 0; t < 300; t++) {
    for (let i = 0; i < 6; i++) m.setInput(i, botThink(m, i));
    for (const e of m.step()) {
      if (e.detail === 'throw') sawThrow = true;
      if (sawThrow && e.detail === 'throwin') reOut2 = true;
    }
    if (sawThrow && m.poss.owner >= 0) { thrownTo = m.poss.owner; break; }
  }
  out.throwTargeting = {
    sawThrow,
    firstOwnerTeam: thrownTo >= 0 ? m.meta[thrownTo].team : -1,
    reOut: reOut2,
    ok: sawThrow && thrownTo >= 0 && m.meta[thrownTo].team === 1 && !reOut2,
  };
}

// 19. CORNER vs GOAL KICK by last touch: attacker puts it behind -> goal
//     kick (keeper takes); defender deflects it behind -> corner
{
  const m = new Match(RAPIER, 30);
  for (let n = 0; n < 2; n++) m.addPlayer(`bot-0-${n}`, `A${n}`, 0, true);
  for (let n = 0; n < 2; n++) m.addPlayer(`bot-1-${n}`, `B${n}`, 1, true);
  m.restart(180);
  // attacker (team 0) last touch, ball over team 1's goal line (x = +L/2), wide
  m.players[1].body.setTranslation({ x: 14, y: 0.91, z: 6 }, true);
  m.ball.setTranslation({ x: 14.4, y: 0.11, z: 6 }, true);
  for (let t = 0; t < 10; t++) { for (let i = 0; i < 4; i++) m.setInput(i, idleFullInput()); m.step(); }
  m.ball.setLinvel({ x: 16, y: 3, z: 4 }, true); // over the line, wide of goal
  let kind = '';
  for (let t = 0; t < 90 && !kind; t++) {
    for (let i = 0; i < 4; i++) m.setInput(i, idleFullInput());
    for (const e of m.step()) if (e.detail === 'goalkick' || e.detail === 'corner') kind = e.detail;
  }
  const gkTaker = m.restartState ? m.meta[m.restartState.taker] : null;
  out.goalKickLaw = {
    kind,
    takerIsKeeper: !!gkTaker?.keeper,
    takerTeam: gkTaker?.team,
    ok: kind === 'goalkick' && !!gkTaker?.keeper && gkTaker?.team === 1,
  };

  // now a DEFENDER (team 1) last touch -> corner for team 0
  const m2 = new Match(RAPIER, 30);
  for (let n = 0; n < 2; n++) m2.addPlayer(`bot-0-${n}`, `A${n}`, 0, true);
  for (let n = 0; n < 2; n++) m2.addPlayer(`bot-1-${n}`, `B${n}`, 1, true);
  m2.restart(180);
  m2.players[2].body.setTranslation({ x: 14, y: 0.91, z: 6 }, true); // team 1 defender
  m2.ball.setTranslation({ x: 14.4, y: 0.11, z: 6 }, true);
  for (let t = 0; t < 10; t++) { for (let i = 0; i < 4; i++) m2.setInput(i, idleFullInput()); m2.step(); }
  m2.ball.setLinvel({ x: 16, y: 3, z: 4 }, true);
  kind = '';
  for (let t = 0; t < 90 && !kind; t++) {
    for (let i = 0; i < 4; i++) m2.setInput(i, idleFullInput());
    for (const e of m2.step()) if (e.detail === 'goalkick' || e.detail === 'corner') kind = e.detail;
  }
  const bp2 = m2.ball.translation();
  out.cornerLaw = {
    kind,
    awardedTo: m2.restartState?.team,
    atCorner: Math.abs(bp2.x) > 19 && Math.abs(bp2.z) > 9,
    ok: kind === 'corner' && m2.restartState?.team === 0 && Math.abs(bp2.x) > 19 && Math.abs(bp2.z) > 9,
  };
}

// 20. PENALTY: defender slide-fouls the carrier inside HIS OWN box ->
//     penalty at the spot, everyone but taker+keeper out of the box
{
  const m = new Match(RAPIER, 30);
  for (let n = 0; n < 3; n++) m.addPlayer(`bot-0-${n}`, `A${n}`, 0, true);
  for (let n = 0; n < 3; n++) m.addPlayer(`bot-1-${n}`, `B${n}`, 1, true);
  m.restart(180);
  // carrier (team 0) inside team 1's box (x near +L/2); defender behind him
  m.players[1].body.setTranslation({ x: 15.5, y: 0.91, z: 1 }, true);
  m.players[1].yaw = 0;
  m.players[4].body.setTranslation({ x: 14.1, y: 0.91, z: 1 }, true);
  m.players[4].yaw = 0;
  m.ball.setTranslation({ x: 16.0, y: 0.11, z: 1 }, true);
  m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
  let pen = '';
  for (let t = 0; t < 150 && !pen; t++) {
    for (let i = 0; i < 6; i++) m.setInput(i, idleFullInput());
    const ic = idleFullInput(); ic.mx = 0.25; m.setInput(1, ic);
    const idf = idleFullInput(); idf.mx = 1; idf.sprint = true; idf.slide = t === 8; m.setInput(4, idf);
    const evs = m.step();
    for (const e of evs) {
      if (e.kind === 'foul') {
        // knock the ball clear so no advantage plays
        m.ball.setTranslation({ x: -14, y: 0.11, z: -7 }, true);
        m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
      }
      if (e.detail === 'penalty') pen = e.detail;
    }
  }
  const bp = m.ball.translation();
  const rs = m.restartState;
  let cleared = true;
  if (rs) {
    for (let i = 0; i < 6; i++) {
      if (i === rs.taker || i === m.keeperOf(1)) continue;
      const p = m.players[i].pos;
      if (p.x > 20 - 6.29 && Math.abs(p.z) < 11.85 / 2) cleared = false;
    }
  }
  out.penaltyLaw = {
    event: pen,
    spotX: +bp.x.toFixed(2),
    boxCleared: cleared,
    takerTeam: rs?.team,
    ok: pen === 'penalty' && Math.abs(bp.x - (20 - 4.19)) < 0.3 && cleared && rs?.team === 0,
  };
}

// 21. KEEPER HANDS: a catchable shot at the keeper in his box is HELD
//     (possession, ball at chest, save event); a screamer is PARRIED away
{
  const m = new Match(RAPIER, 30);
  m.addPlayer('gk', 'GK', 1, true); // bot -> keeper spot
  m.addPlayer('st', 'ST', 0, false);
  m.restart(180);
  const gk = m.keeperOf(1);
  m.players[gk].body.setTranslation({ x: 19, y: 0.91, z: 0 }, true);
  // catchable shot: 12 m/s straight at him
  m.ball.setTranslation({ x: 15, y: 0.3, z: 0 }, true);
  m.ball.setLinvel({ x: 12, y: 0.5, z: 0 }, true);
  let saved = '';
  for (let t = 0; t < 60 && !saved; t++) {
    m.setInput(0, idleFullInput()); m.setInput(1, idleFullInput());
    for (const e of m.step()) if (e.kind === 'save') saved = e.detail ?? '';
  }
  // let the glue take effect (applied at the top of the next tick)
  for (let t = 0; t < 3; t++) { m.setInput(0, idleFullInput()); m.setInput(1, idleFullInput()); m.step(); }
  const bp = m.ball.translation();
  out.keeperCatch = {
    save: saved,
    holding: m.holdIdx === gk,
    ballAtChest: +bp.y.toFixed(2),
    ok: saved === 'catch' && m.holdIdx === gk && bp.y > 0.7,
  };

  // then he distributes (bot lob) and the hold ends
  let released = false;
  for (let t = 0; t < 150 && !released; t++) {
    const { botThink } = await import('../src/shared/sim3d/bots');
    m.setInput(0, botThink(m, 0));
    m.setInput(1, idleFullInput());
    m.step();
    if (m.holdIdx < 0) released = true;
  }
  out.keeperDistribute = { released, ok: released };

  // PARRY: 20 m/s screamer
  const m3 = new Match(RAPIER, 30);
  m3.addPlayer('gk', 'GK', 1, true);
  m3.restart(180);
  const g3 = m3.keeperOf(1);
  m3.players[g3].body.setTranslation({ x: 19, y: 0.91, z: 0 }, true);
  m3.ball.setTranslation({ x: 14, y: 0.4, z: 0 }, true);
  m3.ball.setLinvel({ x: 20, y: 0.5, z: 0 }, true);
  let parry = '';
  for (let t = 0; t < 60 && !parry; t++) {
    m3.setInput(0, idleFullInput());
    for (const e of m3.step()) if (e.kind === 'save') parry = e.detail ?? '';
  }
  const v3 = m3.ball.linvel();
  out.keeperParry = {
    save: parry,
    deflectedAway: v3.x < 0 || m3.score[0] === 0,
    noGoal: m3.score[0] === 0,
    ok: parry === 'parry' && m3.score[0] === 0,
  };
}

console.log(JSON.stringify(out, null, 1));
process.exit(0);
