import RAPIER from '@dimforge/rapier3d-compat';
import { Match, idleFullInput } from '../src/shared/sim3d/match';

await RAPIER.init();
const m = new Match(RAPIER, 30);
m.addPlayer('h1', 'Carrier', 0, false);
m.addPlayer('h2', 'Def', 1, false);
m.restart(180);
m.players[0].body.setTranslation({ x: 0, y: 0.91, z: 5 }, true);
m.players[1].body.setTranslation({ x: 1.1, y: 0.91, z: 5.4 }, true);
m.ball.setTranslation({ x: 0.4, y: 0.11, z: 5 }, true);
m.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
for (let t = 0; t < 45; t++) {
  const ic = idleFullInput(); ic.mx = 0.4;
  const idf = idleFullInput(); idf.tackle = t === 20;
  m.setInput(0, ic);
  m.setInput(1, idf);
  const ev = m.step();
  const b = m.ball.translation();
  const bv = m.ball.linvel();
  const d0 = Math.hypot(b.x - m.players[0].pos.x, b.z - m.players[0].pos.z);
  const d1 = Math.hypot(b.x - m.players[1].pos.x, b.z - m.players[1].pos.z);
  if (t >= 18 && t <= 32) {
    console.log(
      t,
      'owner', m.poss.owner,
      'dC', d0.toFixed(2),
      'dD', d1.toFixed(2),
      'ballV', Math.hypot(bv.x, bv.z).toFixed(1),
      ev.map((e) => e.kind).join(',') || '-',
    );
  }
}
process.exit(0);
