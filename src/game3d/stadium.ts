// ============================================================
// STADIUM — a real bowl around the pitch.
//
//  - Raked concrete stands (stepped rows + seat strips), a covered main
//    stand with a cantilever roof, open ends, a lower near stand, dugouts.
//  - A LIVING CROWD: ~2,500 instanced fan cards in ONE draw call. Each fan
//    is a billboard from a generated sprite atlas (16 people x 2 poses);
//    the vertex shader bobs, cheers (arms up), and on a goal the scoring
//    side's fans JUMP while the other end goes quiet. Home/away ends carry
//    team colors, like the ultras behind each goal on TV.
//  - Floodlight towers with lamp banks that glow at night.
//  - Animated LED advertising boards that rotate their ads.
//
// Authoring convention (learned the hard way): every stand is built in a
// local frame where +z points AWAY from the pitch, so any group rotation
// keeps tiers and roofs outside the field.
// ============================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface StadiumOpts {
  L: number;
  W: number;
  night: boolean;
  hiRes: boolean;
  towers: THREE.Vector3[];
  teamColors: [number, number];
}

export interface Stadium {
  /** per-frame: crowd animation + LED boards. excite 0..1 (play near goal) */
  update(dt: number, excite: number): void;
  /** goal! the scoring side's fans erupt (0 = team A, 1 = team B) */
  celebrate(team: 0 | 1): void;
}

// ---------------------------------------------------------------
// crowd sprite atlas: 16 people x 2 poses (arms down / arms up)
// 0-3 team-A fans (blue), 4-7 team-B fans (red), 8-15 neutrals
// ---------------------------------------------------------------
const CELL_W = 128, CELL_H = 240, COLS = 8, ROWS = 4;
function crowdAtlas(teamColors: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = CELL_W * COLS;
  c.height = CELL_H * ROWS;
  const g = c.getContext('2d')!;
  const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
  const shade = (n: number, k: number) => {
    const r = Math.min(255, ((n >> 16) & 255) * k) | 0;
    const gg = Math.min(255, ((n >> 8) & 255) * k) | 0;
    const b = Math.min(255, (n & 255) * k) | 0;
    return `rgb(${r},${gg},${b})`;
  };
  const skins = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xba8a63];
  const hairs = [0x1c1512, 0x3b2a1a, 0x0d0d0d, 0x5b3b1a, 0x8a6a3a, 0x62514a];
  // real crowds are mostly dark and muted — saturated color comes from the
  // team-shirted fans, not from every seat
  const neutrals = [0x111827, 0x1f2937, 0x374151, 0xd1d5db, 0x1e3a8a, 0x44403c, 0x27272a, 0x6b7280];
  for (let p = 0; p < 16; p++) {
    const shirt = p < 4 ? teamColors[0] : p < 8 ? teamColors[1] : neutrals[p - 8];
    const variantK = [1.0, 0.8, 1.15, 0.9][p % 4];
    const skin = skins[(p * 5 + 1) % skins.length];
    const hair = hairs[(p * 3 + 2) % hairs.length];
    const scarf = p < 8 && p % 2 === 0; // team fans with scarves
    for (let pose = 0; pose < 2; pose++) {
      const col = p % COLS;
      const row = Math.floor(p / COLS) * 2 + pose;
      const ox = col * CELL_W, oy = row * CELL_H;
      const cx = ox + CELL_W / 2;
      g.save();
      // legs (seated: knees toward the viewer)
      g.fillStyle = shade(0x1f2937, 0.9 + (p % 3) * 0.1);
      g.fillRect(cx - 34, oy + 186, 30, 54);
      g.fillRect(cx + 4, oy + 186, 30, 54);
      // torso with a soft top-left light
      const tg = g.createLinearGradient(cx - 40, oy + 90, cx + 40, oy + 200);
      tg.addColorStop(0, shade(shirt, 1.2 * variantK));
      tg.addColorStop(1, shade(shirt, 0.72 * variantK));
      g.fillStyle = tg;
      g.beginPath();
      g.roundRect(cx - 42, oy + 92, 84, 104, 22);
      g.fill();
      // arms
      g.strokeStyle = shade(shirt, 0.9 * variantK);
      g.lineCap = 'round';
      g.lineWidth = 17;
      if (pose === 0) {
        g.beginPath(); g.moveTo(cx - 36, oy + 104); g.lineTo(cx - 44, oy + 170); g.lineTo(cx - 24, oy + 192); g.stroke();
        g.beginPath(); g.moveTo(cx + 36, oy + 104); g.lineTo(cx + 44, oy + 170); g.lineTo(cx + 24, oy + 192); g.stroke();
      } else {
        g.beginPath(); g.moveTo(cx - 34, oy + 102); g.lineTo(cx - 50, oy + 52); g.lineTo(cx - 44, oy + 14); g.stroke();
        g.beginPath(); g.moveTo(cx + 34, oy + 102); g.lineTo(cx + 50, oy + 52); g.lineTo(cx + 44, oy + 14); g.stroke();
        // hands
        g.fillStyle = hex(skin);
        g.beginPath(); g.arc(cx - 44, oy + 12, 8, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(cx + 44, oy + 12, 8, 0, Math.PI * 2); g.fill();
        if (scarf) {
          // scarf held aloft between the hands
          g.fillStyle = hex(shirt);
          g.fillRect(cx - 44, oy + 2, 88, 16);
          g.fillStyle = '#f8fafc';
          for (let s = 0; s < 88; s += 22) g.fillRect(cx - 44 + s, oy + 2, 8, 16);
        }
      }
      // neck + head
      g.fillStyle = shade(skin, 0.85);
      g.fillRect(cx - 9, oy + 76, 18, 20);
      const hg = g.createRadialGradient(cx - 8, oy + 52, 4, cx, oy + 60, 30);
      hg.addColorStop(0, shade(skin, 1.12));
      hg.addColorStop(1, shade(skin, 0.8));
      g.fillStyle = hg;
      g.beginPath();
      g.ellipse(cx, oy + 60, 24, 27, 0, 0, Math.PI * 2);
      g.fill();
      // hair / caps
      g.fillStyle = hex(p % 5 === 3 ? shirt : hair);
      g.beginPath();
      g.ellipse(cx, oy + 46, 25, 16, 0, Math.PI, Math.PI * 2);
      g.fill();
      if (p % 5 === 3) g.fillRect(cx - 26, oy + 44, 52, 7); // cap brim
      // face hint
      g.fillStyle = 'rgba(20,20,20,0.55)';
      g.fillRect(cx - 12, oy + 58, 6, 4);
      g.fillRect(cx + 6, oy + 58, 6, 4);
      g.restore();
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function crowdMaterial(atlas: THREE.Texture, night: boolean) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uAtlas: { value: atlas },
        uTime: { value: 0 },
        uExcite: { value: 0.3 },
        uJumpA: { value: 0 },
        uJumpB: { value: 0 },
        uLight: { value: night ? 0.62 : 0.9 },
      },
    ]),
    fog: true,
    vertexShader: /* glsl */ `
      #include <fog_pars_vertex>
      attribute vec4 aCard;   // person, phase, energy, brightness
      attribute float aTeam;  // 0 neutral, 1 team-A end, 2 team-B end
      uniform float uTime, uExcite, uJumpA, uJumpB;
      varying vec2 vUv;
      varying float vBright;
      void main() {
        float jump = aTeam > 1.5 ? uJumpB : aTeam > 0.5 ? uJumpA : max(uJumpA, uJumpB) * 0.6;
        float gloom = aTeam > 1.5 ? uJumpA : aTeam > 0.5 ? uJumpB : 0.0; // the other end sulks
        // cheering: each fan raises arms on his own rhythm when play is hot
        float rhythm = sin(uTime * (2.4 + aCard.z * 2.2) + aCard.y) * 0.5 + 0.5;
        float cheer = step(0.62, rhythm) * step(0.4, uExcite * (0.4 + aCard.z) + jump);
        float pose = max(cheer, step(0.25, jump)) * (1.0 - step(0.5, gloom));
        float person = aCard.x;
        float col = mod(person, 8.0);
        float row = floor(person / 8.0) * 2.0 + pose;
        vUv = vec2((col + uv.x) / 8.0, 1.0 - (row + 1.0 - uv.y) / 4.0);
        vBright = aCard.w;

        vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float bob = sin(uTime * (2.0 + aCard.z * 2.6) + aCard.y) * 0.025 * (0.3 + uExcite);
        float hop = max(0.0, sin(uTime * 7.0 + aCard.y * 1.7)) * 0.34 * jump * (0.55 + aCard.z);
        // upright billboard: turn to the camera around the vertical only
        vec3 toCam = cameraPosition - base;
        toCam.y = 0.0;
        toCam = normalize(toCam + vec3(1e-4, 0.0, 0.0));
        vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
        vec3 wp = base + right * position.x * 0.64 + vec3(0.0, (position.y + 0.5) * 1.2 + bob + hop, 0.0);
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      uniform sampler2D uAtlas;
      uniform float uLight;
      varying vec2 vUv;
      varying float vBright;
      void main() {
        vec4 c = texture2D(uAtlas, vUv);
        if (c.a < 0.5) discard;
        gl_FragColor = vec4(c.rgb * vBright * uLight, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}

// ---------------------------------------------------------------
// stand geometry: stepped rows in a local frame (+z away from pitch)
// ---------------------------------------------------------------
interface StandSpec {
  len: number;
  rows: number;
  rowDepth: number;
  rise: number;
  frontWall: number;
  roof?: boolean;
}
function buildStand(spec: StandSpec, mats: { concrete: THREE.Material; seat: THREE.Material; roof: THREE.Material; steel: THREE.Material }) {
  const g = new THREE.Group();
  const concrete: THREE.BufferGeometry[] = [];
  const seats: THREE.BufferGeometry[] = [];
  const slots: { p: THREE.Vector3; rowF: number }[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(x, y, z);
    return b;
  };
  // front wall (with a lip)
  concrete.push(box(spec.len, spec.frontWall, 0.3, 0, spec.frontWall / 2, 0.15));
  let top = spec.frontWall;
  for (let r = 0; r < spec.rows; r++) {
    top = spec.frontWall + r * spec.rise;
    const z0 = 0.3 + r * spec.rowDepth;
    concrete.push(box(spec.len, top, spec.rowDepth, 0, top / 2, z0 + spec.rowDepth / 2));
    seats.push(box(spec.len, 0.42, 0.32, 0, top + 0.21, z0 + spec.rowDepth * 0.66));
    // seat slots, with aisles (vomitories) every 13 seats
    const n = Math.floor(spec.len / 0.56);
    for (let s = 0; s < n; s++) {
      if (s % 14 === 13) continue;
      const x = -spec.len / 2 + 0.28 + s * 0.56;
      const jitter = (Math.random() - 0.5) * 0.1;
      slots.push({ p: new THREE.Vector3(x + jitter, top + 0.05, z0 + spec.rowDepth * 0.42), rowF: r / Math.max(1, spec.rows - 1) });
    }
  }
  const depth = 0.3 + spec.rows * spec.rowDepth;
  const backH = top + (spec.roof ? 4.2 : 1.6);
  concrete.push(box(spec.len, backH, 0.35, 0, backH / 2, depth + 0.17));
  const cMesh = new THREE.Mesh(mergeGeometries(concrete), mats.concrete);
  cMesh.receiveShadow = true;
  g.add(cMesh);
  const sMesh = new THREE.Mesh(mergeGeometries(seats), mats.seat);
  g.add(sMesh);
  if (spec.roof) {
    // cantilever roof from the back wall; the front edge stops ~1m behind
    // the front row so it NEVER overhangs the pitch
    const roofD = depth - 0.9;
    const roofY = backH - 0.2;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(spec.len + 1, 0.28, roofD), mats.roof);
    roof.position.set(0, roofY, depth - roofD / 2 + 0.2);
    roof.rotation.x = -0.05;
    g.add(roof);
    // steel trusses under the roof
    const trusses: THREE.BufferGeometry[] = [];
    for (let x = -spec.len / 2 + 2; x <= spec.len / 2 - 2; x += 5) {
      trusses.push(box(0.18, 0.5, roofD, x, roofY - 0.4, depth - roofD / 2 + 0.2));
      const strut = new THREE.BoxGeometry(0.14, Math.hypot(roofD * 0.55, 2.8), 0.14);
      strut.rotateX(Math.atan2(roofD * 0.55, 2.8));
      strut.translate(x, roofY - 1.6, depth - roofD * 0.27);
      trusses.push(strut);
    }
    g.add(new THREE.Mesh(mergeGeometries(trusses), mats.steel));
    // fascia + lights strip along the roof's front edge
    const fascia = new THREE.Mesh(new THREE.BoxGeometry(spec.len + 1, 0.7, 0.2), mats.steel);
    fascia.position.set(0, roofY - 0.15, depth - roofD + 0.25);
    g.add(fascia);
  }
  return { group: g, slots };
}

// ---------------------------------------------------------------
// LED boards: generated ad reel, rotated like a real LED perimeter
// ---------------------------------------------------------------
function ledReel(): THREE.CanvasTexture {
  const panels = [
    { bg: '#0b3d91', fg: '#f8fafc', t: 'ELEVENS' },
    { bg: '#111827', fg: '#facc15', t: 'DRANZO TECHLABS' },
    { bg: '#15803d', fg: '#f8fafc', t: '5 v 5 ARENA' },
    { bg: '#b91c1c', fg: '#f8fafc', t: 'PLAY ON' },
    { bg: '#0f766e', fg: '#ecfeff', t: 'ONE PLAYER · ONE BODY' },
    { bg: '#f8fafc', fg: '#0f172a', t: 'ELEVENS ARENA' },
  ];
  const c = document.createElement('canvas');
  c.width = 512 * panels.length;
  c.height = 64;
  const g = c.getContext('2d')!;
  panels.forEach((p, i) => {
    const x = i * 512;
    const grad = g.createLinearGradient(x, 0, x, 64);
    grad.addColorStop(0, p.bg);
    grad.addColorStop(1, p.bg);
    g.fillStyle = grad;
    g.fillRect(x, 0, 512, 64);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    for (let s = 0; s < 512; s += 6) g.fillRect(x + s, 0, 1, 64); // LED pixel grid
    g.fillStyle = p.fg;
    g.font = '800 36px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(p.t, x + 256, 34, 480);
  });
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export function buildStadium(scene: THREE.Scene, opts: StadiumOpts): Stadium {
  const { L, W, night } = opts;
  const mats = {
    concrete: new THREE.MeshStandardMaterial({ color: night ? 0x6f757e : 0x9aa0a8, roughness: 0.95 }),
    seat: new THREE.MeshStandardMaterial({ color: 0x1f3a70, roughness: 0.55 }),
    roof: new THREE.MeshStandardMaterial({ color: 0x3b4455, roughness: 0.6, metalness: 0.3 }),
    steel: new THREE.MeshStandardMaterial({ color: 0x9aa3b2, roughness: 0.4, metalness: 0.7 }),
  };

  // ---- stands (+z away from the pitch in every local frame) ----
  const allSlots: { p: THREE.Vector3; team: number; rowF: number; roofed: boolean }[] = [];
  const place = (spec: StandSpec, x: number, z: number, rotY: number, team: number) => {
    const s = buildStand(spec, mats);
    s.group.position.set(x, 0, z);
    s.group.rotation.y = rotY;
    scene.add(s.group);
    s.group.updateMatrixWorld(true);
    for (const sl of s.slots) {
      allSlots.push({ p: sl.p.clone().applyMatrix4(s.group.matrixWorld), team, rowF: sl.rowF, roofed: !!spec.roof });
    }
  };
  // main stand (far side, covered)
  place({ len: L + 6, rows: 14, rowDepth: 0.8, rise: 0.42, frontWall: 1.3, roof: true }, 0, -(W / 2 + 4), Math.PI, 0);
  // near stand (behind the broadcast camera, kept low)
  place({ len: L + 6, rows: 7, rowDepth: 0.8, rise: 0.4, frontWall: 1.2 }, 0, W / 2 + 5.5, 0, 0);
  // ends: team-A fans behind the -x goal, team-B behind +x
  place({ len: W + 4, rows: 11, rowDepth: 0.8, rise: 0.44, frontWall: 1.3 }, -(L / 2 + 4.2), 0, -Math.PI / 2, 1);
  place({ len: W + 4, rows: 11, rowDepth: 0.8, rise: 0.44, frontWall: 1.3 }, L / 2 + 4.2, 0, Math.PI / 2, 2);

  // ---- the crowd: one instanced draw call ----
  const atlas = crowdAtlas(opts.teamColors);
  const cmat = crowdMaterial(atlas, night);
  const occupancy = 0.9;
  const fans = allSlots.filter(() => Math.random() < occupancy);
  const quad = new THREE.PlaneGeometry(1, 1);
  const crowd = new THREE.InstancedMesh(quad, cmat, fans.length);
  const card = new Float32Array(fans.length * 4);
  const teamAttr = new Float32Array(fans.length);
  const m4 = new THREE.Matrix4();
  fans.forEach((f, i) => {
    m4.makeTranslation(f.p.x, f.p.y, f.p.z);
    crowd.setMatrixAt(i, m4);
    let person: number;
    const r = Math.random();
    if (f.team === 1) person = r < 0.72 ? (Math.random() * 4) | 0 : 8 + ((Math.random() * 8) | 0);
    else if (f.team === 2) person = r < 0.72 ? 4 + ((Math.random() * 4) | 0) : 8 + ((Math.random() * 8) | 0);
    else person = r < 0.25 ? (Math.random() * 8) | 0 : 8 + ((Math.random() * 8) | 0);
    card[i * 4] = person;
    card[i * 4 + 1] = Math.random() * Math.PI * 2;
    card[i * 4 + 2] = Math.random();
    // back rows sit in the roof's shade; everyone varies a little
    const shadeK = f.roofed ? 1 - 0.38 * f.rowF : 1 - 0.12 * f.rowF;
    card[i * 4 + 3] = (0.8 + Math.random() * 0.24) * shadeK;
    // neutrals in the side stands still lean one way: 0 = neutral
    teamAttr[i] = f.team === 0 ? (person < 4 ? 1 : person < 8 ? 2 : 0) : f.team;
  });
  crowd.geometry = quad.clone();
  crowd.geometry.setAttribute('aCard', new THREE.InstancedBufferAttribute(card, 4));
  crowd.geometry.setAttribute('aTeam', new THREE.InstancedBufferAttribute(teamAttr, 1));
  crowd.frustumCulled = false; // billboards: bounds don't match the quad
  scene.add(crowd);

  // ---- floodlight towers ----
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x222222,
    emissive: new THREE.Color(0xfff4de),
    emissiveIntensity: night ? 9 : 0.15,
    roughness: 0.3,
  });
  const towerMat = new THREE.MeshStandardMaterial({ color: 0x8a93a3, roughness: 0.5, metalness: 0.6 });
  const glowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,248,230,1)');
    gr.addColorStop(0.18, 'rgba(255,240,210,0.55)');
    gr.addColorStop(1, 'rgba(255,240,210,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();
  for (const t of opts.towers) {
    const h = 19;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.42, h, 10), towerMat);
    pole.position.set(t.x, h / 2, t.z);
    scene.add(pole);
    const head = new THREE.Group();
    head.position.set(t.x, h + 1.2, t.z);
    head.lookAt(0, 0, 0);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.3, 0.35), towerMat);
    head.add(frame);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.46, 16), lampMat);
        lamp.position.set(-1.9 + c * 1.27, -1.05 + r * 1.05, 0.19);
        head.add(lamp);
      }
    }
    scene.add(head);
    if (night) {
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowTex, color: 0xfff1d6, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending, fog: false,
      }));
      glow.scale.set(16, 16, 1);
      glow.position.copy(head.position);
      scene.add(glow);
    }
  }

  // ---- LED perimeter boards ----
  const reel = ledReel();
  const boards: THREE.MeshStandardMaterial[] = [];
  const mkBoard = (x: number, z: number, len: number, rotY: number) => {
    const map = reel.clone();
    map.needsUpdate = true;
    // one 512px panel per ~7.4m keeps the lettering at true aspect
    map.repeat.set(len / 7.4 / 6, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a0a0a, emissive: 0xffffff, emissiveMap: map,
      emissiveIntensity: night ? 1.25 : 0.95, roughness: 0.5,
    });
    boards.push(mat);
    const b = new THREE.Mesh(new THREE.BoxGeometry(len, 0.92, 0.18), mat);
    b.position.set(x, 0.46, z);
    b.rotation.y = rotY;
    scene.add(b);
  };
  mkBoard(0, -(W / 2 + 2.2), L + 3, 0);
  mkBoard(0, W / 2 + 2.2, L + 3, Math.PI);
  mkBoard(-(L / 2 + 2.6), 0, W + 3, Math.PI / 2);
  mkBoard(L / 2 + 2.6, 0, W + 3, -Math.PI / 2);

  // ---- dugouts (near side, behind the boards) ----
  for (const dx of [-7, 7]) {
    const shel = new THREE.Group();
    const shell = new THREE.MeshStandardMaterial({ color: 0x1c2740, roughness: 0.35, metalness: 0.2 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fb4d0, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.35 });
    const back = new THREE.Mesh(new THREE.BoxGeometry(5, 1.7, 0.12), shell);
    back.position.set(0, 0.85, 0.7);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(5, 0.08, 1.6), glass);
    roof.position.set(0, 1.72, 0);
    const bench = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.45, 0.5), new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.6 }));
    bench.position.set(0, 0.3, 0.4);
    shel.add(back, roof, bench);
    shel.position.set(dx, 0, W / 2 + 3.4);
    scene.add(shel);
  }

  // ---- corner flags ----
  for (const [cx, cz] of [[-L / 2, -W / 2], [L / 2, -W / 2], [-L / 2, W / 2], [L / 2, W / 2]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.5, 6), new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 }));
    pole.position.set(cx, 0.75, cz);
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.26), new THREE.MeshStandardMaterial({ color: 0xfacc15, side: THREE.DoubleSide, roughness: 0.8 }));
    flag.position.set(cx + 0.19, 1.34, cz);
    scene.add(pole, flag);
  }

  // ---- animation state ----
  let t = 0;
  let jumpA = 0, jumpB = 0;
  let excite = 0.3;
  let reelPos = 0, reelTarget = 0, reelHold = 0;
  return {
    update(dt: number, ex: number) {
      t += dt;
      excite += (ex - excite) * (1 - Math.exp(-2 * dt));
      jumpA = Math.max(0, jumpA - dt / 5.5);
      jumpB = Math.max(0, jumpB - dt / 5.5);
      const u = cmat.uniforms;
      u.uTime.value = t;
      u.uExcite.value = excite;
      u.uJumpA.value = Math.min(1, jumpA * 1.4);
      u.uJumpB.value = Math.min(1, jumpB * 1.4);
      // LED reel: hold an ad ~6s, then a quick wipe to the next one
      reelHold += dt;
      if (reelHold > 6) { reelHold = 0; reelTarget += 1 / 6; }
      reelPos += (reelTarget - reelPos) * (1 - Math.exp(-9 * dt));
      for (const b of boards) if (b.emissiveMap) b.emissiveMap.offset.x = reelPos;
    },
    celebrate(team: 0 | 1) {
      if (team === 0) jumpA = 1; else jumpB = 1;
    },
  };
}
