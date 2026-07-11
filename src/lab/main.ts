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

  // reference player: static 1.82m capsule at midfield edge (scale check +
  // something to bounce a driven ball off)
  const refBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(4, 1.82 / 2, 2),
  );
  world.createCollider(RAPIER.ColliderDesc.capsule(1.82 / 2 - 0.3, 0.3).setRestitution(0.3), refBody);

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

  // reference player visual (1.82m capsule) — human scale anchor
  const refMesh = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.3, 1.82 - 0.6, 6, 12),
    new THREE.MeshStandardMaterial({ color: 0x2563eb, roughness: 0.7 }),
  );
  refMesh.position.set(4, 1.82 / 2, 2);
  refMesh.castShadow = true;
  scene.add(refMesh);

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

  // presets
  const $ = (id: string) => document.getElementById(id)!;
  $('p-pass').onclick = () => { resetBall(); kick('Ground pass', 14, 0); };
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

    const v = ballBody.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    liveEl.textContent = `ball ${speed.toFixed(1)} m/s (${(speed * 3.6).toFixed(0)} km/h) · h ${(bp.y - BALL.radius).toFixed(2)}m`;

    controls.update();
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
