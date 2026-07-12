// Bot intelligence telemetry: full-bot match, no humans. Measures whether
// bots actually collect loose balls, pass on purpose, and produce football.
// Run: npx tsx scripts/test-bots.mts
import RAPIER from '@dimforge/rapier3d-compat';
import { Match } from '../src/shared/sim3d/match';
import { botThink } from '../src/shared/sim3d/bots';

await RAPIER.init();
const m = new Match(RAPIER, 30);
for (let t = 0; t < 5; t++) m.addPlayer(`bot-0-${t}`, `A${t}`, 0, true);
for (let t = 0; t < 5; t++) m.addPlayer(`bot-1-${t}`, `B${t}`, 1, true);
m.restart(600);

let passes = 0;
let throughs = 0;
let shots = 0;
let lobs = 0;
let possessionChanges = 0;
let lastOwner = -1;
let looseSince = -1;
const looseDurations: number[] = [];
let ballTravel = 0;
let prevBX = 0;
let prevBZ = 0;

const TICKS = 30 * 90; // 90 seconds of football
for (let t = 0; t < TICKS; t++) {
  for (let i = 0; i < m.meta.length; i++) m.setInput(i, botThink(m, i));
  const events = m.step();
  for (const ev of events) {
    if (ev.kind === 'kick') {
      if (ev.detail === 'pass') passes++;
      else if (ev.detail === 'through') throughs++;
      else if (ev.detail === 'shoot') shots++;
      else if (ev.detail === 'lob' || ev.detail === 'clear') lobs++;
    }
  }
  const owner = m.poss.owner;
  if (owner !== lastOwner) {
    if (owner >= 0 && lastOwner >= 0) possessionChanges++;
    if (owner < 0) looseSince = t;
    else if (looseSince >= 0) {
      looseDurations.push((t - looseSince) / 30);
      looseSince = -1;
    }
    lastOwner = owner;
  }
  const bp = m.ball.translation();
  if (t > 0) ballTravel += Math.hypot(bp.x - prevBX, bp.z - prevBZ);
  prevBX = bp.x;
  prevBZ = bp.z;
}

const avgLoose = looseDurations.length
  ? looseDurations.reduce((a, b) => a + b, 0) / looseDurations.length
  : -1;
const maxLoose = looseDurations.length ? Math.max(...looseDurations) : -1;

console.log(
  JSON.stringify(
    {
      seconds: 90,
      score: m.score,
      passes,
      throughs,
      shots,
      lobs,
      possessionChanges,
      looseBallPickups: looseDurations.length,
      avgLooseSeconds: +avgLoose.toFixed(2),
      maxLooseSeconds: +maxLoose.toFixed(2),
      ballTravelM: Math.round(ballTravel),
    },
    null,
    1,
  ),
);
process.exit(0);
