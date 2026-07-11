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

console.log(JSON.stringify(out, null, 1));
process.exit(0);
