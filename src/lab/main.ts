// ============================================================
// M1 PHYSICS LAB — one ball, real units, real aero.
// Purpose: prove the ball "feels like a football" before anything else.
// Rapier owns rigid-body integration + collisions; we add the two forces
// Rapier doesn't know about — quadratic air drag and Magnus lift — every
// fixed step, exactly as the server will.
// ============================================================
import * as THREE from 'three';
import { OrbitControls } from 'three-stdlib';
import RAPIER from '@dimforge/rapier3d-compat';
import { Pane } from 'tweakpane';
import Stats from 'stats.js';
import { BALL, MATCH, PITCH_5S } from '../shared/config3d';
import { SimPlayer, defaultMoveTune } from '../shared/sim3d/player';
import { defaultControlTune, stepBallControl, type ControlState } from '../shared/sim3d/control';
import { HumanRig } from './rig';

// live-tunable copy of the aero/ball constants (Tweakpane writes here)
const TUNE = {
  dragCd: BALL.dragCd,
  magnusK: BALL.magnusK,
  restitution: BALL.restitution,
  spinDecay: BALL.spinDecay,
  rollFriction: BALL.rollFriction,
  rollSkid: BALL.rollSkid,
  airDensity: BALL.airDensity,
};

const AREA = Math.PI * BALL.radius * BALL.radius; // cross-section, m^2
const DT = 1 / MATCH.labTickRate;

async function boot() {
  await RAPIER.init();

  // ---------- physics world ----------
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.timestep = DT;

  // ground: static half-space at y=0 with grass-ish friction
  const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(200, 0.5, 200).setTranslation(0, -0.5, 0).setFriction(0.8),
    groundBody,
  );

  // goal frame (posts + crossbar) at +x end — real 3m x 2m, 8cm tubes
  const postR = 0.04;
  const gx = PITCH_5S.length / 2;
  const mkPost = (x: number, y: number, z: number, h: number, alongZ = false) => {
    const b = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const desc = RAPIER.ColliderDesc.capsule(h / 2 - postR, postR).setRestitution(0.72);
    if (alongZ) desc.setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });
    world.createCollider(desc, b);
  };
  mkPost(gx, PITCH_5S.goalHeight / 2, -PITCH_5S.goalWidth / 2, PITCH_5S.goalHeight);
  mkPost(gx, PITCH_5S.goalHeight / 2, PITCH_5S.goalWidth / 2, PITCH_5S.goalHeight);
  mkPost(gx, PITCH_5S.goalHeight, 0, PITCH_5S.goalWidth, true); // crossbar

  // M2: CONTROLLED player — kinematic capsule with momentum/turn-radius/
  // stamina (isomorphic sim code) driven by WASD+Shift
  const player = new SimPlayer(RAPIER, world, -12, 4);
  const moveTune = defaultMoveTune();

  // M3: ball control state + a static dummy defender to shield against
  const controlTune = defaultControlTune();
  const ctlStates: ControlState[] = [{ cooldown: 0 }];
  const labPoss = { owner: -1, ownerSince: 0 };
  let tick = 0;
  // (positioned OFF the +x feed lane so serves reach the player untouched)
  const dummyBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(-10.5, 1.82 / 2, 7));
  world.createCollider(RAPIER.ColliderDesc.capsule((1.82 - 0.6) / 2, 0.3), dummyBody);

  // the ball
  const ballBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic().setTranslation(-8, BALL.radius, 0).setCcdEnabled(true),
  );
  const ballCol = world.createCollider(
    RAPIER.ColliderDesc.ball(BALL.radius)
      .setMass(BALL.mass)
      .setRestitution(TUNE.restitution)
      .setFriction(BALL.friction),
    ballBody,
  );

  // ---------- three scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87c8ee);
  scene.fog = new THREE.Fog(0x87c8ee, 80, 260);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 500);
  camera.position.set(-14, 6, 12);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xe8f4ff, 0x2f6b38, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
  sun.position.set(-20, 30, 14);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 5, far: 90 });
  scene.add(sun);

  // pitch visual: 40x20 with meter-accurate markings
  const texC = document.createElement('canvas');
  texC.width = 1024; texC.height = 512;
  const tx = texC.getContext('2d')!;
  tx.fillStyle = '#2f9e44'; tx.fillRect(0, 0, 1024, 512);
  tx.fillStyle = 'rgba(255,255,255,0.05)';
  for (let i = 0; i < 8; i += 2) tx.fillRect(i * 128, 0, 128, 512);
  tx.strokeStyle = '#fff'; tx.lineWidth = 3;
  tx.strokeRect(2, 2, 1020, 508);
  tx.beginPath(); tx.moveTo(512, 0); tx.lineTo(512, 512); tx.stroke();
  tx.beginPath(); tx.arc(512, 256, 77, 0, Math.PI * 2); tx.stroke(); // 3m circle
  const ptex = new THREE.CanvasTexture(texC);
  ptex.colorSpace = THREE.SRGBColorSpace;
  const pitch = new THREE.Mesh(
    new THREE.PlaneGeometry(PITCH_5S.length, PITCH_5S.width),
    new THREE.MeshLambertMaterial({ map: ptex }),
  );
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = true;
  scene.add(pitch);
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshLambertMaterial({ color: 0x26702f }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.01;
  apron.receiveShadow = true;
  scene.add(apron);

  // goal visual
  const postMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.3 });
  const postGeo = (h: number) => new THREE.CylinderGeometry(postR, postR, h, 12);
  const post1 = new THREE.Mesh(postGeo(PITCH_5S.goalHeight), postMat);
  post1.position.set(gx, PITCH_5S.goalHeight / 2, -PITCH_5S.goalWidth / 2);
  const post2 = post1.clone();
  post2.position.z = PITCH_5S.goalWidth / 2;
  const bar = new THREE.Mesh(postGeo(PITCH_5S.goalWidth), postMat);
  bar.rotation.x = Math.PI / 2;
  bar.position.set(gx, PITCH_5S.goalHeight, 0);
  scene.add(post1, post2, bar);

  // player visual: procedural human rig (Mixamo GLBs drop in later)
  const rig = new HumanRig();
  scene.add(rig.group);

  // dummy defender visual (red) — shield against this
  const dummyRig = new HumanRig(0xdc2626);
  dummyRig.group.position.set(-10.5, 0, 7);
  scene.add(dummyRig.group);

  // breadcrumb trail — SEE the turning radius as an arc on the grass
  const TRAIL_N = 240;
  const trailPos = new Float32Array(TRAIL_N * 3);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
  const trail = new THREE.Line(
    trailGeo,
    new THREE.LineBasicMaterial({ color: 0xfacc15, transparent: true, opacity: 0.8 }),
  );
  trail.frustumCulled = false;
  scene.add(trail);
  let trailIdx = 0;
  let trailTimer = 0;

  // WASD + Shift input (world axes: W = +x toward the goal)
  const keys = new Set<string>();
  addEventListener('keydown', (e) => keys.add(e.code));
  addEventListener('keyup', (e) => keys.delete(e.code));
  function readInput() {
    let x = 0, z = 0;
    if (keys.has('KeyW')) x += 1;
    if (keys.has('KeyS')) x -= 1;
    if (keys.has('KeyD')) z += 1;
    if (keys.has('KeyA')) z -= 1;
    return {
      x, z,
      sprint: keys.has('ShiftLeft') || keys.has('ShiftRight'),
      shield: keys.has('KeyE'),
    };
  }

  const camState = { follow: true };

  // ball visual
  const ballTexC = document.createElement('canvas');
  ballTexC.width = 128; ballTexC.height = 64;
  const btx = ballTexC.getContext('2d')!;
  btx.fillStyle = '#fafafa'; btx.fillRect(0, 0, 128, 64);
  btx.fillStyle = '#111827';
  for (let i = 0; i < 10; i++) {
    btx.beginPath();
    btx.arc((i % 5) * 26 + (i > 4 ? 13 : 6), Math.floor(i / 5) * 32 + 14, 6, 0, Math.PI * 2);
    btx.fill();
  }
  const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL.radius, 24, 18),
    new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(ballTexC), roughness: 0.35 }),
  );
  ballMesh.castShadow = true;
  scene.add(ballMesh);

  // ---------- aero forces (the M1 heart) ----------
  // Drag:   F = -1/2 * rho * Cd * A * |v| * v      (quadratic, opposes motion)
  // Magnus: F = k * (omega x v)                     (spin bends the path)
  // Both applied as world-space forces before each step. Spin decays
  // exponentially in flight; rolling contact re-derives spin from travel.
  function applyAero() {
    const v = ballBody.linvel();
    const w = ballBody.angvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    ballBody.resetForces(true);
    if (speed > 0.05) {
      const dragMag = 0.5 * TUNE.airDensity * TUNE.dragCd * AREA * speed;
      const fx = -dragMag * v.x + TUNE.magnusK * (w.y * v.z - w.z * v.y);
      const fy = -dragMag * v.y + TUNE.magnusK * (w.z * v.x - w.x * v.z);
      const fz = -dragMag * v.z + TUNE.magnusK * (w.x * v.y - w.y * v.x);
      ballBody.addForce({ x: fx, y: fy, z: fz }, true);
    }
    // spin decay (air resistance on the spinning surface)
    const dec = Math.exp(-TUNE.spinDecay * DT);
    ballBody.setAngvel({ x: w.x * dec, y: w.y * dec, z: w.z * dec }, true);

    // rolling on the ground: extra grass friction + settle
    const pos = ballBody.translation();
    if (pos.y < BALL.radius + 0.01 && Math.abs(v.y) < 0.5) {
      const hs = Math.hypot(v.x, v.z);
      if (hs > 0.03) {
        // base rolling resistance + speed-proportional skid (hard balls
        // skid before they roll, shedding pace much faster)
        const decel = TUNE.rollFriction + TUNE.rollSkid * hs;
        const dec2 = Math.max(0, hs - decel * DT) / hs;
        ballBody.setLinvel({ x: v.x * dec2, y: v.y, z: v.z * dec2 }, true);
      } else {
        ballBody.setLinvel({ x: 0, y: v.y, z: 0 }, true);
      }
    }
  }

  // ---------- kick + telemetry ----------
  interface ShotLog {
    label: string;
    launch: number;
    carry?: number;   // distance to first bounce
    peak: number;
    curl: number;     // lateral deviation from launch line at landing
    total?: number;
  }
  let shot: ShotLog | null = null;
  let shotOrigin = new THREE.Vector3();
  let shotDir = new THREE.Vector3(1, 0, 0);
  let bounced = false;
  const shotsUl = document.getElementById('shots')!;
  const liveEl = document.getElementById('live')!;
  (window as any).__shots = [];

  function kick(label: string, speed: number, loftDeg: number, sideSpin = 0, topSpin = 0, dir?: THREE.Vector3) {
    const p = ballBody.translation();
    shotOrigin.set(p.x, 0, p.z);
    const d = (dir ?? new THREE.Vector3(1, 0, 0)).clone().setY(0).normalize();
    shotDir.copy(d);
    const loft = (loftDeg * Math.PI) / 180;
    const vy = speed * Math.sin(loft);
    const vh = speed * Math.cos(loft);
    ballBody.setLinvel({ x: d.x * vh, y: vy, z: d.z * vh }, true);
    // sidespin = spin around the vertical axis (curls left/right);
    // topspin/backspin = spin around the horizontal axis perpendicular to travel
    const sideAxis = new THREE.Vector3(-d.z, 0, d.x); // right of travel
    const wv = new THREE.Vector3(0, sideSpin * Math.PI * 2, 0).addScaledVector(
      sideAxis,
      topSpin * Math.PI * 2,
    );
    ballBody.setAngvel({ x: wv.x, y: wv.y, z: wv.z }, true);
    shot = { label, launch: speed, peak: 0, curl: 0 };
    bounced = false;
  }

  function resetBall(x = -8, z = 0) {
    ballBody.setTranslation({ x, y: BALL.radius + 0.001, z }, true);
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    shot = null;
  }

  function logShot(s: ShotLog) {
    const li = document.createElement('li');
    li.textContent = `${s.label}: carry ${s.carry?.toFixed(1) ?? '—'}m · total ${s.total?.toFixed(1)}m · peak ${s.peak.toFixed(1)}m · curl ${s.curl.toFixed(2)}m`;
    shotsUl.prepend(li);
    (window as any).__shots.push({ ...s });
  }

  // control telemetry
  let lastCtl = '—';
  (window as any).__ctlEvents = [];

  // presets
  const $ = (id: string) => document.getElementById(id)!;
  $('p-pass').onclick = () => { resetBall(); kick('Ground pass', 14, 0); };
  // M3 feeds: serve the ball AT the player to test first touch
  $('p-feed').onclick = () => {
    const pp = player.pos;
    resetBall(pp.x + 9, pp.z);
    const d = new THREE.Vector3(-1, 0, 0);
    kick('Feed 12', 12, 0, 0, 0, d);
  };
  $('p-feed-hard').onclick = () => {
    const pp = player.pos;
    resetBall(pp.x + 12, pp.z);
    kick('Feed 20', 20, 2, 0, 0, new THREE.Vector3(-1, 0, 0));
  };
  $('p-driven').onclick = () => { resetBall(); kick('Driven', 22, 4); };
  $('p-lofted').onclick = () => { resetBall(); kick('Lofted+back', 19, 26, 0, -5); };
  $('p-curler').onclick = () => { resetBall(); kick('Curler', 24, 12, 7, 0); };
  $('p-drop').onclick = () => {
    resetBall(0, 0);
    ballBody.setTranslation({ x: 0, y: 3, z: 0 }, true);
    shot = { label: 'Drop 3m', launch: 0, peak: 3, curl: 0 };
    bounced = false;
  };
  $('p-reset').onclick = () => resetBall();

  // click-to-kick: raycast the ground, kick toward that point
  const ray = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.shiftKey) return; // orbit uses drag; plain click kicks
    ray.setFromCamera(
      new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1),
      camera,
    );
    const hit = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) {
      const p = ballBody.translation();
      const d = hit.clone().sub(new THREE.Vector3(p.x, 0, p.z));
      if (d.length() < 0.5) return;
      kick('Click kick', 18, 8, 0, 0, d);
    }
  });

  // ---------- tweakpane: EVERY feel constant live ----------
  // tweakpane v4 runtime has addBinding; its bundled d.ts lags — cast once
  const pane = new Pane({ title: 'Ball feel (live)' }) as any;
  pane.addBinding(TUNE, 'dragCd', { min: 0, max: 0.6, step: 0.01 });
  pane.addBinding(TUNE, 'magnusK', { min: 0, max: 0.003, step: 0.0001 });
  pane.addBinding(TUNE, 'restitution', { min: 0.3, max: 1, step: 0.02 }).on('change', () => {
    ballCol.setRestitution(TUNE.restitution);
  });
  pane.addBinding(TUNE, 'spinDecay', { min: 0, max: 0.6, step: 0.02 });
  pane.addBinding(TUNE, 'rollFriction', { min: 0, max: 4, step: 0.05 });
  pane.addBinding(TUNE, 'rollSkid', { min: 0, max: 0.5, step: 0.01 });

  const moveFolder = pane.addFolder({ title: 'Movement feel (live)' });
  moveFolder.addBinding(moveTune, 'sprintSpeed', { min: 5, max: 11, step: 0.1 });
  moveFolder.addBinding(moveTune, 'jogSpeed', { min: 2, max: 6, step: 0.1 });
  moveFolder.addBinding(moveTune, 'accel', { min: 2, max: 10, step: 0.1 });
  moveFolder.addBinding(moveTune, 'decel', { min: 3, max: 14, step: 0.1 });
  moveFolder.addBinding(moveTune, 'turnRateWalk', { min: 4, max: 20, step: 0.5 });
  moveFolder.addBinding(moveTune, 'turnRateSprint', { min: 0.8, max: 6, step: 0.1 });
  moveFolder.addBinding(moveTune, 'staminaDrainSprint', { min: 0, max: 0.3, step: 0.005 });
  moveFolder.addBinding(camState, 'follow', { label: 'follow cam' });

  const ctlFolder = pane.addFolder({ title: 'Ball control feel (live)' });
  ctlFolder.addBinding(controlTune, 'dribbleTouchSpeed', { min: 1.0, max: 1.6, step: 0.01 });
  ctlFolder.addBinding(controlTune, 'sprintTouchSpeed', { min: 1.1, max: 1.9, step: 0.01 });
  ctlFolder.addBinding(controlTune, 'touchCooldown', { min: 0.15, max: 0.6, step: 0.01 });
  ctlFolder.addBinding(controlTune, 'gripSpeed', { min: 2, max: 8, step: 0.1 });
  ctlFolder.addBinding(controlTune, 'trapKill', { min: 0.4, max: 1, step: 0.01 });
  ctlFolder.addBinding(controlTune, 'trapKillMoving', { min: 0.2, max: 0.9, step: 0.01 });
  ctlFolder.addBinding(controlTune, 'trapKillSprint', { min: 0.1, max: 0.7, step: 0.01 });
  ctlFolder.addBinding(controlTune, 'controlRadius', { min: 0.6, max: 1.4, step: 0.02 });

  const stats = new Stats();
  stats.showPanel(0);
  document.body.appendChild(stats.dom);
  stats.dom.style.left = 'auto';
  stats.dom.style.right = '0px';

  // ---------- fixed-step loop with accumulator ----------
  let last = performance.now();
  let acc = 0;
  function frame() {
    stats.begin();
    const now = performance.now();
    acc += Math.min(0.25, (now - last) / 1000);
    last = now;

    while (acc >= DT) {
      acc -= DT;
      tick++;
      const inp = readInput();
      player.step(DT, inp, moveTune);
      const ctlEvents = stepBallControl(
        DT, tick, ballBody, [player], ctlStates, [!!inp.shield], labPoss, controlTune,
      );
      {
        // control debug: min ball distance + cooldown state, sampled per tick
        const _b = ballBody.translation();
        const _p = player.pos;
        const _d = Math.hypot(_b.x - _p.x, _b.z - _p.z);
        const dbg = ((window as any).__ctlDbg ??= { minDist: 99, cooldown: 0, bandTicks: 0 });
        dbg.minDist = Math.min(dbg.minDist, _d);
        dbg.cooldown = ctlStates[0].cooldown;
        if (_d < controlTune.controlRadius) dbg.bandTicks++;
      }
      for (const ev of ctlEvents) {
        lastCtl = `${ev.type} @ ${ev.intensity.toFixed(1)} m/s`;
        (window as any).__ctlEvents.push({ ...ev, tick });
      }
      applyAero();
      world.step();

      // telemetry
      if (shot) {
        const p = ballBody.translation();
        const v = ballBody.linvel();
        shot.peak = Math.max(shot.peak, p.y - BALL.radius);
        if (!bounced && p.y <= BALL.radius + 0.02 && v.y <= 0 && shot.peak > 0.05) {
          bounced = true;
          const flat = new THREE.Vector3(p.x, 0, p.z).sub(shotOrigin);
          shot.carry = flat.length();
          shot.curl = Math.abs(flat.dot(new THREE.Vector3(-shotDir.z, 0, shotDir.x)));
        }
        const hs = Math.hypot(v.x, v.y, v.z);
        if (hs < 0.15 && p.y <= BALL.radius + 0.02) {
          const flat = new THREE.Vector3(p.x, 0, p.z).sub(shotOrigin);
          shot.total = flat.length();
          if (shot.curl === 0) shot.curl = Math.abs(flat.dot(new THREE.Vector3(-shotDir.z, 0, shotDir.x)));
          logShot(shot);
          shot = null;
        }
      }
    }

    // sync visuals
    const bp = ballBody.translation();
    const br = ballBody.rotation();
    ballMesh.position.set(bp.x, bp.y, bp.z);
    ballMesh.quaternion.set(br.x, br.y, br.z, br.w);

    // player rig + trail + telemetry
    const pp = player.pos;
    rig.group.position.set(pp.x, 0, pp.z);
    rig.group.rotation.y = -player.yaw;
    rig.update(Math.min(0.05, (now - last) / 1000 + DT), {
      speed: player.speed,
      yawRate: player.yawRate,
      stamina: player.stamina,
      shield: keys.has('KeyE'),
    });
    dummyRig.update(DT, { speed: 0, yawRate: 0, stamina: 1 });
    trailTimer += DT;
    if (trailTimer > 0.05) {
      trailTimer = 0;
      trailPos[trailIdx * 3] = pp.x;
      trailPos[trailIdx * 3 + 1] = 0.03;
      trailPos[trailIdx * 3 + 2] = pp.z;
      trailIdx = (trailIdx + 1) % TRAIL_N;
      trailGeo.attributes.position.needsUpdate = true;
    }
    (window as any).__move = {
      x: pp.x,
      z: pp.z,
      speed: player.speed,
      stamina: player.stamina,
      yawRate: player.yawRate,
      sep: Math.hypot(bp.x - pp.x, bp.z - pp.z), // ball-player separation
      ballSpeed: Math.hypot(ballBody.linvel().x, ballBody.linvel().z),
    };

    // camera: follow behind travel dir, or free orbit
    if (camState.follow) {
      const back = player.speed > 0.5 ? Math.atan2(player.velZ, player.velX) : player.yaw;
      const tx = pp.x - Math.cos(back) * 7;
      const tz = pp.z - Math.sin(back) * 7;
      camera.position.lerp(new THREE.Vector3(tx, 3.6, tz), 0.06);
      camera.lookAt(pp.x + Math.cos(back) * 4, 0.8, pp.z + Math.sin(back) * 4);
    } else {
      controls.update();
    }

    const v = ballBody.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    liveEl.textContent =
      `ball ${speed.toFixed(1)} m/s · sep ${(window as any).__move.sep.toFixed(2)}m — ` +
      `player ${player.speed.toFixed(1)} m/s · stam ${(player.stamina * 100).toFixed(0)}% · last: ${lastCtl}`;

    renderer.render(scene, camera);
    stats.end();
    requestAnimationFrame(frame);
  }

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  frame();
}

boot();
