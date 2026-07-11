// 3D presentation layer. The server still simulates in 2D world units
// (x right, y down, ball z = height); this module maps that into a three.js
// stadium: three (x, y=up, z) = world (x, height, y).
import * as THREE from 'three';
import { CONFIG as C } from '../shared/config';
import type { PlayerSnap, Team } from '../shared/protocol';

const TEAM_COLOR: Record<Team, number> = { A: 0x2563eb, B: 0xdc2626 };
const SHORTS_COLOR: Record<Team, number> = { A: 0x172d63, B: 0x5f1414 };
const SOCK_COLOR: Record<Team, number> = { A: 0x2563eb, B: 0xdc2626 };
const SKIN_TONES = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xba8a63];
const HAIR_TONES = [0x201a16, 0x3b2a1a, 0x101010, 0x5b3b1a, 0x6e6e6e, 0x2e2018];

export type CamMode = 'broadcast' | 'third' | 'first' | 'overhead';
export const CAM_MODES: { id: CamMode; label: string }[] = [
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'third', label: 'Third person' },
  { id: 'first', label: 'First person' },
  { id: 'overhead', label: 'Overhead' },
];

interface ViewPlayer extends PlayerSnap {}
export interface View {
  players: ViewPlayer[];
  ball: { x: number; y: number; z: number; vx: number; vy: number };
}

const hashId = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
};

/** Two-segment limb: pivot at the joint root, second pivot mid-limb. */
interface Limb {
  root: THREE.Group; // hip / shoulder
  joint: THREE.Group; // knee / elbow
}

function makeLimb(
  parent: THREE.Object3D,
  x: number,
  y: number,
  upperLen: number,
  lowerLen: number,
  upperR: number,
  lowerR: number,
  upperMat: THREE.Material,
  lowerMat: THREE.Material,
  footMat?: THREE.Material,
): Limb {
  const root = new THREE.Group();
  root.position.set(0, y, x); // x offset is sideways (three z; body faces +x)
  const upper = new THREE.Mesh(new THREE.CapsuleGeometry(upperR, upperLen - upperR * 2, 4, 8), upperMat);
  upper.position.y = -upperLen / 2;
  upper.castShadow = true;
  root.add(upper);
  const joint = new THREE.Group();
  joint.position.y = -upperLen;
  const lower = new THREE.Mesh(new THREE.CapsuleGeometry(lowerR, lowerLen - lowerR * 2, 4, 8), lowerMat);
  lower.position.y = -lowerLen / 2;
  lower.castShadow = true;
  joint.add(lower);
  if (footMat) {
    const foot = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.6, 2.4), footMat);
    foot.position.set(1.1, -lowerLen - 0.4, 0);
    foot.castShadow = true;
    joint.add(foot);
  }
  root.add(joint);
  parent.add(root);
  return { root, joint };
}

/** One humanoid with articulated limbs, run/kick animation, selfie face. */
class PlayerModel {
  group = new THREE.Group(); // world position + yaw
  private lean = new THREE.Group(); // forward lean + bob live here
  private legL: Limb;
  private legR: Limb;
  private armL: Limb;
  private armR: Limb;
  private facePlane: THREE.Mesh;
  private faceMat: THREE.MeshBasicMaterial;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private blob: THREE.Mesh;
  private label: THREE.Sprite;
  private phase = Math.random() * Math.PI * 2;
  private kickT = 0;
  private prevCharge = 0;

  constructor(id: string, team: Team, name: string) {
    const h = hashId(id);
    const skin = new THREE.MeshStandardMaterial({ color: SKIN_TONES[h % SKIN_TONES.length], roughness: 0.75 });
    const hair = new THREE.MeshStandardMaterial({ color: HAIR_TONES[(h >> 3) % HAIR_TONES.length], roughness: 0.9 });
    const jersey = new THREE.MeshStandardMaterial({ color: TEAM_COLOR[team], roughness: 0.7 });
    const shorts = new THREE.MeshStandardMaterial({ color: SHORTS_COLOR[team], roughness: 0.7 });
    const socks = new THREE.MeshStandardMaterial({ color: SOCK_COLOR[team], roughness: 0.8 });
    const boots = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.5 });

    this.group.add(this.lean);

    // legs: hip height 17.5; thigh 8.5 (shorts color), calf 8 (socks) + boots
    this.legL = makeLimb(this.lean, -2.6, 17.5, 8.5, 8, 2.0, 1.5, shorts, socks, boots);
    this.legR = makeLimb(this.lean, 2.6, 17.5, 8.5, 8, 2.0, 1.5, shorts, socks, boots);

    // pelvis
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(5.4, 4.4, 7.4), shorts);
    pelvis.position.y = 19.5;
    pelvis.castShadow = true;
    this.lean.add(pelvis);

    // torso: capsule, slightly flattened front-to-back
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(4.6, 6.5, 4, 10), jersey);
    torso.position.y = 27.5;
    torso.scale.set(0.78, 1, 1.15);
    torso.castShadow = true;
    this.lean.add(torso);

    // arms at shoulders (jersey sleeves up top, skin forearms)
    this.armL = makeLimb(this.lean, -6.1, 31.5, 7, 6.5, 1.5, 1.25, jersey, skin);
    this.armR = makeLimb(this.lean, 6.1, 31.5, 7, 6.5, 1.5, 1.25, jersey, skin);

    // head + hair cap + circular selfie face looking forward (+x)
    const headG = new THREE.Group();
    headG.position.y = 38.2;
    const head = new THREE.Mesh(new THREE.SphereGeometry(3.7, 16, 12), skin);
    head.castShadow = true;
    headG.add(head);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(3.85, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
      hair,
    );
    cap.rotation.z = -0.5; // tilted back so the face stays clear
    headG.add(cap);
    this.faceMat = new THREE.MeshBasicMaterial({ transparent: false });
    this.faceMat.visible = false;
    this.facePlane = new THREE.Mesh(new THREE.CircleGeometry(2.9, 20), this.faceMat);
    this.facePlane.position.x = 3.35;
    this.facePlane.rotation.y = Math.PI / 2;
    headG.add(this.facePlane);
    this.lean.add(headG);

    // kick charge ring on the grass
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xfacc15,
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(16, 20, 24), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.6;
    this.group.add(this.ring);

    // soft radial blob shadow (used when shadow maps are off)
    this.blob = new THREE.Mesh(new THREE.CircleGeometry(10, 20), makeBlobMaterial());
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.position.y = 0.4;
    this.group.add(this.blob);

    this.label = makeLabel(name);
    this.label.position.y = 50;
    this.group.add(this.label);
  }

  setFace(url: string | null) {
    if (!url) {
      this.faceMat.map?.dispose();
      this.faceMat.map = null;
      this.faceMat.visible = false;
      this.faceMat.needsUpdate = true;
      return;
    }
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.center.set(0.5, 0.5);
      this.faceMat.map = tex;
      this.faceMat.visible = true;
      this.faceMat.needsUpdate = true;
    });
  }

  update(p: ViewPlayer, charge: number, highlight: boolean, dt: number, showName: boolean, blobShadow: boolean) {
    this.group.position.set(p.x, 0, p.y);
    this.group.rotation.y = -p.dir;
    this.label.visible = showName;
    this.blob.visible = blobShadow;

    const speed = Math.hypot(p.vx, p.vy);
    const runAmp = Math.min(1, speed / C.PLAYER_SPEED);
    this.phase += dt * (2.2 + speed * 0.052);
    const s = Math.sin(this.phase);
    const cAlt = Math.sin(this.phase + Math.PI);

    // legs: thigh swing + knee that flexes as the leg comes through
    const swing = 0.85 * runAmp;
    this.legL.root.rotation.z = s * swing;
    this.legR.root.rotation.z = cAlt * swing;
    this.legL.joint.rotation.z = -Math.max(0, -s) * 1.15 * runAmp - 0.06;
    this.legR.joint.rotation.z = -Math.max(0, -cAlt) * 1.15 * runAmp - 0.06;

    // kick: fires when a charge is released — big forward leg snap that decays
    if (this.prevCharge > 0.03 && charge < 0.01) this.kickT = 1;
    this.prevCharge = charge;
    if (this.kickT > 0) {
      this.kickT = Math.max(0, this.kickT - dt * 4.5);
      const k = Math.sin(this.kickT * Math.PI); // wind up then follow through
      this.legR.root.rotation.z = -1.25 * k;
      this.legR.joint.rotation.z = -0.25 * k;
    }

    // arms: counter-swing with a constant elbow bend; idle = slight hang
    const armSwing = 0.6 * runAmp;
    this.armL.root.rotation.z = cAlt * armSwing;
    this.armR.root.rotation.z = s * armSwing;
    this.armL.joint.rotation.z = -0.5 - 0.25 * runAmp;
    this.armR.joint.rotation.z = -0.5 - 0.25 * runAmp;

    // body language: forward lean with speed, bob with the stride,
    // gentle breathing at rest
    const lean = 0.05 + runAmp * 0.2;
    this.lean.rotation.z = -lean;
    this.lean.position.y = Math.abs(Math.sin(this.phase)) * 1.5 * runAmp;
    if (runAmp < 0.05) {
      this.lean.position.y = Math.sin(this.phase * 0.35) * 0.25;
    }

    // charge ring: fades in and heats toward red
    this.ringMat.opacity = charge > 0.02 ? 0.35 + charge * 0.6 : 0;
    this.ringMat.color.setHSL(0.15 - charge * 0.15, 1, 0.55);
    this.ring.scale.setScalar(1 + charge * 0.25);
    this.ring.rotation.z = p.dir;

    (this.label.material as THREE.SpriteMaterial).opacity = highlight ? 1 : 0.85;
  }
}

function makeBlobMaterial(): THREE.MeshBasicMaterial {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  const g = x.createRadialGradient(32, 32, 4, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.4)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
}

function makeLabel(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 56;
  const x = c.getContext('2d')!;
  x.font = '700 30px system-ui';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineWidth = 6;
  x.strokeStyle = 'rgba(0,0,0,0.7)';
  x.strokeText(text, 128, 28);
  x.fillStyle = '#fff';
  x.fillText(text, 128, 28);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  sprite.scale.set(44, 9.6, 1);
  return sprite;
}

/** Paints the pitch (stripes + all white lines + grass noise) once. */
function makePitchTexture(): THREE.CanvasTexture {
  const W = 1024, H = Math.round(1024 * (C.PITCH_H / C.PITCH_W));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d')!;
  const sx = W / C.PITCH_W, sy = H / C.PITCH_H;
  x.fillStyle = '#2f9e44';
  x.fillRect(0, 0, W, H);
  x.fillStyle = 'rgba(255,255,255,0.055)';
  for (let i = 0; i < 10; i += 2) x.fillRect((i * W) / 10, 0, W / 10, H);
  // grass noise
  for (let i = 0; i < 3500; i++) {
    x.fillStyle = `rgba(0,60,0,${Math.random() * 0.08})`;
    x.fillRect(Math.random() * W, Math.random() * H, 2, 2);
  }
  x.strokeStyle = 'rgba(255,255,255,0.9)';
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.lineWidth = 3;
  x.strokeRect(4, 4, W - 8, H - 8);
  x.beginPath(); x.moveTo(W / 2, 4); x.lineTo(W / 2, H - 4); x.stroke();
  x.beginPath(); x.arc(W / 2, H / 2, 70 * sx, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.arc(W / 2, H / 2, 4, 0, Math.PI * 2); x.fill();
  const boxW = 120 * sx, boxH = 300 * sy, smallW = 45 * sx, smallH = 150 * sy;
  for (const side of [0, 1]) {
    const bx = side ? W - 4 - boxW : 4;
    x.strokeRect(bx, (H - boxH) / 2, boxW, boxH);
    const sbx = side ? W - 4 - smallW : 4;
    x.strokeRect(sbx, (H - smallH) / 2, smallW, smallH);
    const px = side ? W - 4 - 85 * sx : 4 + 85 * sx;
    x.beginPath(); x.arc(px, H / 2, 4, 0, Math.PI * 2); x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function makeCrowdTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = '#334155';
  x.fillRect(0, 0, 256, 64);
  const colors = ['#f1f5f9', '#fbbf24', '#60a5fa', '#f87171', '#4ade80', '#c084fc', '#94a3b8'];
  for (let i = 0; i < 900; i++) {
    x.fillStyle = colors[(Math.random() * colors.length) | 0];
    x.fillRect(Math.random() * 256, Math.random() * 64, 2.2, 2.2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Rectangular grid of line segments (goal netting). */
function makeNetGrid(w: number, h: number, step: number): THREE.LineSegments {
  const pts: number[] = [];
  for (let gx = 0; gx <= w + 0.01; gx += step) pts.push(gx - w / 2, -h / 2, 0, gx - w / 2, h / 2, 0);
  for (let gy = 0; gy <= h + 0.01; gy += step) pts.push(-w / 2, gy - h / 2, 0, w / 2, gy - h / 2, 0);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }),
  );
}

export class Renderer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private players = new Map<string, PlayerModel>();
  private faces = new Map<string, string>();
  private pendingFaces: Record<string, string | null> = {};
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private camTarget = new THREE.Vector3(C.PITCH_W / 2, 0, C.PITCH_H / 2);
  private camMode: CamMode = 'broadcast';
  private camYaw = 0;
  private zoom = 1;
  private showNames = true;
  private shadowsOn = false;
  private lastTime = performance.now();

  setCamMode(m: CamMode) {
    this.camMode = m;
  }
  get cameraYaw() {
    return this.camYaw;
  }
  setZoom(z: number) {
    this.zoom = z;
  }
  setShowNames(b: boolean) {
    this.showNames = b;
  }
  setQuality(q: 'high' | 'low') {
    this.shadowsOn = q === 'high';
    this.renderer.shadowMap.enabled = this.shadowsOn;
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(devicePixelRatio || 1, 1.75));
    // shadow toggle needs a material recompile
    this.scene.traverse((o: any) => {
      if (o.material) {
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.needsUpdate = true;
      }
    });
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x8ecdf5);
    this.scene.fog = new THREE.Fog(0x8ecdf5, 1100, 2400);

    this.camera = new THREE.PerspectiveCamera(52, 1, 10, 3000);

    // --- lights ---
    this.scene.add(new THREE.HemisphereLight(0xdff2ff, 0x2c6b35, 0.95));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.15));
    const sun = new THREE.DirectionalLight(0xfff3d8, 1.45);
    sun.position.set(C.PITCH_W / 2 - 380, 620, C.PITCH_H / 2 + 260);
    sun.target.position.set(C.PITCH_W / 2, 0, C.PITCH_H / 2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -640;
    sc.right = 640;
    sc.top = 460;
    sc.bottom = -460;
    sc.near = 120;
    sc.far = 1600;
    sun.shadow.bias = -0.0006;
    this.scene.add(sun, sun.target);

    // --- ground + pitch ---
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 3000),
      new THREE.MeshLambertMaterial({ color: 0x256b31 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(C.PITCH_W / 2, -0.5, C.PITCH_H / 2);
    ground.receiveShadow = true;
    this.scene.add(ground);

    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(C.PITCH_W, C.PITCH_H),
      new THREE.MeshLambertMaterial({ map: makePitchTexture() }),
    );
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.set(C.PITCH_W / 2, 0, C.PITCH_H / 2);
    pitch.receiveShadow = true;
    this.scene.add(pitch);

    this.buildGoals();
    this.buildStands();
    this.buildFloodlights();

    // --- ball: classic panels, rolls around its true axis ---
    const ballTexC = document.createElement('canvas');
    ballTexC.width = 128;
    ballTexC.height = 64;
    const bx = ballTexC.getContext('2d')!;
    bx.fillStyle = '#fafafa';
    bx.fillRect(0, 0, 128, 64);
    bx.fillStyle = '#1f2937';
    for (let i = 0; i < 10; i++) {
      const px = (i % 5) * 26 + (i > 4 ? 13 : 0);
      const py = Math.floor(i / 5) * 32 + 8;
      bx.beginPath();
      bx.arc(px + 6, py + 6, 6, 0, Math.PI * 2);
      bx.fill();
    }
    const ballTex = new THREE.CanvasTexture(ballTexC);
    ballTex.colorSpace = THREE.SRGBColorSpace;
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(C.BALL_RADIUS * 0.85, 24, 18),
      new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.4 }),
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);

    this.ballShadow = new THREE.Mesh(new THREE.CircleGeometry(C.BALL_RADIUS, 16), makeBlobMaterial());
    this.ballShadow.rotation.x = -Math.PI / 2;
    this.ballShadow.position.y = 0.5;
    this.scene.add(this.ballShadow);

    const resize = () => {
      this.renderer.setSize(innerWidth, innerHeight);
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
    };
    addEventListener('resize', resize);
    resize();
  }

  private buildGoals() {
    const postMat = new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.35 });
    const H = C.GOAL_HEIGHT, W = C.GOAL_WIDTH, D = 42;
    for (const side of [0, 1]) {
      const gx = side ? C.PITCH_W : 0;
      const back = side ? gx + D : gx - D;
      const y0 = C.PITCH_H / 2 - W / 2, y1 = C.PITCH_H / 2 + W / 2;
      const post = () => {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, H, 10), postMat);
        m.castShadow = true;
        return m;
      };
      const p1 = post(); p1.position.set(gx, H / 2, y0);
      const p2 = post(); p2.position.set(gx, H / 2, y1);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, W, 10), postMat);
      bar.castShadow = true;
      bar.rotation.x = Math.PI / 2;
      bar.position.set(gx, H, C.PITCH_H / 2);
      // netting: back wall + roof as line grids
      const backNet = makeNetGrid(W, H, 9);
      backNet.rotation.y = Math.PI / 2;
      backNet.position.set(back, H / 2, C.PITCH_H / 2);
      const roof = makeNetGrid(D, W, 9);
      roof.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      roof.position.set((gx + back) / 2, H, C.PITCH_H / 2);
      const sideNetL = makeNetGrid(D, H, 9);
      sideNetL.rotation.y = 0;
      sideNetL.position.set((gx + back) / 2, H / 2, y0);
      const sideNetR = makeNetGrid(D, H, 9);
      sideNetR.position.set((gx + back) / 2, H / 2, y1);
      this.scene.add(p1, p2, bar, backNet, roof, sideNetL, sideNetR);
    }
  }

  private buildStands() {
    const crowd = makeCrowdTexture();
    const mkStand = (w: number, d: number) => {
      const g = new THREE.Group();
      for (let tier = 0; tier < 3; tier++) {
        const mat = new THREE.MeshLambertMaterial({ map: crowd.clone() });
        mat.map!.repeat.set(Math.max(1, Math.round(w / 130)), 1);
        const step = new THREE.Mesh(new THREE.BoxGeometry(w, 26, d / 3), mat);
        step.position.set(0, 13 + tier * 24, -tier * (d / 3));
        g.add(step);
      }
      return g;
    };
    const MARGIN = 70;
    const cx = C.PITCH_W / 2, cy = C.PITCH_H / 2;
    // far touchline only — the camera films from the near side
    const s1 = mkStand(C.PITCH_W + 200, 100);
    s1.position.set(cx, 0, -MARGIN);
    s1.rotation.y = Math.PI;
    const s3 = mkStand(C.PITCH_H + 60, 100);
    s3.position.set(-MARGIN - 40, 0, cy);
    s3.rotation.y = -Math.PI / 2;
    const s4 = mkStand(C.PITCH_H + 60, 100);
    s4.position.set(C.PITCH_W + MARGIN + 40, 0, cy);
    s4.rotation.y = Math.PI / 2;
    this.scene.add(s1, s3, s4);
  }

  private buildFloodlights() {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x475569 });
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xfffbe8 });
    for (const [px, py] of [
      [-120, -120],
      [C.PITCH_W + 120, -120],
      [-120, C.PITCH_H + 120],
      [C.PITCH_W + 120, C.PITCH_H + 120],
    ]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(3, 4, 300, 8), poleMat);
      pole.position.set(px, 150, py);
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(34, 22, 6), lampMat);
      lamp.position.set(px, 305, py);
      lamp.lookAt(C.PITCH_W / 2, 0, C.PITCH_H / 2);
      this.scene.add(pole, lamp);
    }
  }

  setAvatar(id: string, url: string | null) {
    this.pendingFaces[id] = url;
  }

  update(view: View | null, myId: string | null, myCharge: number) {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    let me: ViewPlayer | undefined;
    if (view) {
      me = view.players.find((p) => p.id === myId);
      const seen = new Set<string>();
      for (const p of view.players) {
        seen.add(p.id);
        let model = this.players.get(p.id);
        if (!model) {
          model = new PlayerModel(p.id, p.team, p.name);
          this.players.set(p.id, model);
          this.scene.add(model.group);
          this.faces.delete(p.id);
        }
        const want = this.pendingFaces[p.id] ?? null;
        if ((this.faces.get(p.id) ?? null) !== want) {
          model.setFace(want);
          if (want === null) this.faces.delete(p.id);
          else this.faces.set(p.id, want);
        }
        const charge = p.id === myId ? myCharge : p.charge;
        model.update(p, charge, p.id === myId, dt, this.showNames, !this.shadowsOn);
        model.group.visible = !(this.camMode === 'first' && p.id === myId && me);
      }
      for (const [id, model] of this.players) {
        if (!seen.has(id)) {
          this.scene.remove(model.group);
          this.players.delete(id);
        }
      }

      // ball: position + true rolling axis (up x velocity)
      const b = view.ball;
      this.ball.position.set(b.x, C.BALL_RADIUS * 0.85 + b.z, b.y);
      const sp = Math.hypot(b.vx, b.vy);
      if (sp > 1) {
        const axis = new THREE.Vector3(b.vy / sp, 0, -b.vx / sp);
        this.ball.rotateOnWorldAxis(axis, (-sp * dt) / (C.BALL_RADIUS * 0.85));
      }
      const sh = Math.max(0.35, 1 - b.z / 260);
      this.ballShadow.position.set(b.x, 0.5, b.y);
      this.ballShadow.scale.setScalar(sh);
      this.ballShadow.visible = !this.shadowsOn || b.z > 4; // airborne: blob helps depth-read
      (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.75 * sh;

      // PES-style follow target: ball first with velocity look-ahead
      const lead = 0.3;
      const bx2 = b.x + b.vx * lead;
      const by2 = b.y + b.vy * lead;
      const fx = me ? bx2 * 0.7 + me.x * 0.3 : bx2;
      const fy = me ? by2 * 0.7 + me.y * 0.3 : by2;
      this.camTarget.lerp(
        new THREE.Vector3(
          Math.max(120, Math.min(C.PITCH_W - 120, fx)),
          0,
          Math.max(80, Math.min(C.PITCH_H - 40, fy)),
        ),
        1 - Math.exp(-4 * dt),
      );

      if (me) {
        let d = me.dir - this.camYaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this.camYaw += d * (1 - Math.exp(-(this.camMode === 'first' ? 10 : 7) * dt));
      }
    }

    this.placeCamera(me);
    this.renderer.render(this.scene, this.camera);
  }

  private placeCamera(me: ViewPlayer | undefined) {
    const t = this.camTarget;
    const z = this.zoom;
    const mode = me ? this.camMode : 'broadcast';
    const fx = Math.cos(this.camYaw), fz = Math.sin(this.camYaw);

    switch (mode) {
      case 'third':
        this.camera.position.set(me!.x - fx * 150 * z, 100 * z, me!.y - fz * 150 * z);
        this.camera.lookAt(me!.x + fx * 90, 18, me!.y + fz * 90);
        break;
      case 'first':
        this.camera.position.set(me!.x + fx * 8, 32, me!.y + fz * 8);
        this.camera.lookAt(me!.x + fx * 90, 2, me!.y + fz * 90);
        break;
      case 'overhead':
        this.camera.position.set(t.x, 720 * z, t.z + 1);
        this.camera.lookAt(t.x, 0, t.z);
        break;
      default:
        // PES-style broadcast: low, close, panning with the ball
        this.camera.position.set(t.x, 270 * z, t.z + 290 * z);
        this.camera.lookAt(t.x, 8, t.z - 30);
    }
  }
}
