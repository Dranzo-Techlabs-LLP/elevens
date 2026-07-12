import RAPIER from '@dimforge/rapier3d-compat';
import { Match } from '../src/shared/sim3d/match';
import { botThink } from '../src/shared/sim3d/bots';
await RAPIER.init();
const m = new Match(RAPIER, 30);
for (let n = 0; n < 5; n++) m.addPlayer(`bot-0-${n}`, `A${n}`, 0, true);
for (let n = 0; n < 5; n++) m.addPlayer(`bot-1-${n}`, `B${n}`, 1, true);
m.restart(180);
let shots = 0, saves = 0, corners = 0, penalties = 0, freekicks = 0, throwins = 0, goalkicks = 0;
for (let t = 0; t < 180 * 30 && m.phase !== 'ended'; t++) {
  for (let i = 0; i < 10; i++) m.setInput(i, botThink(m, i));
  for (const e of m.step()) {
    if (e.detail === 'shoot') shots++;
    if (e.kind === 'save') saves++;
    if (e.detail === 'corner') corners++;
    if (e.detail === 'penalty') penalties++;
    if (e.detail === 'freekick') freekicks++;
    if (e.detail === 'throwin') throwins++;
    if (e.detail === 'goalkick') goalkicks++;
  }
}
console.log(JSON.stringify({ score: m.score, shots, saves, corners, penalties, freekicks, throwins, goalkicks }));
process.exit(0);
