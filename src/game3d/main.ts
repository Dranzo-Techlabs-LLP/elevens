// ============================================================
// ELEVENS 3D GAME CLIENT (M5/M6)
//  - connects to the authoritative Rapier server (ws, 30Hz snapshots)
//  - CLIENT-SIDE PREDICTION for the local player: inputs applied instantly
//    to a local Rapier world running the SAME SimPlayer code; on every
//    snapshot the local state is reset to the server's and un-acked inputs
//    are replayed (rewind + replay). Remote players + ball interpolate
//    100ms in the past (jitter buffer).
//  - quality tiers: high (shadows, dpr 1.75) / low (no shadows, dpr 1);
//    auto: touch devices default low. ?debug=1 adds a Tweakpane.
// ============================================================
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { BALL, MATCH, PITCH_5S, PLAYER } from '../shared/config3d';
import { SimPlayer, defaultMoveTune } from '../shared/sim3d/player';
import { HumanRig } from '../lab/rig';
import { CharModel, charsReady, loadChars } from './chars';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const canvas = document.getElementById('game') as HTMLCanvasElement;
const isTouch = 'ontouchstart' in window;
const L = PITCH_5S.length;
const W = PITCH_5S.width;
const TICK = MATCH.tickRate;
const DT = 1 / TICK;
const INTERP_MS = 100;

// ---------------- net ----------------
interface Snap {
  tick: number;
  phase: string;
  score: [number, number];
  timeLeft: number;
  owner: string | null;
  ack: number;
  ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number };
  players: {
    id: string; x: number; z: number; vx: number; vz: number; yaw: number;
    stamina: number; charge: number; stunned: boolean; sliding: boolean; shielding: boolean;
  }[];
}
let ws: WebSocket | null = null;
const snaps: { at: number; s: Snap }[] = [];
let myId: string | null = null;
let myTeam: 'A' | 'B' = 'A';
let roomCode = '';
let phase = 'lobby';

function wsUrl() {
  const p = new URLSearchParams(location.search);
  const host = p.get('server') ?? `${location.hostname}:3011`;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${host}`;
}

function send(m: unknown) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(m));
}

// ---------------- input ----------------
const keys = new Set<string>();
addEventListener('keydown', (e) => {
  if (['Space', 'KeyJ', 'KeyK', 'KeyL', 'KeyI', 'KeyV', 'KeyN'].includes(e.code) && playing) e.preventDefault();
  keys.add(e.code);
});
addEventListener('keyup', (e) => keys.delete(e.code));

const touchHeld: Record<string, boolean> = {};
for (const [btn, name] of [
  ['b-pass', 'pass'], ['b-shoot', 'shoot'], ['b-lob', 'lob'],
  ['b-thru', 'through'], ['b-tackle', 'tackle'], ['b-sprint', 'sprint'],
] as const) {
  const el = $(btn);
  let heldAt = 0;
  const down = (e: Event) => { e.preventDefault(); e.stopPropagation(); touchHeld[name] = true; heldAt = performance.now(); el.classList.add('held'); };
  const up = (e: Event) => {
    e.preventDefault(); e.stopPropagation(); el.classList.remove('held');
    // TKL: tap = standing tackle, long-press = slide
    if (name === 'tackle' && performance.now() - heldAt > 300) { touchHeld.slide = true; setTimeout(() => (touchHeld.slide = false), 80); }
    touchHeld[name] = false;
  };
  el.addEventListener('touchstart', down, { passive: false });
  el.addEventListener('touchend', up);
  el.addEventListener('mousedown', down);
  el.addEventListener('mouseup', up);
}

// virtual joystick (left half)
let joyId: number | null = null;
const joyBase = { x: 0, y: 0 };
const joyVec = { x: 0, y: 0 };
addEventListener('touchstart', (e) => {
  if (!playing) return;
  const t0 = e.target as HTMLElement;
  if (t0?.closest?.('.abtn, .overlay, button')) return;
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    if (joyId === null && t.clientX < innerWidth * 0.55) {
      joyId = t.identifier;
      joyBase.x = t.clientX; joyBase.y = t.clientY;
      joyVec.x = 0; joyVec.y = 0;
    }
  }
}, { passive: false });
addEventListener('touchmove', (e) => {
  if (joyId === null) return;
  e.preventDefault();
  for (const t of Array.from(e.changedTouches)) {
    if (t.identifier === joyId) {
      joyVec.x = (t.clientX - joyBase.x) / 55;
      joyVec.y = (t.clientY - joyBase.y) / 55;
      const l = Math.hypot(joyVec.x, joyVec.y);
      if (l > 1) { joyVec.x /= l; joyVec.y /= l; }
    }
  }
}, { passive: false });
const endTouch = (e: TouchEvent) => {
  for (const t of Array.from(e.changedTouches)) if (t.identifier === joyId) { joyId = null; joyVec.x = 0; joyVec.y = 0; }
};
addEventListener('touchend', endTouch);
addEventListener('touchcancel', endTouch);

// camera-relative movement (gesture-anchored, from the 2.5D build)
let camMode = 0; // 0 broadcast, 1 third, 2 first, 3 overhead
const CAM_NAMES = ['Broadcast', 'Third person', 'First person', 'Overhead'];
let camYaw = 0;
let refYaw = 0;
let lastRaw = { x: 0, z: 0 };
addEventListener('keydown', (e) => {
  if (e.code === 'KeyC' && playing) {
    camMode = (camMode + 1) % 4;
    hint(`Camera: ${CAM_NAMES[camMode]}`);
    $('hud-room').textContent = `room ${roomCode} · ${CAM_NAMES[camMode]} (C)`;
  }
});

function readInput() {
  // raw screen-space input
  let sx = 0, sz = 0;
  if (keys.has('KeyW')) sz -= 1;
  if (keys.has('KeyS')) sz += 1;
  if (keys.has('KeyA')) sx -= 1;
  if (keys.has('KeyD')) sx += 1;
  if (joyId !== null && Math.hypot(joyVec.x, joyVec.y) > 0.12) { sx = joyVec.x; sz = joyVec.y; }
  const l = Math.hypot(sx, sz);
  if (l > 1) { sx /= l; sz /= l; }

  // map to world: broadcast/overhead are screen-aligned (screen up = -x? no:
  // our broadcast looks down -z with +x right, so screen right = +x, screen
  // up = -z). third/first rotate with camYaw, anchored per gesture.
  let mx = 0, mz = 0;
  const camRel = camMode === 1 || camMode === 2;
  if (sx !== lastRaw.x || sz !== lastRaw.z) refYaw = camYaw;
  lastRaw = { x: sx, z: sz };
  if (camRel && (sx || sz)) {
    const fx = Math.cos(refYaw), fz = Math.sin(refYaw);
    mx = fx * -sz + -fz * sx;
    mz = fz * -sz + fx * sx;
  } else {
    mx = sx;      // screen right = +x
    mz = sz;      // screen down = +z
  }
  return {
    mx, mz,
    sprint: keys.has('ShiftLeft') || keys.has('ShiftRight') || !!touchHeld.sprint,
    shield: keys.has('KeyE'),
    pass: keys.has('Space') || keys.has('KeyJ') || !!touchHeld.pass,
    through: keys.has('KeyI') || !!touchHeld.through,
    shoot: keys.has('KeyK') || !!touchHeld.shoot,
    lob: keys.has('KeyL') || !!touchHeld.lob,
    tackle: keys.has('KeyV') || !!touchHeld.tackle,
    slide: keys.has('KeyN') || !!touchHeld.slide,
  };
}

// ---------------- prediction ----------------
let localWorld: RAPIER.World | null = null;
let localMe: SimPlayer | null = null;
const moveTune = defaultMoveTune();
let seq = 0;
const pending: { seq: number; inp: ReturnType<typeof readInput> }[] = [];
let shootHeldLocal = 0;
// visual smoothing: the sim steps at 30Hz but we render at 60-120 — the local
// player is interpolated between the previous and current sim tick, and its
// yaw/speed are filtered so the animation doesn't stutter at tick rate
const prevTickState = { x: 0, z: 0, yaw: 0 };
const currTickState = { x: 0, z: 0, yaw: 0 };
let visYaw = 0;
let visSpeed = 0;

// PREDICTED BALL CARRY: the ball snapshot lags ~RTT+interp behind your
// predicted body, so a carried ball visibly trailed every turn. When the
// SERVER says you own it, the rendered ball rides your predicted feet with
// zero lag; releases (kick/tackle/loss) blend back to the interpolated
// truth. Presentation only — the server stays authoritative.
let serverOwnerId: string | null = null;
let kickReleasedAt = -1e9;
const ballVis = new THREE.Vector3(0, 0.11, 0);
let prevActs = { pass: false, through: false, shoot: false, lob: false };

function initLocalSim() {
  localWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  localWorld.timestep = DT;
  const g = localWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  localWorld.createCollider(RAPIER.ColliderDesc.cuboid(80, 0.5, 60).setTranslation(0, -0.5, 0), g);
  const wall = (x: number, z: number, hx: number, hz: number) => {
    const b = localWorld!.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, 1, z));
    localWorld!.createCollider(RAPIER.ColliderDesc.cuboid(hx, 1, hz), b);
  };
  wall(0, -W / 2 - 0.15, L / 2 + 1, 0.15);
  wall(0, W / 2 + 0.15, L / 2 + 1, 0.15);
  localMe = new SimPlayer(RAPIER, localWorld, 0, 0);
}

function predictTick(inp: ReturnType<typeof readInput>) {
  if (!localMe || !localWorld) return;
  prevTickState.x = localMe.pos.x;
  prevTickState.z = localMe.pos.z;
  prevTickState.yaw = localMe.yaw;
  localMe.step(DT, { x: inp.mx, z: inp.mz, sprint: inp.sprint, shield: inp.shield }, moveTune);
  localWorld.step();
  currTickState.x = localMe.pos.x;
  currTickState.z = localMe.pos.z;
  currTickState.yaw = localMe.yaw;
  if (inp.shoot) shootHeldLocal += DT * 1000;
  else shootHeldLocal = 0;
}

function reconcile(s: Snap) {
  if (!localMe || !myId) return;
  const me = s.players.find((p) => p.id === myId);
  if (!me) return;
  localMe.body.setTranslation({ x: me.x, y: PLAYER.height / 2, z: me.z }, true);
  localMe.velX = me.vx;
  localMe.velZ = me.vz;
  localMe.yaw = me.yaw;
  localMe.stamina = me.stamina;
  // drop acked inputs, replay the rest
  while (pending.length && pending[0].seq <= s.ack) pending.shift();
  for (const p of pending) {
    localMe.step(DT, { x: p.inp.mx, z: p.inp.mz, sprint: p.inp.sprint, shield: p.inp.shield }, moveTune);
    localWorld!.step();
  }
}

// ---------------- renderer ----------------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const quality: 'high' | 'low' = new URLSearchParams(location.search).get('q') as any || (isTouch ? 'low' : 'high');
renderer.setPixelRatio(quality === 'low' ? 1 : Math.min(devicePixelRatio || 1, 1.75));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
renderer.shadowMap.enabled = quality === 'high';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x9fd4f5, 80, 240);
// gradient sky dome (zenith blue -> warm horizon)
{
  const c = document.createElement('canvas');
  c.width = 2;
  c.height = 512;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#3d86c6');
  grad.addColorStop(0.55, '#8ec9ef');
  grad.addColorStop(0.8, '#cfe8f7');
  grad.addColorStop(1, '#eef7dd');
  g.fillStyle = grad;
  g.fillRect(0, 0, 2, 512);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(320, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
    new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false }),
  );
  dome.position.y = -6;
  scene.add(dome);
}
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 400); // tighter = TV lens

scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x2e7a3b, 0.85));
const sun = new THREE.DirectionalLight(0xffe6bd, 1.85); // late-afternoon warmth
sun.position.set(-16, 19, 11);
sun.castShadow = quality === 'high';
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -28, right: 28, top: 24, bottom: -24, near: 4, far: 80 });
scene.add(sun);

// pitch
{
  const texC = document.createElement('canvas');
  texC.width = 2048; texC.height = 1024;
  const tx = texC.getContext('2d')!;
  const PX = 2048 / L; // px per meter
  tx.fillStyle = '#2c9740'; tx.fillRect(0, 0, 2048, 1024); // richer base green
  // mow stripes, PES-contrast two-tone
  tx.fillStyle = 'rgba(190,255,190,0.10)';
  for (let i = 0; i < 10; i += 2) tx.fillRect(i * 204.8, 0, 204.8, 1024);
  // grass noise
  for (let i = 0; i < 9000; i++) {
    tx.fillStyle = `rgba(0,55,0,${Math.random() * 0.10})`;
    tx.fillRect(Math.random() * 2048, Math.random() * 1024, 2.5, 2.5);
  }
  // ---- REGULATION MARKINGS, scaled from a full-size pitch to 40x20 ----
  // px per meter is uniform (2048/40 == 1024/20), so we draw in meter space.
  const S = 2048 / L;
  const mm = (m: number) => m * S;
  const LINE = mm(0.12); // 12cm lines
  tx.strokeStyle = 'rgba(255,255,255,0.96)';
  tx.fillStyle = 'rgba(255,255,255,0.96)';
  tx.lineWidth = LINE;
  tx.lineCap = 'butt';

  // proportions derived from a 105x68 pitch, scaled to our L x W:
  const PEN_DEPTH = (16.5 / 105) * L;   // 6.29m
  const PEN_WIDTH = (40.3 / 68) * W;    // 11.85m
  const SIX_DEPTH = (5.5 / 105) * L;    // 2.10m
  const SIX_WIDTH = (18.3 / 68) * W;    // 5.38m
  const SPOT = (11 / 105) * L;          // 4.19m
  const CIRC_R = (9.15 / 105) * L;      // 3.49m
  const CORNER_R = 0.6;

  const inset = LINE / 2 + 1;
  // touchlines + goal lines
  tx.strokeRect(inset, inset, 2048 - inset * 2, 1024 - inset * 2);
  // halfway line + center circle + center spot
  tx.beginPath(); tx.moveTo(1024, inset); tx.lineTo(1024, 1024 - inset); tx.stroke();
  tx.beginPath(); tx.arc(1024, 512, mm(CIRC_R), 0, Math.PI * 2); tx.stroke();
  tx.beginPath(); tx.arc(1024, 512, mm(0.12), 0, Math.PI * 2); tx.fill();

  for (const side of [0, 1]) {
    const dir = side === 0 ? 1 : -1;              // drawing direction from the goal line
    const gl = side === 0 ? inset : 2048 - inset; // goal line x (px)
    const boxX = side === 0 ? gl : gl - mm(PEN_DEPTH);
    // penalty area
    tx.strokeRect(boxX, 512 - mm(PEN_WIDTH) / 2, mm(PEN_DEPTH), mm(PEN_WIDTH));
    // goal area (6-yard box)
    const sixX = side === 0 ? gl : gl - mm(SIX_DEPTH);
    tx.strokeRect(sixX, 512 - mm(SIX_WIDTH) / 2, mm(SIX_DEPTH), mm(SIX_WIDTH));
    // penalty spot
    const spotX = gl + dir * mm(SPOT);
    tx.beginPath(); tx.arc(spotX, 512, mm(0.12), 0, Math.PI * 2); tx.fill();
    // penalty arc ("the D"): the part of the circle around the spot that
    // lies OUTSIDE the penalty area
    const cosA = (PEN_DEPTH - SPOT) / CIRC_R;     // where the circle meets the box edge
    const a = Math.acos(Math.min(1, Math.max(-1, cosA)));
    tx.beginPath();
    if (side === 0) tx.arc(spotX, 512, mm(CIRC_R), -a, a);
    else tx.arc(spotX, 512, mm(CIRC_R), Math.PI - a, Math.PI + a);
    tx.stroke();
  }

  // corner quarter-arcs (proper quadrant per corner)
  const cr = mm(CORNER_R);
  tx.beginPath(); tx.arc(inset, inset, cr, 0, Math.PI / 2); tx.stroke();
  tx.beginPath(); tx.arc(2048 - inset, inset, cr, Math.PI / 2, Math.PI); tx.stroke();
  tx.beginPath(); tx.arc(2048 - inset, 1024 - inset, cr, Math.PI, Math.PI * 1.5); tx.stroke();
  tx.beginPath(); tx.arc(inset, 1024 - inset, cr, Math.PI * 1.5, Math.PI * 2); tx.stroke();
  const ptex = new THREE.CanvasTexture(texC);
  ptex.colorSpace = THREE.SRGBColorSpace;
  ptex.anisotropy = 4;
  const pitch = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshLambertMaterial({ map: ptex }));
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = true;
  scene.add(pitch);
  const apron = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshLambertMaterial({ color: 0x26702f }));
  apron.rotation.x = -Math.PI / 2; apron.position.y = -0.02; apron.receiveShadow = true;
  scene.add(apron);
}

// goals + boards + stands + lights
function netGrid(w: number, h: number, step: number) {
  const pts: number[] = [];
  for (let x = 0; x <= w + 0.001; x += step) pts.push(x - w / 2, -h / 2, 0, x - w / 2, h / 2, 0);
  for (let y = 0; y <= h + 0.001; y += step) pts.push(-w / 2, y - h / 2, 0, w / 2, y - h / 2, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4 }));
}
{
  const postMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 });
  const gw = PITCH_5S.goalWidth, gh = PITCH_5S.goalHeight, gd = PITCH_5S.goalDepth;
  for (const sx of [-1, 1]) {
    const gx = sx * L / 2;
    for (const sz of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, gh, 10), postMat);
      p.position.set(gx, gh / 2, sz * gw / 2);
      p.castShadow = true;
      scene.add(p);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, gw, 10), postMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(gx, gh, 0);
    bar.castShadow = true;
    scene.add(bar);
    const back = netGrid(gw, gh, 0.3);
    back.rotation.y = Math.PI / 2;
    back.position.set(gx + sx * gd, gh / 2, 0);
    scene.add(back);
    const roof = netGrid(gd, gw, 0.3);
    roof.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
    roof.position.set(gx + sx * gd / 2, gh, 0);
    scene.add(roof);
    // side nets + angled rear stanchions — the goal reads as a real box
    for (const sz of [-1, 1]) {
      const sideNet = netGrid(gd, gh, 0.3);
      sideNet.position.set(gx + sx * gd / 2, gh / 2, sz * gw / 2);
      scene.add(sideNet);
      const stan = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.025, Math.hypot(gd, gh), 8),
        postMat,
      );
      stan.position.set(gx + sx * gd / 2, gh / 2, sz * gw / 2);
      stan.rotation.z = sx * Math.atan2(gd, gh);
      scene.add(stan);
    }
  }
  // ad boards ringing the pitch
  const adC = document.createElement('canvas');
  adC.width = 1024; adC.height = 64;
  const adx = adC.getContext('2d')!;
  const ads = ['E L E V E N S', 'DRANZO', '5 v 5', 'ELEVENS ARENA'];
  for (let i = 0; i < 4; i++) {
    adx.fillStyle = i % 2 ? '#0b3d91' : '#0f766e';
    adx.fillRect(i * 256, 0, 256, 64);
    adx.fillStyle = '#f8fafc';
    adx.font = '700 30px system-ui';
    adx.textAlign = 'center';
    adx.textBaseline = 'middle';
    adx.fillText(ads[i], i * 256 + 128, 34);
  }
  const adTex = new THREE.CanvasTexture(adC);
  adTex.colorSpace = THREE.SRGBColorSpace;
  adTex.wrapS = THREE.RepeatWrapping;
  const mkBoard = (x: number, z: number, w2: number, rotY = 0) => {
    const m = new THREE.MeshLambertMaterial({ map: adTex.clone() });
    m.map!.repeat.set(Math.max(1, Math.round(w2 / 10)), 1);
    const b = new THREE.Mesh(new THREE.BoxGeometry(w2, 0.9, 0.15), m);
    b.position.set(x, 0.45, z);
    b.rotation.y = rotY;
    scene.add(b);
  };
  mkBoard(0, -W / 2 - 0.3, L + 2);
  mkBoard(0, W / 2 + 0.3, L + 2, Math.PI);
  mkBoard(-L / 2 - 0.9, 0, W + 1, Math.PI / 2);
  mkBoard(L / 2 + 0.9, 0, W + 1, -Math.PI / 2);

  // corner flags
  for (const [cxx, czz] of [[-L / 2, -W / 2], [L / 2, -W / 2], [-L / 2, W / 2], [L / 2, W / 2]]) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 1.5, 6),
      new THREE.MeshLambertMaterial({ color: 0xf8fafc }),
    );
    pole.position.set(cxx, 0.75, czz);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.35, 0.25),
      new THREE.MeshLambertMaterial({ color: 0xef4444, side: THREE.DoubleSide }),
    );
    flag.position.set(cxx + 0.19, 1.32, czz);
    scene.add(pole, flag);
  }
  // crowd stands (far side + ends)
  const crowdC = document.createElement('canvas');
  crowdC.width = 256; crowdC.height = 64;
  const cx2 = crowdC.getContext('2d')!;
  // structured SEAT ROWS (not noise): 8px rows, seats in blocks with aisle
  // gaps, mixed fans/empty green seats — reads as a real stand
  cx2.fillStyle = '#1d2634';
  cx2.fillRect(0, 0, 256, 64);
  const fanCols = ['#e2e8f0', '#fbbf24', '#60a5fa', '#f87171', '#94a3b8', '#fb923c', '#4ade80'];
  for (let row = 0; row < 8; row++) {
    const y = row * 8;
    // row shadow line
    cx2.fillStyle = 'rgba(0,0,0,0.35)';
    cx2.fillRect(0, y + 6, 256, 2);
    for (let sx2 = 0; sx2 < 256; sx2 += 4) {
      if (sx2 % 64 < 3) continue; // aisles
      const occupied = Math.random() < 0.82;
      cx2.fillStyle = occupied
        ? fanCols[(Math.random() * fanCols.length) | 0]
        : '#14532d'; // empty green seat
      cx2.fillRect(sx2, y + 1, 3, 5);
    }
  }
  const crowdTex = new THREE.CanvasTexture(crowdC);
  crowdTex.wrapS = crowdTex.wrapT = THREE.RepeatWrapping;
  const stand = (w2: number, withRoof: boolean, tiersOverride?: number) => {
    const g = new THREE.Group();
    const tiers = tiersOverride ?? (withRoof ? 5 : 4);
    for (let t = 0; t < tiers; t++) {
      const m = new THREE.MeshLambertMaterial({ map: crowdTex.clone() });
      m.map!.repeat.set(Math.round(w2 / 6), 1);
      m.map!.offset.set(Math.random(), 0);
      const s = new THREE.Mesh(new THREE.BoxGeometry(w2, 1.1, 1.5), m);
      // depth grows along LOCAL +z = "away from the pitch" under every group
      // rotation used below. (The old -z authoring flipped under rotation.y=π
      // and marched the tiers + roof OVER the field — the dark plane that
      // occluded the far touchline and made players look out of bounds.)
      s.position.set(0, 0.55 + t * 1.05, t * 1.5);
      g.add(s);
    }
    const wallMat = new THREE.MeshLambertMaterial({ color: 0x3f4a5a });
    if (withRoof) {
      const back = new THREE.Mesh(new THREE.BoxGeometry(w2, 6.8, 0.3), wallMat);
      back.position.set(0, 3.4, 6.2);
      g.add(back);
      // roof only on the far grandstand — end roofs occluded the corners
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(w2, 0.22, 5.2),
        new THREE.MeshLambertMaterial({ color: 0x3a4658 }),
      );
      roof.position.set(0, 6.95, 4.0);
      g.add(roof);
      // lit underside so the bowl doesn't read as a black maw
      const under = new THREE.Mesh(
        new THREE.PlaneGeometry(w2, 5.2),
        new THREE.MeshBasicMaterial({ color: 0x2f3a4d }),
      );
      under.rotation.x = Math.PI / 2;
      under.position.set(0, 6.82, 4.0);
      g.add(under);
      for (let px2 = -w2 / 2 + 2; px2 <= w2 / 2 - 2; px2 += Math.max(6, w2 / 6)) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 6.8, 6), wallMat);
        post.position.set(px2, 3.4, 1.4); // front supports at the stand's leading edge
        g.add(post);
      }
      // roof flag row (outer edge)
      for (let fx2 = -w2 / 2 + 4; fx2 <= w2 / 2 - 4; fx2 += Math.max(8, w2 / 5)) {
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 5), wallMat);
        pole.position.set(fx2, 7.7, 5.0);
        const flag = new THREE.Mesh(
          new THREE.PlaneGeometry(0.7, 0.4),
          new THREE.MeshLambertMaterial({ color: [0x15803d, 0xd97706, 0x3b82f6][(Math.abs(fx2) | 0) % 3], side: THREE.DoubleSide }),
        );
        flag.position.set(fx2 + 0.36, 8.15, 5.0);
        g.add(pole, flag);
      }
    }
    return g;
  };
  // full bowl: covered main stand, open ends, angled corner blocks
  const s1 = stand(L + 8, true); s1.position.set(0, 0, -W / 2 - 2.4); s1.rotation.y = Math.PI; scene.add(s1);
  const s3 = stand(W + 2, false); s3.position.set(-L / 2 - 3.6, 0, 0); s3.rotation.y = -Math.PI / 2; scene.add(s3);
  const s4 = stand(W + 2, false); s4.position.set(L / 2 + 3.6, 0, 0); s4.rotation.y = Math.PI / 2; scene.add(s4);
  for (const [cx4, cz4, ry] of [
    [-L / 2 - 2.6, -W / 2 - 1.8, -Math.PI * 0.75],
    [L / 2 + 2.6, -W / 2 - 1.8, Math.PI * 0.75],
  ] as const) {
    const c = stand(9, false, 4);
    c.position.set(cx4, 0, cz4);
    c.rotation.y = ry; // +local-z (depth) points away from the pitch
    scene.add(c);
  }
  // dugouts on the near touchline (broadcast side)
  for (const dx2 of [-6, 6]) {
    const shel = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x1c2740, roughness: 0.35, metalness: 0.2 });
    const backW = new THREE.Mesh(new THREE.BoxGeometry(4.4, 1.5, 0.12), mat);
    backW.position.set(0, 0.75, 0.55);
    const roofP = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.1, 1.5), new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.25, metalness: 0.4, transparent: true, opacity: 0.9 }));
    roofP.position.set(0, 1.55, 0);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.12, 0.45), new THREE.MeshLambertMaterial({ color: 0x475569 }));
    bench.position.set(0, 0.5, 0.28);
    shel.add(backW, roofP, bench);
    shel.position.set(dx2, 0, W / 2 + 1.3);
    scene.add(shel);
  }
  // floodlights
  for (const [fx, fz] of [[-L / 2 - 4, -W / 2 - 4], [L / 2 + 4, -W / 2 - 4], [-L / 2 - 4, W / 2 + 4], [L / 2 + 4, W / 2 + 4]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 12, 8), new THREE.MeshLambertMaterial({ color: 0x475569 }));
    pole.position.set(fx, 6, fz);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1, 0.3), new THREE.MeshBasicMaterial({ color: 0xfffbe8 }));
    lamp.position.set(fx, 12.2, fz);
    lamp.lookAt(0, 0, 0);
    scene.add(pole, lamp);
  }
}

// ball visual
const ballMesh = (() => {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = '#fafafa'; x.fillRect(0, 0, 128, 64);
  x.fillStyle = '#111827';
  for (let i = 0; i < 10; i++) { x.beginPath(); x.arc((i % 5) * 26 + (i > 4 ? 13 : 6), ((i / 5) | 0) * 32 + 14, 6, 0, 7); x.fill(); }
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.radius, 22, 16),
    new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(c), roughness: 0.35 }),
  );
  m.castShadow = quality === 'high';
  scene.add(m);
  return m;
})();
const ballShadow = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, 'rgba(0,0,0,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 64, 64);
  const m = new THREE.Mesh(new THREE.CircleGeometry(BALL.radius * 2.2, 16), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.01;
  scene.add(m);
  return m;
})();

// player models — real rigged characters when the GLB loaded, procedural
// fallback otherwise. Both expose the same update/trigger surface.
interface Model { rig: HumanRig | CharModel; label: THREE.Sprite; ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; }
const models = new Map<string, Model>();
(window as any).__models = models; // debug/verification hook
(window as any).__ballVis = ballVis;
function label(text: string) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 56;
  const x = c.getContext('2d')!;
  x.font = '700 30px system-ui'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,0.7)'; x.strokeText(text, 128, 28);
  x.fillStyle = '#fff'; x.fillText(text, 128, 28);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  s.scale.set(1.9, 0.42, 1);
  return s;
}
function getModel(id: string, name: string, team: 'A' | 'B') {
  let m = models.get(id);
  if (!m) {
    let seed = 0;
    for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) | 0;
    const rig = charsReady()
      ? new CharModel(team, seed)
      : new HumanRig(team === 'A' ? 0x2563eb : 0xdc2626, seed);
    scene.add(rig.group);
    const lb = label(name);
    lb.position.y = 2.15;
    rig.group.add(lb);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    rig.group.add(ring);
    m = { rig, label: lb, ring, ringMat };
    models.set(id, m);
  }
  return m;
}

// ---------------- UI ----------------
let playing = false;
function showScreen(which: 'menu' | 'lobby' | 'end' | null) {
  $('menu').classList.toggle('hidden', which !== 'menu');
  $('lobby').classList.toggle('hidden', which !== 'lobby');
  $('end').classList.toggle('hidden', which !== 'end');
  playing = which === null;
  $('hud').classList.toggle('hidden', !playing);
  $('stam-wrap').classList.toggle('hidden', !playing);
  $('actions').classList.toggle('hidden', !(playing && isTouch));
}
let bannerT = 0;
function banner(t: string, ms = 1500) {
  $('banner').textContent = t;
  $('banner').classList.add('show');
  clearTimeout(bannerT);
  bannerT = window.setTimeout(() => $('banner').classList.remove('show'), ms);
}
let hintT = 0;
function hint(t: string, ms = 1600) {
  $('hint').textContent = t;
  $('hint').classList.add('show');
  clearTimeout(hintT);
  hintT = window.setTimeout(() => $('hint').classList.remove('show'), ms);
}

const nameInput = $('name') as HTMLInputElement;
nameInput.value = localStorage.getItem('elevens-name') ?? '';

function join(room: string | null) {
  $('menu-err').textContent = '';
  const name = nameInput.value.trim() || 'Player';
  localStorage.setItem('elevens-name', name);
  ws = new WebSocket(wsUrl());
  ws.onerror = () => ($('menu-err').textContent = 'Could not reach server (is it running on :3011?)');
  ws.onclose = () => { showScreen('menu'); $('menu-err').textContent = 'Disconnected'; myId = null; snaps.length = 0; };
  ws.onopen = () => send({ type: 'join', mode: '3d', room, name });
  ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
}
$('create').onclick = () => join(null);
$('join').onclick = () => {
  const code = ($('code') as HTMLInputElement).value.trim().toUpperCase();
  if (code.length !== 4) { $('menu-err').textContent = 'Code is 4 letters'; return; }
  join(code);
};
$('start').onclick = () => send({ type: 'start' });
$('rematch').onclick = () => send({ type: 'rematch' });

let winner: string | null = null;
function onMsg(m: any) {
  switch (m.type) {
    case 'joined':
      myId = m.playerId;
      myTeam = m.team;
      roomCode = m.room;
      $('room-code').textContent = roomCode;
      $('hud-room').textContent = `room ${roomCode} · ${CAM_NAMES[camMode]} (C)`;
      break;
    case 'lobby': {
      for (const p of m.players) {
        lobbyTeams.set(p.id, p.team);
        lobbyNames.set(p.id, p.name);
      }
      const fill = (t: string, el: HTMLElement) => {
        el.innerHTML = '';
        for (const p of m.players.filter((p: any) => p.team === t)) {
          const li = document.createElement('li');
          li.textContent = p.name + (p.host ? ' ★' : '') + (p.id === myId ? ' (you)' : '');
          el.appendChild(li);
        }
      };
      fill('A', $('teamA'));
      fill('B', $('teamB'));
      $('start').classList.toggle('hidden', !m.youAreHost);
      $('wait-host').classList.toggle('hidden', m.youAreHost);
      if (phase === 'lobby') showScreen('lobby');
      break;
    }
    case 's3': {
      (window as any).__snap = m; // debug/telemetry hook
      (window as any).__camYaw = camYaw;
      (window as any).__camMode = camMode;
      serverOwnerId = m.owner ?? null;
      const prev = phase;
      phase = m.phase;
      snaps.push({ at: performance.now(), s: m });
      if (snaps.length > 90) snaps.shift();
      reconcile(m);
      if ((phase === 'playing' || phase === 'goal') && prev !== 'playing' && prev !== 'goal') {
        showScreen(null);
        hint(isTouch ? 'Drag left = move · hold SHOOT for power · TKL long-press = slide' : 'WASD move · K hold = shoot · V tackle · N slide · C camera', 4000);
      }
      if (phase === 'ended' && prev !== 'ended') {
        const [a, b] = m.score;
        $('result').textContent = winner === 'draw' ? 'DRAW' : winner === myTeam ? 'YOU WIN 🎉' : 'YOU LOSE';
        $('final-score').textContent = `Team A ${a} — ${b} Team B`;
        showScreen('end');
      }
      break;
    }
    case 'e3':
      if (m.kind === 'goal') banner(`GOAL!  ${m.score[0]} — ${m.score[1]}`);
      if (m.kind === 'kickoff') { winner = null; banner('KICKOFF', 900); }
      if (m.kind === 'end') winner = m.winner;
      if (m.kind === 'foul') banner('FOUL!', 1000);
      if (m.kind === 'restart') banner(m.what === 'throwin' ? 'THROW-IN' : 'GOAL KICK', 1000);
      if (m.kind === 'kick' && m.id) {
        const mdl = models.get(m.id);
        if (mdl && 'triggerKick' in mdl.rig) (mdl.rig as any).triggerKick();
      }
      break;
    case 'error':
      $('menu-err').textContent = m.msg;
      break;
  }
}

// ---------------- interpolation ----------------
function sample() {
  if (!snaps.length) return null;
  const t = performance.now() - INTERP_MS;
  let a = snaps[0], b = snaps[snaps.length - 1];
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].at <= t) { a = snaps[i]; b = snaps[i + 1] ?? snaps[i]; break; }
  }
  const span = b.at - a.at;
  const k = span > 0 ? Math.min(1, Math.max(0, (t - a.at) / span)) : 1;
  const lerp = (x: number, y: number) => x + (y - x) * k;
  const la = (x: number, y: number) => {
    let d = y - x;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return x + d * k;
  };
  const latest = snaps[snaps.length - 1].s;
  return {
    latest,
    ball: {
      x: lerp(a.s.ball.x, b.s.ball.x), y: lerp(a.s.ball.y, b.s.ball.y), z: lerp(a.s.ball.z, b.s.ball.z),
      vx: b.s.ball.vx, vz: b.s.ball.vz,
    },
    players: b.s.players.map((pb) => {
      const pa = a.s.players.find((p) => p.id === pb.id) ?? pb;
      return { ...pb, x: lerp(pa.x, pb.x), z: lerp(pa.z, pb.z), yaw: la(pa.yaw, pb.yaw) };
    }),
  };
}

// ---------------- main loop ----------------
const teamOf = new Map<string, 'A' | 'B'>();
let lastFrame = performance.now();
let acc = 0;

function frame() {
  const now = performance.now();
  const dtReal = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  // fixed-rate local prediction + input send (30Hz, matches the server)
  if (playing && myId) {
    acc += dtReal;
    while (acc >= DT) {
      acc -= DT;
      const inp = readInput();
      seq++;
      send({ type: 'i3', seq, ...inp });
      pending.push({ seq, inp });
      if (pending.length > 60) pending.shift();
      predictTick(inp);
    }
  }

  const view = sample();
  if (view) {
    // ---- ball rendering: predicted carry vs interpolated truth ----
    // detect kick releases: the instant you strike, stop gluing — the interp
    // stream will show the ball leaving (windup animation covers the delay)
    const actNow = readInput();
    const acts = { pass: actNow.pass, through: actNow.through, shoot: actNow.shoot, lob: actNow.lob } as any;
    for (const k of Object.keys(prevActs) as (keyof typeof prevActs)[]) {
      if (prevActs[k] && !acts[k]) kickReleasedAt = now;
      prevActs[k] = !!acts[k];
    }
    const iCarry =
      serverOwnerId !== null &&
      serverOwnerId === myId &&
      localMe !== null &&
      now - kickReleasedAt > 600 &&
      phase === 'playing';
    if (iCarry) {
      // ball rides the PREDICTED feet — zero perceived lag through turns
      const lead = 0.32 + Math.min(0.25, (visSpeed / 8.5) * 0.25);
      const tx = myVisX + Math.cos(visYaw) * lead;
      const tz = myVisZ + Math.sin(visYaw) * lead;
      const k = 1 - Math.exp(-22 * dtReal);
      ballVis.x += (tx - ballVis.x) * k;
      ballVis.z += (tz - ballVis.z) * k;
      ballVis.y += (BALL.radius - ballVis.y) * k;
      // roll the ball with the carry speed
      if (visSpeed > 0.2) {
        const axis = new THREE.Vector3(Math.sin(visYaw), 0, -Math.cos(visYaw));
        ballMesh.rotateOnWorldAxis(axis, (-visSpeed * dtReal) / BALL.radius);
      }
    } else {
      // interpolated truth, converged fast so owner->free transitions don't pop
      const k = 1 - Math.exp(-28 * dtReal);
      ballVis.x += (view.ball.x - ballVis.x) * k;
      ballVis.y += (view.ball.y - ballVis.y) * k;
      ballVis.z += (view.ball.z - ballVis.z) * k;
      const sp = Math.hypot(view.ball.vx, view.ball.vz);
      if (sp > 0.2) {
        const axis = new THREE.Vector3(view.ball.vz / sp, 0, -view.ball.vx / sp);
        ballMesh.rotateOnWorldAxis(axis, (-sp * dtReal) / BALL.radius);
      }
    }
    ballMesh.position.copy(ballVis);
    ballShadow.position.set(ballVis.x, 0.02, ballVis.z);
    const shk = Math.max(0.3, 1 - (ballVis.y - BALL.radius) / 8);
    ballShadow.scale.setScalar(shk);

    // players — bots encode their team in the id (bot-0-*, bot-1-*);
    // humans come from the cached lobby roster
    const seen = new Set<string>();
    for (const p of view.players) {
      seen.add(p.id);
      const isMe = p.id === myId;
      const team: 'A' | 'B' = p.id.startsWith('bot-1') ? 'B' : p.id.startsWith('bot-0') ? 'A' : (lobbyTeams.get(p.id) ?? (isMe ? myTeam : 'A'));
      const name = isMe
        ? (nameInput.value.trim() || 'You')
        : (lobbyNames.get(p.id) ?? (p.id.startsWith('bot-') ? p.id.replace(/bot-\d-/, 'Bot ') : p.id));
      const m = getModel(p.id, name, team);
      // OWN player renders from the local prediction, INTERPOLATED between
      // sim ticks (alpha = accumulator progress) with filtered yaw/speed —
      // this is what makes movement read smooth at any display Hz
      let px: number, pz: number, pyaw: number, spd: number;
      if (isMe && localMe) {
        const alpha = Math.min(1, acc / DT);
        px = prevTickState.x + (currTickState.x - prevTickState.x) * alpha;
        pz = prevTickState.z + (currTickState.z - prevTickState.z) * alpha;
        let dy = currTickState.yaw - visYaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        visYaw += dy * (1 - Math.exp(-14 * dtReal));
        pyaw = visYaw;
        visSpeed += (localMe.speed - visSpeed) * (1 - Math.exp(-8 * dtReal));
        spd = visSpeed;
      } else {
        px = p.x;
        pz = p.z;
        pyaw = p.yaw;
        spd = Math.hypot(p.vx, p.vz);
      }
      // presentation clamp: whatever the source (stale server, desync,
      // interpolation overshoot), a player is never DRAWN outside the field
      px = Math.max(-L / 2 + 0.25, Math.min(L / 2 - 0.25, px));
      pz = Math.max(-W / 2 + 0.25, Math.min(W / 2 - 0.25, pz));
      if (isMe) { myVisX = px; myVisZ = pz; }
      m.rig.group.position.set(px, 0, pz);
      m.rig.group.rotation.y = -pyaw;
      m.rig.extraPitch = p.sliding ? -1.15 : p.stunned ? 0.35 : 0;
      m.rig.update(dtReal, {
        speed: spd,
        yawRate: isMe && localMe ? localMe.yawRate : 0,
        stamina: p.stamina,
        shield: p.shielding,
        sliding: p.sliding,
        stunned: p.stunned,
        lookYaw: Math.atan2(ballVis.z - pz, ballVis.x - px),
        bodyYaw: pyaw,
      } as any);
      const charge = isMe ? Math.min(1, shootHeldLocal / 900) : p.charge;
      m.ringMat.opacity = charge > 0.02 ? 0.35 + 0.6 * charge : 0;
      m.ringMat.color.setHSL(0.15 - 0.15 * charge, 1, 0.55);
      m.rig.group.visible = !(camMode === 2 && isMe);
    }
    for (const [id, m] of models) {
      if (!seen.has(id)) { scene.remove(m.rig.group); models.delete(id); }
    }

    // HUD — broadcast scorebug
    const t = Math.max(0, view.latest.timeLeft);
    $('sb-a').textContent = String(view.latest.score[0]);
    $('sb-b').textContent = String(view.latest.score[1]);
    $('sb-clock').textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
    const meSnap = view.latest.players.find((p) => p.id === myId);
    if (meSnap) {
      const st = $('stam') as HTMLElement;
      st.style.width = `${Math.round(meSnap.stamina * 100)}%`;
      st.classList.toggle('low', meSnap.stamina < 0.3);
    }

    // camera (follows the INTERPOLATED body)
    if (calibMode) { renderer.render(scene, camera); requestAnimationFrame(frame); return; }
    const me = localMe;
    const mx = me ? myVisX : view.ball.x;
    const mz = me ? myVisZ : view.ball.z;
    if (me) {
      let d = Math.atan2(me.velZ, me.velX);
      if (me.speed < 0.5) d = me.yaw;
      let dd = d - camYaw;
      while (dd > Math.PI) dd -= Math.PI * 2;
      while (dd < -Math.PI) dd += Math.PI * 2;
      camYaw += dd * (1 - Math.exp(-(camMode === 2 ? 10 : 7) * dtReal));
    }
    const bx = view.ball.x + view.ball.vx * 0.25;
    const bz = view.ball.z + view.ball.vz * 0.25;
    if (camMode === 0) {
      // PES-style TV broadcast: lower, farther, tighter lens, ball-led pan
      const fx = Math.max(-L / 2 + 7, Math.min(L / 2 - 7, bx * 0.72 + mx * 0.28));
      const fz = Math.max(-2, Math.min(W / 2, bz * 0.6 + mz * 0.4));
      camTarget.lerp(new THREE.Vector3(fx, 0, fz), 1 - Math.exp(-4 * dtReal));
      camera.position.set(camTarget.x, 10.5, camTarget.z + 17.5);
      camera.lookAt(camTarget.x, 0.2, camTarget.z - 2.2);
    } else if (camMode === 1) {
      const fx = Math.cos(camYaw), fz = Math.sin(camYaw);
      // smoothed chase — hard-setting the position transmits every sim step
      camPos.set(mx - fx * 5.4, 3.2, mz - fz * 5.4);
      camera.position.lerp(camPos, 1 - Math.exp(-12 * dtReal));
      camera.lookAt(mx + fx * 3.5, 0.7, mz + fz * 3.5);
    } else if (camMode === 2) {
      const fx = Math.cos(camYaw), fz = Math.sin(camYaw);
      camera.position.set(mx + fx * 0.25, PLAYER.eyeHeight, mz + fz * 0.25);
      camera.lookAt(mx + fx * 4, 0.15, mz + fz * 4);
    } else {
      camTarget.lerp(new THREE.Vector3(bx, 0, bz), 1 - Math.exp(-4 * dtReal));
      camera.position.set(camTarget.x, 30, camTarget.z + 0.01);
      camera.lookAt(camTarget.x, 0, camTarget.z);
    }

    // joystick overlay
    if (joyId !== null) {
      $('joy-base').style.display = 'block';
      $('joy-knob').style.display = 'block';
      $('joy-base').style.transform = `translate(${joyBase.x - 52}px, ${joyBase.y - 52}px)`;
      $('joy-knob').style.transform = `translate(${joyBase.x + joyVec.x * 52 - 22}px, ${joyBase.y + joyVec.y * 52 - 22}px)`;
    } else {
      $('joy-base').style.display = 'none';
      $('joy-knob').style.display = 'none';
    }
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
const camTarget = new THREE.Vector3(0, 0, 0);
const camPos = new THREE.Vector3(0, 10, 14);
let myVisX = 0;
let myVisZ = 0;

// lobby caches (names/teams of humans for rendering)
const lobbyTeams = new Map<string, 'A' | 'B'>();
const lobbyNames = new Map<string, string>();

// --- facing calibration harness (console): __calib() spawns a lone model at
// origin with yaw 0 and locks a side-on camera; __modelYaw(v) rotates it live.
let calibMode = false;
(window as any).__calib = () => {
  calibMode = true;
  const rig = new CharModel('A');
  rig.group.position.set(0, 0, 0);
  scene.add(rig.group);
  (window as any).__calibRig = rig;
  setInterval(() => rig.update(1 / 60, { speed: 3, stamina: 1, yawRate: 0 }), 16);
  camera.position.set(0, 1.6, 6);
  camera.lookAt(0, 1, 0);
};

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------------- boot ----------------
(async () => {
  await Promise.all([RAPIER.init(), loadChars()]);
  initLocalSim();
  resize();
  showScreen('menu');
  requestAnimationFrame(frame);

  if (new URLSearchParams(location.search).get('debug') === '1') {
    const { Pane } = await import('tweakpane');
    const pane = new Pane({ title: 'Move feel (client prediction)' }) as any;
    pane.addBinding(moveTune, 'sprintSpeed', { min: 5, max: 11 });
    pane.addBinding(moveTune, 'accel', { min: 2, max: 10 });
    pane.addBinding(moveTune, 'turnRateSprint', { min: 0.8, max: 6 });
  }
})();
