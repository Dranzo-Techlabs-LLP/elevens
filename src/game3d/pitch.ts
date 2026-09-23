// ============================================================
// PITCH — broadcast turf.
//
// What sells real grass on TV, and what this reproduces:
//  1. MOW STRIPES ARE VIEW-DEPENDENT. They exist because alternate bands of
//     blades lean in opposite directions; a band leaning away from the lens
//     shows its sunlit blade sides and reads lighter. So stripes are computed
//     in the shader from the camera direction — they shift and breathe as the
//     broadcast camera pans, exactly like a real match feed.
//  2. BLADE DETAIL at close range: a tiling procedural grass texture modulates
//     the albedo, and its derived normal map breaks up the lighting.
//  3. WEAR: goalmouths, the penalty spots and the center circle are scuffed
//     paler — a pristine pitch looks like a render, a worn one looks played on.
//  4. Markings stay razor-sharp in a high-res albedo (regulation geometry).
// ============================================================
import * as THREE from 'three';

export interface PitchOpts {
  L: number;
  W: number;
  hiRes: boolean;
  night: boolean;
  anisotropy: number;
}

/** tileable grass blade texture + its normal map (both generated, no assets) */
function grassDetail(size: number): { albedo: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = '#808080';
  g.fillRect(0, 0, size, size);
  // blades: short near-upright strokes, drawn with wrap so the tile is seamless
  const blades = size * size / 34;
  for (let i = 0; i < blades; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 3 + Math.random() * 7;
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 0.9;
    const v = 70 + Math.random() * 120;
    g.strokeStyle = `rgb(${v},${v},${v})`;
    g.lineWidth = 0.8 + Math.random() * 1.1;
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const bx = x + ox, by = y + oy;
        if (bx < -12 || bx > size + 12 || by < -12 || by > size + 12) continue;
        g.beginPath();
        g.moveTo(bx, by);
        g.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
        g.stroke();
      }
    }
  }
  const albedo = new THREE.CanvasTexture(c);
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping;
  albedo.colorSpace = THREE.NoColorSpace; // used as a luminance modulator

  // normal map from the luminance height field (Sobel)
  const src = g.getImageData(0, 0, size, size).data;
  const h = (x: number, y: number) => src[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  const n = document.createElement('canvas');
  n.width = n.height = size;
  const ng = n.getContext('2d')!;
  const img = ng.createImageData(size, size);
  const strength = 2.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (h(x + 1, y - 1) + 2 * h(x + 1, y) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x - 1, y) + h(x - 1, y + 1));
      const dy = (h(x - 1, y + 1) + 2 * h(x, y + 1) + h(x + 1, y + 1)) - (h(x - 1, y - 1) + 2 * h(x, y - 1) + h(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength;
      const nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l;
      const o = (y * size + x) * 4;
      img.data[o] = (nx * 0.5 + 0.5) * 255;
      img.data[o + 1] = (ny * 0.5 + 0.5) * 255;
      img.data[o + 2] = (nz / l * 0.5 + 0.5) * 255;
      img.data[o + 3] = 255;
    }
  }
  ng.putImageData(img, 0, 0);
  const normal = new THREE.CanvasTexture(n);
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping;
  normal.colorSpace = THREE.NoColorSpace;
  return { albedo, normal };
}

/** base color + wear + regulation markings, drawn in meter space */
function pitchAlbedo(opts: PitchOpts): HTMLCanvasElement {
  const { L, W } = opts;
  const w = opts.hiRes ? 4096 : 2048;
  const h = w / 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const tx = c.getContext('2d')!;
  const S = w / L;
  const mm = (m: number) => m * S;

  tx.fillStyle = '#2f8a3a';
  tx.fillRect(0, 0, w, h);
  // large-scale color variation — no two square meters of real turf match
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * w, y = Math.random() * h, r = mm(1 + Math.random() * 3.5);
    const g = tx.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() < 0.5;
    g.addColorStop(0, dark ? 'rgba(10,50,10,0.06)' : 'rgba(170,220,120,0.035)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    tx.fillStyle = g;
    tx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // WEAR: goalmouths (heaviest), penalty spots, center circle
  const wear = (cx: number, cy: number, rx: number, ry: number, a: number) => {
    for (let i = 0; i < 70; i++) {
      const x = cx + (Math.random() - 0.5) * rx * 2;
      const y = cy + (Math.random() - 0.5) * ry * 2;
      const r = mm(0.2 + Math.random() * 0.55);
      const g = tx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(128,132,84,${a * (0.5 + Math.random() * 0.5)})`);
      g.addColorStop(1, 'rgba(128,132,84,0)');
      tx.fillStyle = g;
      tx.fillRect(x - r, y - r, r * 2, r * 2);
    }
  };
  const spot = (11 / 105) * L;
  wear(mm(1.0), h / 2, mm(1.1), mm(1.9), 0.16);
  wear(w - mm(1.0), h / 2, mm(1.1), mm(1.9), 0.16);
  wear(mm(spot), h / 2, mm(0.5), mm(0.6), 0.10);
  wear(w - mm(spot), h / 2, mm(0.5), mm(0.6), 0.10);
  wear(w / 2, h / 2, mm(1.2), mm(1.2), 0.06);

  // ---- REGULATION MARKINGS, proportions of 105x68 scaled to L x W ----
  const LINE = mm(0.12);
  tx.strokeStyle = 'rgba(246,248,242,0.95)';
  tx.fillStyle = 'rgba(246,248,242,0.95)';
  tx.lineWidth = LINE;
  tx.lineCap = 'butt';
  const PEN_DEPTH = (16.5 / 105) * L;
  const PEN_WIDTH = (40.3 / 68) * W;
  const SIX_DEPTH = (5.5 / 105) * L;
  const SIX_WIDTH = (18.3 / 68) * W;
  const CIRC_R = (9.15 / 105) * L;
  const CORNER_R = 0.6;
  const inset = LINE / 2 + 1;
  tx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  tx.beginPath(); tx.moveTo(w / 2, inset); tx.lineTo(w / 2, h - inset); tx.stroke();
  tx.beginPath(); tx.arc(w / 2, h / 2, mm(CIRC_R), 0, Math.PI * 2); tx.stroke();
  tx.beginPath(); tx.arc(w / 2, h / 2, mm(0.12), 0, Math.PI * 2); tx.fill();
  for (const side of [0, 1]) {
    const dir = side === 0 ? 1 : -1;
    const gl = side === 0 ? inset : w - inset;
    tx.strokeRect(side === 0 ? gl : gl - mm(PEN_DEPTH), h / 2 - mm(PEN_WIDTH) / 2, mm(PEN_DEPTH), mm(PEN_WIDTH));
    tx.strokeRect(side === 0 ? gl : gl - mm(SIX_DEPTH), h / 2 - mm(SIX_WIDTH) / 2, mm(SIX_DEPTH), mm(SIX_WIDTH));
    const spotX = gl + dir * mm(spot);
    tx.beginPath(); tx.arc(spotX, h / 2, mm(0.12), 0, Math.PI * 2); tx.fill();
    const a = Math.acos(Math.min(1, Math.max(-1, (PEN_DEPTH - spot) / CIRC_R)));
    tx.beginPath();
    if (side === 0) tx.arc(spotX, h / 2, mm(CIRC_R), -a, a);
    else tx.arc(spotX, h / 2, mm(CIRC_R), Math.PI - a, Math.PI + a);
    tx.stroke();
  }
  const cr = mm(CORNER_R);
  tx.beginPath(); tx.arc(inset, inset, cr, 0, Math.PI / 2); tx.stroke();
  tx.beginPath(); tx.arc(w - inset, inset, cr, Math.PI / 2, Math.PI); tx.stroke();
  tx.beginPath(); tx.arc(w - inset, h - inset, cr, Math.PI, Math.PI * 1.5); tx.stroke();
  tx.beginPath(); tx.arc(inset, h - inset, cr, Math.PI * 1.5, Math.PI * 2); tx.stroke();
  // chalk is never vector-perfect: speckle the paint slightly
  tx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < w * 3; i++) {
    tx.fillStyle = `rgba(0,0,0,${Math.random() * 0.18})`;
    tx.fillRect(Math.random() * w, Math.random() * h, 1.5, 1.5);
  }
  tx.globalCompositeOperation = 'source-over';
  // re-lay the green under the speckles we just punched out
  tx.globalCompositeOperation = 'destination-over';
  tx.fillStyle = '#2f8a3a';
  tx.fillRect(0, 0, w, h);
  tx.globalCompositeOperation = 'source-over';
  return c;
}

/** turf material with view-dependent stripes + blade detail */
function turfMaterial(map: THREE.Texture | null, detail: ReturnType<typeof grassDetail>, opts: {
  L: number; W: number; stripes: boolean; color?: number; night: boolean;
}) {
  const mat = new THREE.MeshStandardMaterial({
    map: map ?? undefined,
    color: opts.color ?? 0xffffff,
    roughness: 0.93,
    metalness: 0,
    normalMap: detail.normal,
    normalScale: new THREE.Vector2(0.55, 0.55),
  });
  // detail normal tiles on its own UV channel (uv1 = world-scale tiling)
  detail.normal.channel = 1;
  const uniforms = {
    uDetail: { value: detail.albedo },
    uHalf: { value: new THREE.Vector2(opts.L / 2, opts.W / 2) },
    uBand: { value: opts.L / 10 },
    uStripes: { value: opts.stripes ? 1 : 0 },
    uNight: { value: opts.night ? 1 : 0 },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTurfWorld;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvTurfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vTurfWorld;
         uniform sampler2D uDetail;
         uniform vec2 uHalf;
         uniform float uBand, uStripes, uNight;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          // blade detail: two scales so tiling never reads as a pattern
          float d1 = texture2D(uDetail, vTurfWorld.xz / 1.35).r;
          float d2 = texture2D(uDetail, vTurfWorld.xz / 5.7 + 0.37).r;
          float dd = d1 * 0.65 + d2 * 0.35;
          diffuseColor.rgb *= mix(0.82, 1.16, dd);

          vec3 V = normalize(cameraPosition - vTurfWorld);
          if (uStripes > 0.5) {
            // lengthwise-mowed bands: blades in alternate bands lean toward
            // +z / -z; the band leaning AWAY from the lens reads lighter
            float band = floor((vTurfWorld.x + uHalf.x) / uBand);
            float lean = mod(band, 2.0) < 1.0 ? 1.0 : -1.0;
            float s = -lean * V.z;
            diffuseColor.rgb *= 1.0 + 0.13 * s;
            // faint cross-mow (checkerboard) from the widthwise pass
            float band2 = floor((vTurfWorld.z + uHalf.y) / (uBand * 1.25));
            float lean2 = mod(band2, 2.0) < 1.0 ? 1.0 : -1.0;
            diffuseColor.rgb *= 1.0 + 0.035 * lean2 * (0.6 + 0.4 * abs(V.x));
          }
          // grazing sheen: turf goes silvery-yellow toward the horizon
          float graze = pow(1.0 - clamp(V.y, 0.0, 1.0), 3.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.10, 0.86), graze * (uNight > 0.5 ? 0.25 : 0.55));
        }`,
      );
  };
  return mat;
}

export function buildPitch(scene: THREE.Scene, opts: PitchOpts) {
  const { L, W } = opts;
  const detail = grassDetail(opts.hiRes ? 512 : 256);
  detail.albedo.anisotropy = opts.anisotropy;
  detail.normal.anisotropy = opts.anisotropy;

  const albedo = new THREE.CanvasTexture(pitchAlbedo(opts));
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.anisotropy = opts.anisotropy; // grazing broadcast angle: keep the far lines crisp

  const geo = new THREE.PlaneGeometry(L, W, 1, 1);
  // uv1: world-scale tiling for the detail normal (one tile per ~1.35m)
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const uv1 = new Float32Array(uv.count * 2);
  for (let i = 0; i < uv.count; i++) {
    uv1[i * 2] = uv.getX(i) * (L / 1.35);
    uv1[i * 2 + 1] = uv.getY(i) * (W / 1.35);
  }
  geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  const pitch = new THREE.Mesh(geo, turfMaterial(albedo, detail, { L, W, stripes: true, night: opts.night }));
  pitch.rotation.x = -Math.PI / 2;
  pitch.receiveShadow = true;
  scene.add(pitch);

  // surround: same turf, darker, unmarked, no stripes
  const aw = 140, ah = 110;
  const ageo = new THREE.PlaneGeometry(aw, ah, 1, 1);
  const auv = ageo.getAttribute('uv') as THREE.BufferAttribute;
  const auv1 = new Float32Array(auv.count * 2);
  for (let i = 0; i < auv.count; i++) {
    auv1[i * 2] = auv.getX(i) * (aw / 1.35);
    auv1[i * 2 + 1] = auv.getY(i) * (ah / 1.35);
  }
  ageo.setAttribute('uv1', new THREE.BufferAttribute(auv1, 2));
  const apron = new THREE.Mesh(
    ageo,
    turfMaterial(null, detail, { L, W, stripes: false, color: 0x2a6a2c, night: opts.night }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.015;
  apron.receiveShadow = true;
  scene.add(apron);
  return { pitch, apron };
}
