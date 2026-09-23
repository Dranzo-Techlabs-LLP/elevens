// ============================================================
// MATCH BALL — a modern thermo-bonded six-panel ball, generated.
//
// The panel layout is computed per texel from the 3D direction on the
// sphere (each panel = one cube face, seams where the two largest
// components meet), so the equirect texture wraps seamlessly with no pole
// pinching artifacts on the pattern. Swoosh graphics on each panel make the
// spin readable at broadcast distance; the seams become grooves via a bump
// map, and a clearcoat gives the glossy PU skin its floodlight highlight.
// ============================================================
import * as THREE from 'three';

export function buildBall(radius: number, hiRes: boolean): THREE.Mesh {
  const W = hiRes ? 1024 : 512;
  const H = W / 2;
  const col = document.createElement('canvas');
  col.width = W; col.height = H;
  const bump = document.createElement('canvas');
  bump.width = W; bump.height = H;
  const cg = col.getContext('2d')!;
  const bg = bump.getContext('2d')!;
  const ci = cg.createImageData(W, H);
  const bi = bg.createImageData(W, H);
  // panel palettes: navy/orange/teal swooshes on white
  const swoosh = [
    [22, 36, 88], [242, 112, 36], [18, 150, 140],
    [22, 36, 88], [242, 112, 36], [18, 150, 140],
  ];
  for (let y = 0; y < H; y++) {
    const th = (y + 0.5) / H * Math.PI;           // polar
    const st = Math.sin(th), ct = Math.cos(th);
    for (let x = 0; x < W; x++) {
      const ph = (x + 0.5) / W * Math.PI * 2;     // azimuth
      const dx = st * Math.cos(ph), dy = ct, dz = st * Math.sin(ph);
      const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
      // dominant axis = panel; second-largest gap = distance to the seam
      let face: number, m: number, a: number, b: number;
      if (ax >= ay && ax >= az) { face = dx > 0 ? 0 : 1; m = ax; a = dy / ax; b = dz / ax; }
      else if (ay >= az) { face = dy > 0 ? 2 : 3; m = ay; a = dx / ay; b = dz / ay; }
      else { face = dz > 0 ? 4 : 5; m = az; a = dx / az; b = dy / az; }
      const second = Math.max(...[ax, ay, az].filter((v) => v !== m), 0);
      const seamD = m - second; // 0 on the seam
      let r = 246, g = 246, bl = 244;
      // curved swoosh across each panel (rotated per face for variety)
      const u = face % 2 ? a : b, v = face % 2 ? b : a;
      const curveD = Math.abs(v - (u * u * 0.9 - 0.35));
      if (curveD < 0.16) {
        const s = swoosh[face];
        const k = curveD < 0.11 ? 1 : (0.16 - curveD) / 0.05;
        r = r + (s[0] - r) * k; g = g + (s[1] - g) * k; bl = bl + (s[2] - bl) * k;
      }
      // thin pinstripe echoing the swoosh
      if (Math.abs(curveD - 0.22) < 0.018) { r *= 0.55; g *= 0.55; bl *= 0.6; }
      // seam groove: dark line + bump trough
      let h = 255;
      if (seamD < 0.018) {
        const k = seamD / 0.018;
        r *= 0.35 + 0.65 * k; g *= 0.35 + 0.65 * k; bl *= 0.35 + 0.65 * k;
        h = 80 + 175 * k;
      }
      const o = (y * W + x) * 4;
      ci.data[o] = r; ci.data[o + 1] = g; ci.data[o + 2] = bl; ci.data[o + 3] = 255;
      bi.data[o] = bi.data[o + 1] = bi.data[o + 2] = h; bi.data[o + 3] = 255;
    }
  }
  cg.putImageData(ci, 0, 0);
  bg.putImageData(bi, 0, 0);
  const map = new THREE.CanvasTexture(col);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 4;
  const bumpMap = new THREE.CanvasTexture(bump);
  bumpMap.colorSpace = THREE.NoColorSpace;
  const mat = new THREE.MeshPhysicalMaterial({
    map,
    bumpMap,
    bumpScale: 1.2,
    roughness: 0.38,
    clearcoat: 0.75,
    clearcoatRoughness: 0.18,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 28), mat);
  return mesh;
}
