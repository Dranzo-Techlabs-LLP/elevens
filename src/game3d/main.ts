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
import {
  BloomEffect, EffectComposer, EffectPass, RenderPass, SMAAEffect,
  ToneMappingEffect, ToneMappingMode, VignetteEffect,
} from 'postprocessing';
import { FX } from './fx';
import { sfx } from './sfx';
import { buildLighting, readTimeOfDay, saveTimeOfDay, type TimeOfDay } from './lighting';
import { buildPitch } from './pitch';
import { buildStadium } from './stadium';
import { GoalNets } from './nets';
import { buildBall } from './ball';
import { Recorder, ReplayDirector, type RBody } from './replay';

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
  ref?: { x: number; z: number; yaw: number; speed: number };
  restart?: { kind: string; taker: string } | null;
  players: {
    id: string; x: number; z: number; vx: number; vz: number; yaw: number;
    stamina: number; charge: number; stunned: boolean; sliding: boolean; shielding: boolean;
    holding?: boolean;
    keeper?: boolean;
  }[];
}
let ws: WebSocket | null = null;
const snaps: { at: number; s: Snap }[] = [];
let myId: string | null = null;
let myTeam: 'A' | 'B' = 'A';
let roomCode = '';
let phase = 'lobby';

const VITE_DEV_PORTS = new Set(['5173', '5174', '5175']);
function wsUrl() {
  const p = new URLSearchParams(location.search);
  // production: the node server serves this page AND the websocket on one
  // port, so same-origin just works. Vite dev pages still target :3011.
  // The ?server= override is DEV-ONLY: honoring it in production would let
  // any crafted link repoint the game socket at an attacker's host.
  const override = VITE_DEV_PORTS.has(location.port) ? p.get('server') : null;
  const host = override
    ?? (VITE_DEV_PORTS.has(location.port) ? `${location.hostname}:3011` : location.host);
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
let prevTackleKey = false;

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
// r185 deprecated PCFSoft; PCF + a blur radius gives the same soft penumbra
renderer.shadowMap.type = THREE.PCFShadowMap;

// PES broadcast grade: SMAA + a restrained bloom (white lines, floodlit kits
// glow like a TV feed) + lens vignette. Desktop only — the mobile 30fps floor
// is non-negotiable, so 'low' keeps the plain forward render.
const composer = quality === 'high'
  ? new EffectComposer(renderer, { frameBufferType: THREE.HalfFloatType })
  : null;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 600); // tighter = TV lens
const BASE_FOV = 42;
let fovPunch = 0; // goal moment: quick lens punch, decays to broadcast FOV

// time of day: physically-based sky + image-based lighting (day / sunset /
// night under floodlights). ?tod=day|sunset|night, remembered per browser.
const tod: TimeOfDay = readTimeOfDay();
const lights = buildLighting(renderer, scene, {
  tod, shadows: quality === 'high', L, W, hiRes: quality === 'high',
});
(window as any).__setTod = (t: TimeOfDay) => { saveTimeOfDay(t); location.reload(); };

if (composer) {
  composer.addPass(new RenderPass(scene, camera));
  // (no SSAO: its normal pass renders billboards — name tags, crowd cards,
  // nets — as solid quads and stamps dark rectangles behind them. Bodies
  // are grounded by the shadow map + per-player contact shadows instead.)
  composer.addPass(new EffectPass(
    camera,
    new SMAAEffect(),
    new BloomEffect({
      intensity: tod === 'night' ? 0.85 : 0.45,
      luminanceThreshold: tod === 'night' ? 0.8 : 0.9,
      luminanceSmoothing: 0.2, mipmapBlur: true,
    }),
    // tone mapping MUST live in the effect chain: the composer renders to
    // a half-float buffer, where renderer.toneMapping is never applied
    new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC }),
    new VignetteEffect({ darkness: 0.38, offset: 0.28 }),
  ));
}

// pitch: broadcast turf (view-dependent mow stripes, blade detail, wear)
buildPitch(scene, {
  L, W, hiRes: quality === 'high', night: tod === 'night',
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
});

// goal frames: glossy posts + crossbar, rear stanchions; the netting is a
// cloth simulation (see nets.ts) that bulges when the ball hits it
const nets = (() => {
  const postMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.22, metalness: 0.05 });
  const gw = PITCH_5S.goalWidth, gh = PITCH_5S.goalHeight, gd = PITCH_5S.goalDepth;
  for (const sx of [-1, 1]) {
    const gx = sx * L / 2;
    for (const sz of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, gh, 14), postMat);
      p.position.set(gx, gh / 2, sz * gw / 2);
      p.castShadow = true;
      scene.add(p);
      // rear stanchion (post top -> ground at the back of the net)
      const len = Math.hypot(gd, gh);
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 8), postMat);
      st.position.set(gx + sx * gd / 2, gh / 2, sz * gw / 2);
      st.rotation.z = sx * Math.atan2(gd, gh);
      st.castShadow = true;
      scene.add(st);
      // ground bar along the base of the side netting
      const gb = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, gd, 6), postMat);
      gb.rotation.z = Math.PI / 2;
      gb.position.set(gx + sx * gd / 2, 0.02, sz * gw / 2);
      scene.add(gb);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, gw + 0.1, 14), postMat);
    bar.rotation.x = Math.PI / 2;
    bar.position.set(gx, gh, 0);
    bar.castShadow = true;
    scene.add(bar);
    const back = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, gw, 6), postMat);
    back.rotation.x = Math.PI / 2;
    back.position.set(gx + sx * gd, 0.02, 0);
    scene.add(back);
  }
  return new GoalNets(scene, L, gw, gh, gd);
})();

// the bowl: raked stands, a living instanced crowd, floodlight towers,
// animated LED boards, dugouts
const stadium = buildStadium(scene, {
  L, W, night: tod === 'night', hiRes: quality === 'high',
  towers: lights.towers, teamColors: [0x2563eb, 0xdc2626],
});

// ball visual
const ballMesh = (() => {
  const m = buildBall(BALL.radius, quality === 'high');
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

// match effects (ball trail / kick puffs / goal confetti) + stadium audio.
// Audio unlocks on the first gesture (browser autoplay policy).
const fx = new FX(scene);
const unlockAudio = () => {
  sfx.unlock();
  removeEventListener('pointerdown', unlockAudio);
  removeEventListener('keydown', unlockAudio);
};
addEventListener('pointerdown', unlockAudio);
addEventListener('keydown', unlockAudio);
(window as any).__sfx = sfx; // debug/verification hook
(window as any).__fx = fx;
let crowdSent = -1; // last level pushed to sfx (ramps are scheduled; don't spam)

// player models — real rigged characters when the GLB loaded, procedural
// fallback otherwise. Both expose the same update/trigger surface.
interface Model {
  rig: HumanRig | CharModel; label: THREE.Sprite; ring: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; cursor: THREE.Mesh;
  /** night: four long faint shadows, one away from each floodlight tower */
  radial: THREE.Object3D[] | null;
  prevYaw: number; yawRate: number;
}
const models = new Map<string, Model>();

// ---- goal replays: record what was rendered, play it back after goals ----
const recorder = new Recorder();
const director = new ReplayDirector();
let pendingReplay: { at: number; goalAt: number; side: number } | null = null;
const rigIds = new WeakMap<object, string>();
CharModel.onAction = (rig, kind, arg) => {
  if (director.active) return; // never re-log the replay's own playback
  const id = rigIds.get(rig);
  if (id) recorder.log({ t: performance.now(), id, kind, arg });
};
const replayUI = (() => {
  const st = document.createElement('style');
  st.textContent = `
    #replay-ui { position: fixed; inset: 0; pointer-events: none; z-index: 6; }
    #replay-ui .rb { position: absolute; left: 0; right: 0; height: 9vh; background: #000;
      transition: transform 260ms cubic-bezier(.2,.8,.2,1); }
    #replay-ui .rb.top { top: 0; transform: translateY(-100%); }
    #replay-ui .rb.bot { bottom: 0; transform: translateY(100%); }
    #replay-ui.on .rb { transform: translateY(0); }
    #replay-ui .rbadge { position: absolute; top: calc(9vh + 14px); right: 18px;
      font: 700 15px 'Russo One', system-ui, sans-serif; letter-spacing: .18em; color: #0f172a;
      background: #d97706; padding: 6px 12px 5px; border-radius: 3px; opacity: 0;
      transform: translateX(12px); transition: opacity 200ms, transform 260ms; }
    #replay-ui.on .rbadge { opacity: 1; transform: none; }
    @media (prefers-reduced-motion: reduce) { #replay-ui .rb, #replay-ui .rbadge { transition: none; } }`;
  document.head.appendChild(st);
  const el = document.createElement('div');
  el.id = 'replay-ui';
  el.innerHTML = '<div class="rb top"></div><div class="rb bot"></div><div class="rbadge">REPLAY</div>';
  document.body.appendChild(el);
  return el;
})();
(window as any).__director = director; // debug/verification hook
function setReplayUI(on: boolean) {
  replayUI.classList.toggle('on', on);
}
let refModel: CharModel | null = null;
(window as any).__models = models; // debug/verification hook
(window as any).__ref = () => refModel;
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
// PES night signature: under four corner floodlights every player throws
// four long, faint shadows fanning out from his feet. Cheap decals, updated
// per frame (direction + length follow the player around the pitch).
const radialShadowMat = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const x = c.getContext('2d')!;
  const gy = x.createLinearGradient(0, 256, 0, 0);
  gy.addColorStop(0, 'rgba(0,0,0,0.42)');
  gy.addColorStop(0.55, 'rgba(0,0,0,0.16)');
  gy.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gy;
  x.beginPath();
  x.ellipse(32, 128, 26, 128, 0, 0, Math.PI * 2);
  x.fill();
  return new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false });
})();
const radialShadowGeo = (() => {
  const g = new THREE.PlaneGeometry(0.5, 1);
  g.translate(0, 0.5, 0); // base at the feet, extends along +y
  return g;
})();
function makeRadialShadows(): THREE.Object3D[] {
  return lights.towers.map(() => {
    const holder = new THREE.Object3D();
    const plane = new THREE.Mesh(radialShadowGeo, radialShadowMat);
    plane.rotation.x = -Math.PI / 2; // flat; its +y now runs along holder -z
    plane.renderOrder = -1;
    holder.add(plane);
    scene.add(holder);
    return holder;
  });
}

function placeRadial(m: Model, px: number, pz: number, visible: boolean) {
  if (!m.radial) return;
  for (let k = 0; k < m.radial.length; k++) {
    const t = lights.towers[k];
    const dx = px - t.x, dz = pz - t.z;
    const dist = Math.hypot(dx, dz);
    const h = m.radial[k];
    h.position.set(px, 0.012 + k * 0.001, pz);
    h.rotation.y = Math.atan2(-dx, -dz);
    // shadow length ~ body height x distance / (lamp height - body)
    h.children[0].scale.set(1, Math.min(5, 1.82 * dist / 17), 1);
    h.visible = visible;
  }
}

// soft contact shadow shared by every character: even on 'low' (no shadow
// maps) bodies stay GROUNDED — a figure without a contact patch floats
const blobShadow = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 4, 32, 32, 30);
  g.addColorStop(0, 'rgba(0,0,0,0.34)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const geo = new THREE.CircleGeometry(0.44, 20);
  const mat = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false,
  });
  return () => {
    const m = new THREE.Mesh(geo, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.015;
    m.renderOrder = -1; // under feet, before bodies
    return m;
  };
})();

// shirt numbers: keepers wear 1, outfielders take a realistic squad pool
const SQUAD_NUMBERS = [9, 10, 7, 11, 8, 4, 5, 6, 3, 2, 14, 17];
const nextNumber: Record<'A' | 'B', number> = { A: 0, B: 0 };
const shirtNumber = new Map<string, number>();
function getModel(id: string, name: string, team: 'A' | 'B', keeper = false) {
  let m = models.get(id);
  if (!m) {
    let seed = 0;
    for (let i = 0; i < id.length; i++) seed = (seed * 31 + id.charCodeAt(i)) | 0;
    let num = shirtNumber.get(id);
    if (num === undefined) {
      num = keeper ? 1 : SQUAD_NUMBERS[nextNumber[team]++ % SQUAD_NUMBERS.length];
      shirtNumber.set(id, num);
    }
    const rig = charsReady()
      ? new CharModel(team, seed, keeper, { number: num, name })
      : new HumanRig(team === 'A' ? 0x2563eb : 0xdc2626, seed);
    rig.group.add(blobShadow());
    rigIds.set(rig, id);
    scene.add(rig.group);
    const lb = label(name);
    lb.position.y = 2.15;
    rig.group.add(lb);
    // PES cursor: a floating team-colored arrow over YOUR player
    const cursor = new THREE.Mesh(
      new THREE.ConeGeometry(0.16, 0.3, 3),
      new THREE.MeshBasicMaterial({ color: team === 'A' ? 0x60a5fa : 0xf87171, depthTest: false, transparent: true }),
    );
    cursor.rotation.x = Math.PI; // point down at the player
    cursor.position.y = 2.25;
    cursor.renderOrder = 10;
    cursor.visible = false;
    rig.group.add(cursor);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 24), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    rig.group.add(ring);
    m = { rig, label: lb, ring, ringMat, cursor, radial: tod === 'night' ? makeRadialShadows() : null, prevYaw: 0, yawRate: 0 };
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
      if (m.kind === 'goal') {
        banner(`GOAL!  ${m.score[0]} — ${m.score[1]}`);
        sfx.goal();
        fovPunch = 1; // broadcast lens punch
        // confetti erupts at the goal the ball just crossed
        fx.goalBurst(Math.sign(ballVis.x) * (L / 2 - 0.6), Math.max(-2.5, Math.min(2.5, ballVis.z)));
        // the scoring side's end of the stadium erupts
        stadium.celebrate(m.team === 'A' ? 0 : 1);
        // after the celebration beat, roll the replay (the rendered ball
        // crosses the line one interpolation delay after this event)
        {
          const lastBall = snaps.length ? snaps[snaps.length - 1].s.ball.x : ballVis.x;
          const tNow = performance.now();
          pendingReplay = { at: tNow + 1800, goalAt: tNow + INTERP_MS, side: Math.sign(lastBall) || 1 };
        }
        // the scorer wheels away arms wide; his teammates' arms go up
        const scorer = m.scorer as string | null;
        schedule(scorer === myId ? 0 : INTERP_MS, () => {
          for (const [id, mdl] of models) {
            if (!('triggerAction' in mdl.rig)) continue;
            const rig = mdl.rig as CharModel;
            if (id === scorer) rig.triggerAction('celebrate');
            else if ((lobbyTeams.get(id) ?? (id.startsWith('bot-1') ? 'B' : 'A')) === m.team) rig.triggerArms();
          }
        });
      }
      if (m.kind === 'kickoff') {
        winner = null; banner('KICKOFF', 900); sfx.whistle('kickoff');
        pendingReplay = null;
        if (director.active && !director.hold) endReplay();
      }
      if (m.kind === 'end') { winner = m.winner; sfx.whistle('full'); }
      if (m.kind === 'foul') banner('FOUL!', 1000);
      if (m.kind === 'restart') {
        const names: Record<string, string> = {
          throwin: 'THROW-IN', goalkick: 'GOAL KICK', corner: 'CORNER', penalty: 'PENALTY!',
        };
        banner(names[m.what] ?? 'RESTART', m.what === 'penalty' ? 1800 : 1000);
        if (m.what === 'penalty') sfx.whistle('foul');
        if (m.id === myId) hint('YOU TAKE IT — walk to the ball and PASS / SHOOT / LOB', 2600);
      }
      if (m.kind === 'save') {
        const mdl = models.get(m.id);
        const rig = mdl?.rig as any;
        if (m.how === 'pickup') {
          rig?.triggerPickup?.(); // bends down, gathers into the gloves
        } else if (m.how === 'dive') {
          rig?.triggerDive?.(m.side || 1); // committed dive — maybe beaten
        } else {
          banner('SAVE!', 900);
          if (m.side && rig?.triggerDive) rig.triggerDive(m.side);      // full-stretch
          else if (m.how === 'parry' && rig?.triggerPunch) rig.triggerPunch(); // fists it clear
          else rig?.triggerArms?.();                                    // standing catch
        }
      }
      if (m.kind === 'throw' && m.id) {
        // normally already playing (started on the windup); fallback only
        const mdl = models.get(m.id);
        if (mdl && 'triggerThrow' in mdl.rig && !(mdl.rig as CharModel).acting) (mdl.rig as CharModel).triggerThrow();
      }
      if (m.kind === 'freekick') { banner('FREE KICK', 1400); sfx.whistle('foul'); }
      if (m.kind === 'advantage') banner('ADVANTAGE — PLAY ON', 1200);
      if (m.kind === 'card') {
        banner(`${m.color === 'red' ? 'RED' : 'YELLOW'} CARD — ${m.name ?? ''}`, 1800);
        refModel?.showCard(m.color === 'red' ? 'red' : 'yellow');
        sfx.card();
      }
      if (m.kind === 'windup' && m.id && m.id !== myId) {
        // remote backswing: start it when his RENDERED body gets there
        const id = m.id, what = m.what;
        schedule(INTERP_MS, () => startTechnique(id, what));
      }
      if (m.kind === 'tackle' && m.id && m.id !== myId) {
        const id = m.id;
        schedule(INTERP_MS, () => {
          const mdl = models.get(id);
          if (mdl && 'triggerAction' in mdl.rig) (mdl.rig as CharModel).triggerAction('tackle');
        });
      }
      if (m.kind === 'kick' && m.id) {
        // CONTACT: effects land with the rendered ball (remote = delayed);
        // the swing itself was started by the windup — only fall back to a
        // strike animation if that got missed
        const id = m.id, tech = m.tech;
        const land = () => {
          const mdl = models.get(id);
          if (mdl) {
            const rig = mdl.rig as any;
            if (rig.acting === false) {
              if (tech === 'header') rig.triggerHeader?.();
              else rig.triggerKick?.(tech === 'volley' ? 1.5 : 1);
            }
            if (tech !== 'header' && tech !== 'volley') {
              const p = mdl.rig.group.position;
              fx.kickPuff(p.x, p.z); // turf chips only for grounded strikes
            }
          }
          sfx.kick(tech === 'header' ? 0.35 : 0.65);
        };
        if (id === myId) land(); else schedule(INTERP_MS, land);
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
    ref: b.s.ref
      ? {
          x: lerp(a.s.ref?.x ?? b.s.ref.x, b.s.ref.x),
          z: lerp(a.s.ref?.z ?? b.s.ref.z, b.s.ref.z),
          yaw: la(a.s.ref?.yaw ?? b.s.ref.yaw, b.s.ref.yaw),
          speed: b.s.ref.speed ?? 0,
        }
      : null,
  };
}

// bots get squad-style surnames on their shirts and tags (fictional)
const SURNAMES = [
  'MORETTI', 'OKAFOR', 'LINDQVIST', 'NAKAMURA', 'OSEI', 'PETROV', 'QUINTERO', 'RAHMAN',
  'VARGA', 'WEBER', 'YILMAZ', 'ZIELINSKI', 'ADEBAYO', 'DUBOIS', 'EKSTROM', 'FARIA',
  'GALLO', 'HALVORSEN', 'IBARRA', 'JANSEN', 'KOVAC', 'LAURENT', 'MENSAH', 'NOVAK',
];
const botNames = new Map<string, string>();
const usedNames = new Set<string>();
function botName(id: string) {
  const known = botNames.get(id);
  if (known) return known;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 131 + id.charCodeAt(i)) >>> 0;
  // probe for an unused surname: no two players share a shirt name
  let k = h % SURNAMES.length;
  for (let n = 0; n < SURNAMES.length && usedNames.has(SURNAMES[k]); n++) k = (k + 1) % SURNAMES.length;
  const name = SURNAMES[k];
  usedNames.add(name);
  botNames.set(id, name);
  return name;
}

// debug/verification: slow-motion for the character layer (?anim=0.1 or
// window.__animScale = 0.1) — lets a strike be inspected frame by frame
let animScale = Number(new URLSearchParams(location.search).get('anim') ?? 1) || 1;
(window as any).__setAnimScale = (v: number) => { animScale = v; };

// remote animation triggers are delayed by the interpolation buffer, so a
// remote player's swing lands exactly when his RENDERED body reaches the ball
const animQueue: { at: number; fn: () => void }[] = [];
function schedule(delayMs: number, fn: () => void) {
  animQueue.push({ at: performance.now() + delayMs, fn });
}
/** which technique a strike should play, by the ball's height at contact */
function techniqueFor(kind: string, ballY: number) {
  if (ballY > 1.35) return 'header';
  if (ballY > 0.6) return 'volley';
  return kind === 'shoot' ? 'shot' : kind;
}
function startTechnique(id: string, kind: string) {
  const mdl = models.get(id);
  if (!mdl || !('triggerAction' in mdl.rig)) return;
  const p = mdl.rig.group.position;
  const rig = mdl.rig as CharModel;
  // a throw-in taker's "kick" is the two-handed throw from over his head
  if (rig.throwReady) { rig.triggerAction('throw'); return; }
  // a swing at thin air 10m from the ball looks silly: only near the ball
  if (Math.hypot(ballVis.x - p.x, ballVis.z - p.z) > 2.6) return;
  rig.triggerAction(techniqueFor(kind, ballVis.y));
}

// ---------------- main loop ----------------
const teamOf = new Map<string, 'A' | 'B'>();
let lastFrame = performance.now();
let acc = 0;

let replayPhase = -1;
const replayCam = new THREE.Vector3();
const replayLook = new THREE.Vector3();
function endReplay() {
  director.active = false;
  setReplayUI(false);
  camera.fov = BASE_FOV;
  camera.updateProjectionMatrix();
  for (const m of models.values()) m.rig.group.visible = true;
}
function renderReplay(dt: number) {
  const [t0, t1] = director.advance(dt * 1000);
  const f = recorder.sample(t1);
  if (!f) { director.active = false; return; }
  const slowDt = dt * director.speed;
  // re-perform the techniques that were played in this slice of time
  for (const a of recorder.actionsBetween(t0, t1)) {
    const m = models.get(a.id);
    if (!m || !('triggerAction' in m.rig)) continue;
    const rig = m.rig as CharModel;
    if (a.kind === 'dive') rig.triggerDive(a.arg ?? 1);
    else if (a.kind === 'pickup') rig.triggerPickup();
    else if (a.kind === 'punch') rig.triggerPunch();
    else if (a.kind === 'arms') rig.triggerArms();
    else rig.triggerAction(a.kind);
  }
  const inFrame = new Set<string>();
  for (const b of f.bodies) {
    const m = models.get(b.id);
    if (!m) continue;
    inFrame.add(b.id);
    m.rig.group.visible = true;
    m.rig.group.position.set(b.x, 0, b.z);
    m.rig.group.rotation.y = -b.yaw;
    let dy = b.yaw - m.prevYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    m.yawRate += ((slowDt > 0 ? dy / slowDt : 0) - m.yawRate) * (1 - Math.exp(-12 * dt));
    m.prevYaw = b.yaw;
    m.label.visible = false;
    m.cursor.visible = false;
    m.ringMat.opacity = 0;
    placeRadial(m, b.x, b.z, true);
    m.rig.update(slowDt, {
      speed: b.spd, stamina: 1, yawRate: m.yawRate, shield: b.shield, sliding: b.sliding,
      stunned: b.stunned, holding: b.holding, hasBall: b.hasBall,
      ready: b.keeper && !b.holding && Math.hypot(f.bx - b.x, f.bz - b.z) < 11,
      lookYaw: Math.atan2(f.bz - b.z, f.bx - b.x), bodyYaw: b.yaw,
    } as any);
  }
  for (const [id, m] of models) if (!inFrame.has(id)) m.rig.group.visible = false;
  // ball: recorded position, rolled by its recorded motion
  const dxb = f.bx - ballVis.x, dzb = f.bz - ballVis.z;
  const travel = Math.hypot(dxb, dzb);
  ballVis.set(f.bx, f.by, f.bz);
  ballMesh.position.copy(ballVis);
  if (travel > 1e-4 && travel < 2) {
    ballMesh.rotateOnWorldAxis(new THREE.Vector3(dzb / travel, 0, -dxb / travel), -travel / BALL.radius);
  }
  ballShadow.position.set(f.bx, 0.02, f.bz);
  ballShadow.scale.setScalar(Math.max(0.3, 1 - (f.by - BALL.radius) / 8));
  if (f.ref && refModel) {
    refModel.group.position.set(f.ref.x, 0, f.ref.z);
    refModel.group.rotation.y = -f.ref.yaw;
    refModel.update(slowDt, { speed: f.ref.spd, stamina: 1, yawRate: 0, lookYaw: Math.atan2(f.bz - f.ref.z, f.bx - f.ref.x), bodyYaw: f.ref.yaw });
  }
  nets.update(slowDt, ballVis, BALL.radius);
  fx.update(slowDt, f.bx, f.by, f.bz, slowDt > 0 ? travel / slowDt : 0);
  stadium.update(dt, 1);

  // two TV angles: a low tracking shot beside the play, then the reverse
  // from behind the net as it bulges (hard cut between them, like TV)
  const side = director.goalSide;
  const phase = director.progress < 0.58 ? 0 : 1;
  let cut = false;
  if (phase !== replayPhase) { replayPhase = phase; cut = true; }
  if (phase === 0) {
    // higher and further back than a sideline photographer: nobody walks
    // through the lens, the run and the finish both stay in frame
    replayCam.set(f.bx - side * 7.5, 2.7, Math.min(W / 2 + 3.6, f.bz + 9.5));
    replayLook.set(f.bx + side * 1.2, 0.7, f.bz);
    camera.fov = 34;
  } else {
    replayCam.set(side * (L / 2 + 3.6), 1.5, Math.max(-1.3, Math.min(1.3, f.bz * 0.35)));
    replayLook.set(f.bx - side * 1.6, 0.9, f.bz * 0.8);
    camera.fov = 46;
  }
  if (cut) camera.position.copy(replayCam);
  else camera.position.lerp(replayCam, 1 - Math.exp(-5 * dt));
  camera.lookAt(replayLook);
  camera.updateProjectionMatrix();
}

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

  // GOAL REPLAY: after the celebration beat, the director takes over the
  // render until the replay ends or the kickoff whistle goes
  if (pendingReplay && now >= pendingReplay.at) {
    director.begin(pendingReplay.goalAt, pendingReplay.side);
    pendingReplay = null;
    replayPhase = -1;
    setReplayUI(true);
  }
  if (director.active) {
    renderReplay(dtReal);
    if (!director.active) endReplay();
    draw(dtReal);
    requestAnimationFrame(frame);
    return;
  }

  const view = sample();
  if (view) {
    // ---- ball rendering: predicted carry vs interpolated truth ----
    // detect kick releases: the instant you strike, stop gluing — the interp
    // stream will show the ball leaving (windup animation covers the delay)
    const actNow = readInput();
    const acts = { pass: actNow.pass, through: actNow.through, shoot: actNow.shoot, lob: actNow.lob } as any;
    for (const k of Object.keys(prevActs) as (keyof typeof prevActs)[]) {
      if (prevActs[k] && !acts[k]) {
        kickReleasedAt = now;
        // predicted: MY swing starts on release, in step with my sim's
        // contact frame (no round trip)
        if (myId && playing) startTechnique(myId, k);
      }
      prevActs[k] = !!acts[k];
    }
    if (actNow.tackle && !prevTackleKey && myId && playing) {
      const mdl = models.get(myId);
      if (mdl && 'triggerAction' in mdl.rig && Math.hypot(ballVis.x - myVisX, ballVis.z - myVisZ) < 1.8) {
        (mdl.rig as CharModel).triggerAction('tackle');
      }
    }
    prevTackleKey = !!actNow.tackle;
    // run due remote animation triggers
    for (let i = animQueue.length - 1; i >= 0; i--) {
      if (animQueue[i].at <= now) { animQueue[i].fn(); animQueue.splice(i, 1); }
    }
    const meHolding = !!view.latest.players.find((p) => p.id === myId)?.holding;
    const iCarry =
      serverOwnerId !== null &&
      serverOwnerId === myId &&
      localMe !== null &&
      now - kickReleasedAt > 600 &&
      phase === 'playing' &&
      !meHolding; // ball in my (keeper) hands renders at the chest, not the feet
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

    // match FX (trail follows the RENDERED ball) + crowd bed — the stands
    // lean in as play reaches either end
    const bSpd = Math.hypot(view.latest.ball.vx, view.latest.ball.vy, view.latest.ball.vz);
    fx.update(dtReal, ballVis.x, ballVis.y, ballVis.z, bSpd);
    nets.update(dtReal, ballVis, BALL.radius);
    const crowdWant = 0.3 + 0.45 * Math.min(1, Math.abs(ballVis.x) / (L / 2));
    stadium.update(dtReal, crowdWant);
    if (Math.abs(crowdWant - crowdSent) > 0.04) {
      sfx.setCrowd(crowdWant);
      crowdSent = crowdWant;
    }

    // players — bots encode their team in the id (bot-0-*, bot-1-*);
    // humans come from the cached lobby roster
    const seen = new Set<string>();
    const bodies: { m: Model; x: number; z: number; yaw: number; spd: number }[] = [];
    const recRows: RBody[] = [];
    for (const p of view.players) {
      seen.add(p.id);
      const isMe = p.id === myId;
      const team: 'A' | 'B' = p.id.startsWith('bot-1') ? 'B' : p.id.startsWith('bot-0') ? 'A' : (lobbyTeams.get(p.id) ?? (isMe ? myTeam : 'A'));
      const name = isMe
        ? (nameInput.value.trim() || 'You')
        : (lobbyNames.get(p.id) ?? (p.id.startsWith('bot-') ? botName(p.id) : p.id));
      const m = getModel(p.id, name, team, !!p.keeper);
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
      // yaw rate from the RENDERED heading: remote players lean into turns
      // too (they used to be hard-coded upright)
      {
        let dy = pyaw - m.prevYaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        const yr = dtReal > 0 ? dy / dtReal : 0;
        m.yawRate += (yr - m.yawRate) * (1 - Math.exp(-12 * dtReal));
        m.prevYaw = pyaw;
      }
      placeRadial(m, px, pz, !(camMode === 2 && isMe));
      m.rig.extraPitch = p.sliding ? -1.15 : p.stunned ? 0.35 : 0;
      // own name tag hides in the chase/first-person cams (it floats right
      // in front of the lens); everyone else's stays
      // PES presentation: AI players carry no floating names; humans do;
      // YOUR player gets the team cursor instead of a name tag
      m.label.visible = !isMe && !p.id.startsWith('bot-');
      m.cursor.visible = isMe && camMode !== 2;
      if (m.cursor.visible) m.cursor.position.y = 2.25 + Math.sin(now / 180) * 0.05;
      m.rig.update(dtReal * animScale, {
        speed: spd,
        yawRate: isMe && localMe ? localMe.yawRate : m.yawRate,
        stamina: p.stamina,
        shield: p.shielding,
        sliding: p.sliding,
        stunned: p.stunned,
        holding: p.holding,
        ready: !!p.keeper && !p.holding && Math.hypot(ballVis.x - px, ballVis.z - pz) < 11,
        hasBall: view.latest.owner === p.id && !p.holding,
        throwHold: view.latest.restart?.kind === 'throwin' && view.latest.restart.taker === p.id,
        lookYaw: Math.atan2(ballVis.z - pz, ballVis.x - px),
        bodyYaw: pyaw,
      } as any);
      const charge = isMe ? Math.min(1, shootHeldLocal / 900) : p.charge;
      m.ringMat.opacity = charge > 0.02 ? 0.35 + 0.6 * charge : 0;
      m.ringMat.color.setHSL(0.15 - 0.15 * charge, 1, 0.55);
      m.rig.group.visible = !(camMode === 2 && isMe);
      bodies.push({ m, x: px, z: pz, yaw: pyaw, spd });
      recRows.push({
        id: p.id, x: px, z: pz, yaw: pyaw, spd,
        sliding: p.sliding, stunned: p.stunned, holding: !!p.holding, shield: p.shielding,
        keeper: !!p.keeper, hasBall: view.latest.owner === p.id && !p.holding,
      });
    }
    if (recorder.wants(now)) {
      recorder.push({
        t: now, bx: ballVis.x, by: ballVis.y, bz: ballVis.z, bodies: recRows,
        ref: view.ref ? { x: view.ref.x, z: view.ref.z, yaw: view.ref.yaw, spd: view.ref.speed } : null,
      });
    }
    // JOSTLE: bodies that meet at pace react — each leans away from the
    // contact with an arm out (the shoulder-to-shoulder of every duel)
    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) {
        const a = bodies[i], b = bodies[j];
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.78 || d < 1e-3 || a.spd + b.spd < 2.2) continue;
        const k = Math.min(1, (a.spd + b.spd) / 9);
        // which side of each player is the other on? (+ = his right)
        const side = (yaw: number, tx: number, tz: number) => Math.sign(-Math.sin(yaw) * tx + Math.cos(yaw) * tz) || 1;
        if ('bump' in a.m.rig) (a.m.rig as CharModel).bump(-side(a.yaw, dx, dz), k);
        if ('bump' in b.m.rig) (b.m.rig as CharModel).bump(-side(b.yaw, -dx, -dz), k);
      }
    }
    for (const [id, m] of models) {
      if (!seen.has(id)) {
        scene.remove(m.rig.group);
        m.radial?.forEach((h) => scene.remove(h));
        models.delete(id);
      }
    }

    // the referee — all-black official shadowing play (no label, no ring)
    if (view.ref && charsReady()) {
      if (!refModel) {
        refModel = new CharModel('REF', 7);
        refModel.group.add(blobShadow());
        scene.add(refModel.group);
      }
      refModel.group.position.set(view.ref.x, 0, view.ref.z);
      refModel.group.rotation.y = -view.ref.yaw;
      refModel.update(dtReal, {
        speed: view.ref.speed,
        stamina: 1,
        yawRate: 0,
        lookYaw: Math.atan2(ballVis.z - view.ref.z, ballVis.x - view.ref.x),
        bodyYaw: view.ref.yaw,
      });
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
    if (calibMode) { draw(dtReal); requestAnimationFrame(frame); return; }
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

  // goal-moment lens punch (broadcast zoom kick), then settle back
  if (fovPunch > 0.005) {
    fovPunch *= Math.exp(-2.0 * dtReal);
    camera.fov = BASE_FOV + 7 * Math.sin(fovPunch * Math.PI);
    camera.updateProjectionMatrix();
  } else if (camera.fov !== BASE_FOV) {
    camera.fov = BASE_FOV;
    camera.updateProjectionMatrix();
  }

  draw(dtReal);
  requestAnimationFrame(frame);
}
function draw(dt: number) {
  if (composer) composer.render(dt);
  else renderer.render(scene, camera);
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
  composer?.setSize(innerWidth, innerHeight);
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
