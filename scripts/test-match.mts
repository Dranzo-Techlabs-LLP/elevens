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

console.log(JSON.stringify(out, null, 1));
process.exit(0);
