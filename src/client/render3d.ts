// 3D presentation layer. The server still simulates in 2D world units
// (x right, y down, ball z = height); this module maps that into a three.js
// stadium: three (x, y=up, z) = world (x, height, y).
import * as THREE from 'three';
import { CONFIG as C } from '../shared/config';
import type { PlayerSnap, Team } from '../shared/protocol';

const TEAM_COLOR: Record<Team, number> = { A: 0x2563eb, B: 0xdc2626 };
const SHORTS_COLOR: Record<Team, number> = { A: 0x1e3a8a, B: 0x7f1d1d };
const SKIN = 0xd9a066;

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
  ball: { x: number; y: number; z: number };
}

/** One humanoid: group of boxes with swinging limbs + selfie face. */
class PlayerModel {
  group = new THREE.Group();
  private legL: THREE.Object3D;
  private legR: THREE.Object3D;
  private armL: THREE.Object3D;
  private armR: THREE.Object3D;
  private headMats: THREE.MeshLambertMaterial[];
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private shadow: THREE.Mesh;
  private label: THREE.Sprite;
  private phase = 0;

  constructor(team: Team, name: string) {
    const jersey = new THREE.MeshLambertMaterial({ color: TEAM_COLOR[team] });
    const shorts = new THREE.MeshLambertMaterial({ color: SHORTS_COLOR[team] });
    const skin = new THREE.MeshLambertMaterial({ color: SKIN });

    // limb with the pivot at the top (hip/shoulder) so rotation swings it
    const limb = (w: number, len: number, mat: THREE.Material, x: number, y: number) => {
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, len, w), mat);
      mesh.position.y = -len / 2;
      pivot.add(mesh);
      pivot.position.set(0, y, x); // x offset is sideways = three z (front is +x)
      this.group.add(pivot);
      return pivot;
    };

    this.legL = limb(4.5, 15, skin, -4, 15);
    this.legR = limb(4.5, 15, skin, 4, 15);
    this.armL = limb(3.5, 13, jersey, -8.5, 30);
    this.armR = limb(3.5, 13, jersey, 8.5, 30);

    const torso = new THREE.Mesh(new THREE.BoxGeometry(8, 15, 13), jersey);
    torso.position.y = 23;
    this.group.add(torso);
    const hips = new THREE.Mesh(new THREE.BoxGeometry(7.5, 5, 12), shorts);
    hips.position.y = 14;
    this.group.add(hips);

    // head: box, face texture goes on the +x (front) side
    this.headMats = Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({ color: SKIN }));
    const head = new THREE.Mesh(new THREE.BoxGeometry(8.5, 9, 8.5), this.headMats);
    head.position.y = 35.5;
    this.group.add(head);

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

    // blob shadow (no shadow maps — cheap on phones)
    this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(11, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = 0.4;
    this.group.add(this.shadow);

    this.label = makeLabel(name);
    this.label.position.y = 50;
    this.group.add(this.label);
  }

  setFace(url: string | null) {
    const front = this.headMats[0]; // +x face
    if (!url) {
      front.map?.dispose();
      front.map = null;
      front.color.set(SKIN);
      front.needsUpdate = true;
      return;
    }
    new THREE.TextureLoader().load(url, (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      front.map = tex;
      front.color.set(0xffffff);
      front.needsUpdate = true;
    });
  }

  update(p: ViewPlayer, charge: number, highlight: boolean, dt: number, showName: boolean) {
    this.group.position.set(p.x, 0, p.y);
    this.group.rotation.y = -p.dir;
    this.label.visible = showName;

    // run cycle: swing speed follows actual velocity
    const speed = Math.hypot(p.vx, p.vy);
    this.phase += dt * (2 + speed * 0.045);
    const amp = Math.min(1, speed / C.PLAYER_SPEED) * 0.8;
    const s = Math.sin(this.phase);
    this.legL.rotation.z = s * amp;
    this.legR.rotation.z = -s * amp;
    this.armL.rotation.z = -s * amp * 0.7;
    this.armR.rotation.z = s * amp * 0.7;

    // charge ring: fades in and heats up toward red as it charges
    this.ringMat.opacity = charge > 0.02 ? 0.35 + charge * 0.6 : 0;
    this.ringMat.color.setHSL(0.15 - charge * 0.15, 1, 0.55);
    this.ring.scale.setScalar(1 + charge * 0.25);
    // counter-rotate so the ring doesn't spin with the body
    this.ring.rotation.z = p.dir;

    (this.label.material as THREE.SpriteMaterial).opacity = highlight ? 1 : 0.85;
  }
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

/** Paints the pitch (stripes + all white lines) once into a texture. */
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
  x.strokeStyle = 'rgba(255,255,255,0.9)';
  x.fillStyle = 'rgba(255,255,255,0.9)';
  x.lineWidth = 3;
  x.strokeRect(4, 4, W - 8, H - 8);
  x.beginPath(); x.moveTo(W / 2, 4); x.lineTo(W / 2, H - 4); x.stroke();
  x.beginPath(); x.arc(W / 2, H / 2, 70 * sx, 0, Math.PI * 2); x.stroke();
  x.beginPath(); x.arc(W / 2, H / 2, 4, 0, Math.PI * 2); x.fill();
  // penalty boxes + spots, purely decorative
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

export class Renderer3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private players = new Map<string, PlayerModel>();
  private faces = new Map<string, string>(); // id -> data URL currently applied
  private pendingFaces: Record<string, string | null> = {};
  private ball: THREE.Mesh;
  private ballShadow: THREE.Mesh;
  private camTarget = new THREE.Vector3(C.PITCH_W / 2, 0, C.PITCH_H / 2);
  private camMode: CamMode = 'broadcast';
  private camYaw = 0; // smoothed facing used by third/first person cams
  private zoom = 1;
  private showNames = true;
  private lastTime = performance.now();

  setCamMode(m: CamMode) {
    this.camMode = m;
  }
  /** smoothed yaw the follow cams look along — used to make input camera-relative */
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
    this.renderer.setPixelRatio(q === 'low' ? 1 : Math.min(devicePixelRatio || 1, 1.75));
  }

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    this.renderer.setClearColor(0x8ecdf5);
    this.scene.fog = new THREE.Fog(0x8ecdf5, 1100, 2400);

    this.camera = new THREE.PerspectiveCamera(52, 1, 10, 3000);

    // --- lights ---
    this.scene.add(new THREE.HemisphereLight(0xdff2ff, 0x2c6b35, 1.05));
    const sun = new THREE.DirectionalLight(0xfff5df, 1.1);
    sun.position.set(-400, 600, 300);
    this.scene.add(sun);

    // --- ground + pitch ---
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 3000),
      new THREE.MeshLambertMaterial({ color: 0x256b31 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(C.PITCH_W / 2, -0.5, C.PITCH_H / 2);
    this.scene.add(ground);

    const pitch = new THREE.Mesh(
      new THREE.PlaneGeometry(C.PITCH_W, C.PITCH_H),
      new THREE.MeshLambertMaterial({ map: makePitchTexture() }),
    );
    pitch.rotation.x = -Math.PI / 2;
    pitch.position.set(C.PITCH_W / 2, 0, C.PITCH_H / 2);
    this.scene.add(pitch);

    this.buildGoals();
    this.buildStands();
    this.buildFloodlights();

    // --- ball ---
    const ballTexC = document.createElement('canvas');
    ballTexC.width = ballTexC.height = 64;
    const bx = ballTexC.getContext('2d')!;
    bx.fillStyle = '#ffffff';
    bx.fillRect(0, 0, 64, 64);
    bx.fillStyle = '#1f2937';
    for (let i = 0; i < 8; i++) bx.fillRect((i % 4) * 16 + (i > 3 ? 8 : 0), Math.floor(i / 4) * 32 + 8, 9, 9);
    const ballTex = new THREE.CanvasTexture(ballTexC);
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(C.BALL_RADIUS * 0.85, 20, 14),
      new THREE.MeshLambertMaterial({ map: ballTex }),
    );
    this.scene.add(this.ball);

    this.ballShadow = new THREE.Mesh(
      new THREE.CircleGeometry(C.BALL_RADIUS * 0.9, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.3, depthWrite: false }),
    );
    this.ballShadow.rotation.x = -Math.PI / 2;
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
    const postMat = new THREE.MeshLambertMaterial({ color: 0xf8fafc });
    const netMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.18,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const H = C.GOAL_HEIGHT, W = C.GOAL_WIDTH, D = 42;
    for (const side of [0, 1]) {
      const gx = side ? C.PITCH_W : 0;
      const back = side ? gx + D : gx - D;
      const y0 = C.PITCH_H / 2 - W / 2, y1 = C.PITCH_H / 2 + W / 2;
      const post = () => new THREE.Mesh(new THREE.CylinderGeometry(2, 2, H, 10), postMat);
      const p1 = post(); p1.position.set(gx, H / 2, y0);
      const p2 = post(); p2.position.set(gx, H / 2, y1);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, W, 10), postMat);
      bar.rotation.x = Math.PI / 2;
      bar.position.set(gx, H, C.PITCH_H / 2);
      // net: back wall + roof
      const backNet = new THREE.Mesh(new THREE.PlaneGeometry(W, H), netMat);
      backNet.rotation.y = Math.PI / 2;
      backNet.position.set(back, H / 2, C.PITCH_H / 2);
      const roof = new THREE.Mesh(new THREE.PlaneGeometry(D, W), netMat);
      roof.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      roof.position.set((gx + back) / 2, H, C.PITCH_H / 2);
      this.scene.add(p1, p2, bar, backNet, roof);
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
    // far touchline only — the camera films from the near side, and a stand
    // there would block the view whenever play reaches the near corners
    const s1 = mkStand(C.PITCH_W + 200, 100);
    s1.position.set(cx, 0, -MARGIN);
    s1.rotation.y = Math.PI; // faces the pitch
    // end stands
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

  /** Queue a face change; applied when the player model exists. */
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
          model = new PlayerModel(p.team, p.name);
          this.players.set(p.id, model);
          this.scene.add(model.group);
          this.faces.delete(p.id);
        }
        // apply queued/changed face textures
        const want = this.pendingFaces[p.id] ?? null;
        if ((this.faces.get(p.id) ?? null) !== want) {
          model.setFace(want);
          if (want === null) this.faces.delete(p.id);
          else this.faces.set(p.id, want);
        }
        const charge = p.id === myId ? myCharge : p.charge;
        model.update(p, charge, p.id === myId, dt, this.showNames);
        // in first person you ARE the model — hide it so it doesn't block the lens
        model.group.visible = !(this.camMode === 'first' && p.id === myId && me);
      }
      for (const [id, model] of this.players) {
        if (!seen.has(id)) {
          this.scene.remove(model.group);
          this.players.delete(id);
        }
      }

      // ball + its blob shadow
      const b = view.ball;
      this.ball.position.set(b.x, C.BALL_RADIUS * 0.85 + b.z, b.y);
      this.ball.rotation.x += dt * 4;
      const sh = Math.max(0.35, 1 - b.z / 260);
      this.ballShadow.position.set(b.x, 0.5, b.y);
      this.ballShadow.scale.setScalar(sh);
      (this.ballShadow.material as THREE.MeshBasicMaterial).opacity = 0.3 * sh;

      // shared follow target for broadcast/overhead: my player biased toward
      // the ball so the action stays in frame (ball only when spectating)
      const fx = me ? me.x * 0.65 + b.x * 0.35 : b.x;
      const fy = me ? me.y * 0.65 + b.y * 0.35 : b.y;
      this.camTarget.lerp(new THREE.Vector3(fx, 0, fy), 1 - Math.exp(-4 * dt));

      // smoothed yaw for the follow cams — raw dir snaps with input, the
      // camera easing it out is what keeps FP/3P watchable
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
    const mode = me ? this.camMode : 'broadcast'; // spectators get broadcast
    const fx = Math.cos(this.camYaw), fz = Math.sin(this.camYaw);

    switch (mode) {
      case 'third':
        // over-the-shoulder action cam, trailing the smoothed facing
        this.camera.position.set(
          me!.x - fx * 150 * z,
          100 * z,
          me!.y - fz * 150 * z,
        );
        this.camera.lookAt(me!.x + fx * 90, 18, me!.y + fz * 90);
        break;
      case 'first':
        // eye height, slightly ahead of the head so the body never clips;
        // tilted down enough that the ball at your feet stays in frame
        this.camera.position.set(me!.x + fx * 8, 32, me!.y + fz * 8);
        this.camera.lookAt(me!.x + fx * 90, 2, me!.y + fz * 90);
        break;
      case 'overhead':
        // tactical top-down (tiny z offset keeps lookAt from degenerating)
        this.camera.position.set(t.x, 720 * z, t.z + 1);
        this.camera.lookAt(t.x, 0, t.z);
        break;
      default:
        // broadcast: elevated side follow
        this.camera.position.set(t.x, 430 * z, t.z + 330 * z);
        this.camera.lookAt(t.x, 10, t.z - 40);
    }
  }
}
