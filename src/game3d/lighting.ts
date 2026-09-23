// ============================================================
// LIGHTING — physically-based sky + image-based lighting (IBL).
//
// The single biggest step toward a broadcast look: every PBR surface (kits,
// ball, grass, stands) is now lit by the SKY it sits under, not a flat
// hemisphere. The sky is rendered once into a crisp cube background and a
// prefiltered PMREM environment, so it costs nothing per frame.
//
// Times of day:
//   day    — high warm sun, blue sky, crisp shadows
//   sunset — low golden sun, long shadows, amber sky
//   night  — dark sky, floodlights: a high key light for short shadows plus
//            an environment full of lamp banks, so kits and the ball pick up
//            the floodlight glints you see on TV
// ============================================================
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

export type TimeOfDay = 'day' | 'sunset' | 'night';

export interface LightRig {
  tod: TimeOfDay;
  /** key light: the sun (day/sunset) or the main floodlight bank (night) */
  key: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  /** floodlight tower positions (for lamp glow + night contact shadows) */
  towers: THREE.Vector3[];
  floodlightsOn: boolean;
}

export function readTimeOfDay(): TimeOfDay {
  const q = new URLSearchParams(location.search).get('tod');
  let saved: string | null = null;
  try { saved = localStorage.getItem('elevens-tod'); } catch { /* private mode */ }
  const v = q ?? saved ?? 'night';
  return v === 'day' || v === 'sunset' || v === 'night' ? v : 'night';
}

export function saveTimeOfDay(t: TimeOfDay) {
  try { localStorage.setItem('elevens-tod', t); } catch { /* private mode */ }
}

const PRESETS = {
  day: {
    elevation: 50, azimuth: 205,
    turbidity: 2.6, rayleigh: 1.1, mie: 0.004, mieG: 0.78, clouds: 0.28,
    keyColor: 0xfff1dc, keyIntensity: 2.6, hemiSky: 0xbfdcff, hemiGround: 0x3b6b2c, hemiIntensity: 0.35,
    envIntensity: 0.9, exposure: 0.95, fog: 0xbcd6ea, fogNear: 90, fogFar: 320,
  },
  sunset: {
    elevation: 9, azimuth: 235,
    turbidity: 6.5, rayleigh: 2.6, mie: 0.006, mieG: 0.86, clouds: 0.38,
    keyColor: 0xffb271, keyIntensity: 2.4, hemiSky: 0xf2c49b, hemiGround: 0x3a4f25, hemiIntensity: 0.4,
    envIntensity: 0.85, exposure: 1.0, fog: 0xd9a47e, fogNear: 80, fogFar: 300,
  },
  night: {
    elevation: -4.5, azimuth: 205,
    turbidity: 8, rayleigh: 3.2, mie: 0.005, mieG: 0.8, clouds: 0.18,
    keyColor: 0xf2f6ff, keyIntensity: 2.25, hemiSky: 0x6d7fa6, hemiGround: 0x243a22, hemiIntensity: 0.32,
    envIntensity: 1.0, exposure: 1.08, fog: 0x0b1224, fogNear: 70, fogFar: 260,
  },
} as const;

export function buildLighting(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  opts: { tod: TimeOfDay; shadows: boolean; L: number; W: number; hiRes: boolean },
): LightRig {
  const P = PRESETS[opts.tod];
  const { L, W } = opts;

  // ---- the sky, captured once ----
  const skyScene = new THREE.Scene();
  const sky = new Sky();
  sky.scale.setScalar(900);
  const u = sky.material.uniforms;
  u.turbidity.value = P.turbidity;
  u.rayleigh.value = P.rayleigh;
  u.mieCoefficient.value = P.mie;
  u.mieDirectionalG.value = P.mieG;
  if (u.cloudCoverage) u.cloudCoverage.value = P.clouds;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - P.elevation),
    THREE.MathUtils.degToRad(P.azimuth),
  );
  u.sunPosition.value.copy(sunDir);
  skyScene.add(sky);

  if (opts.tod === 'night') {
    // stars: a dome of faint points above the stadium glow
    const n = 1400;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(1 - Math.random() * 0.85); // upper hemisphere bias
      const r = 800;
      pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.cos(ph);
      pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const stars = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0xdfe8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.75, fog: false,
    }));
    skyScene.add(stars);
  }

  // crisp background: cube capture of the sky (no depth-range issues, and
  // the sky never needs to be re-rendered)
  const bgRT = new THREE.WebGLCubeRenderTarget(opts.hiRes ? 1024 : 512, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(1, 2000, bgRT);
  cubeCam.update(renderer, skyScene);
  scene.background = bgRT.texture;

  // ---- environment for IBL: sky + grass bounce (+ floodlight banks) ----
  const envScene = new THREE.Scene();
  envScene.add(sky.clone());
  // lower hemisphere = the pitch: green bounce light onto everything
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(600, 32),
    new THREE.MeshBasicMaterial({ color: opts.tod === 'night' ? 0x16391a : 0x2f6b2c }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -2;
  envScene.add(ground);
  // the stands: a dark ring around the horizon (a stadium, not open desert)
  const ring = new THREE.Mesh(
    new THREE.CylinderGeometry(120, 120, 60, 48, 1, true),
    new THREE.MeshBasicMaterial({ color: opts.tod === 'night' ? 0x0c1018 : 0x3a4250, side: THREE.BackSide }),
  );
  ring.position.y = 18;
  envScene.add(ring);

  const towers = [
    new THREE.Vector3(-L / 2 - 7, 16, -W / 2 - 8),
    new THREE.Vector3(L / 2 + 7, 16, -W / 2 - 8),
    new THREE.Vector3(-L / 2 - 7, 16, W / 2 + 8),
    new THREE.Vector3(L / 2 + 7, 16, W / 2 + 8),
  ];
  if (opts.tod === 'night') {
    // floodlight banks as hot emitters in the environment: kits, the ball
    // and the goal frame all catch those unmistakable lamp glints
    const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff6e0).multiplyScalar(14) });
    for (const t of towers) {
      const bank = new THREE.Mesh(new THREE.PlaneGeometry(18, 7), lampMat);
      bank.position.copy(t).multiplyScalar(3.2);
      bank.position.y = 48;
      bank.lookAt(0, 0, 0);
      envScene.add(bank);
    }
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(envScene, 0.02, 0.1, 3000);
  scene.environment = envRT.texture;
  scene.environmentIntensity = P.envIntensity;
  pmrem.dispose();

  scene.fog = new THREE.Fog(P.fog, P.fogNear, P.fogFar);
  renderer.toneMappingExposure = P.exposure;

  // ---- direct lights ----
  const hemi = new THREE.HemisphereLight(P.hemiSky, P.hemiGround, P.hemiIntensity);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(P.keyColor, P.keyIntensity);
  if (opts.tod === 'night') {
    // floodlights sit high above all four corners: the combined key comes
    // almost straight down (short shadows) with a slight main-stand bias
    key.position.set(-4, 42, 9);
  } else {
    key.position.copy(sunDir).multiplyScalar(60);
  }
  key.castShadow = opts.shadows;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.radius = opts.tod === 'night' ? 6 : 3.5;
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.025;
  // frustum sized to the pitch + a margin; long sunset shadows need depth
  Object.assign(key.shadow.camera, {
    left: -L / 2 - 8, right: L / 2 + 8, top: W / 2 + 10, bottom: -W / 2 - 10,
    near: 1, far: 160,
  });
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);
  scene.add(key.target);

  return { tod: opts.tod, key, hemi, towers, floodlightsOn: opts.tod === 'night' || opts.tod === 'sunset' };
}
