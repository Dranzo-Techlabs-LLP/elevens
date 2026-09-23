// ============================================================
// REAL RIGGED CHARACTERS — Quaternius Universal Animation Library (CC0).
//
// One skinned body + 43 mocap-class clips; the skeleton is cloned per player
// and driven by a locomotion blend tree (idle/walk/jog/sprint) with
// cadence-synced playback and crossfades.
//
// ON TOP of the clips sits a procedural MOTION LAYER that authors football
// technique the clip library doesn't have. Every action is a set of keyed
// curves per bone, applied after the mixer as rotations about TRUE body axes
// (native model space: +Z forward, +X left, +Y up), re-derived each frame
// from the bone's parent orientation — so a strike reads correctly whatever
// the legs were doing underneath:
//   shot / pass / through / lob / volley — plant leg flexes, hips open on
//     the backswing and drive through, the torso counter-rotates, the far
//     arm swings out for balance, head down over the ball, follow-through
//   header — leap clip + neck cocked back then snapped through the ball
//   touch — the little dribble prods while running with the ball
//   tackle, throw-in (hold overhead -> whip), goal celebration
// Continuous layers: momentum lean (accelerating = forward), sprint lean,
// jockey/shield stance (knees bent, arms wide), head tracking the ball.
// Players are left- or right-footed; left-footers are mirrored.
// ============================================================
import * as THREE from 'three';
import { GLTFLoader, SkeletonUtils } from 'three-stdlib';
const skeletonClone = (o: THREE.Object3D) => SkeletonUtils.clone(o) as THREE.Group;

const CLIP_NAMES = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  jog: 'Jog_Fwd_Loop',
  sprint: 'Sprint_Loop',
  stun: 'Hit_Chest',
  // real action clips (all in the CC0 UAL pack):
  roll: 'Roll',                 // keeper dive = committed body roll
  pickup: 'PickUp_Table',       // keeper gathering a ground ball
  punch: 'Punch_Cross',         // keeper parry — fists the ball away
  ready: 'Crouch_Idle_Loop',    // keeper set stance, knees bent, ready
  leap: 'Jump_Start',           // header: attack the ball in the air
} as const;

// nominal ground speed each loop was authored at (m/s) — playback timeScale
// is speed/nominal so the feet track the ground at any velocity
const NOMINAL: Record<string, number> = { walk: 1.5, jog: 3.5, sprint: 7.4 };

let gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] } | null = null;

// empirically calibrated: which way the mannequin's mesh faces relative to
// our yaw=0 (+x). Live-adjustable from the console for calibration:
//   window.__modelYaw(value)
let MODEL_YAW = Math.PI / 2;
const liveModels: THREE.Object3D[] = [];
export function setModelYawOffset(v: number) {
  MODEL_YAW = v;
  for (const m of liveModels) m.rotation.y = v;
}
if (typeof window !== 'undefined') (window as any).__modelYaw = setModelYawOffset;

export async function loadChars(url = '/assets/chars/UAL1.glb'): Promise<boolean> {
  try {
    gltf = (await new GLTFLoader().loadAsync(url)) as any;
    return true;
  } catch (e) {
    console.warn('chars: GLB load failed, falling back to procedural rigs', e);
    return false;
  }
}
export const charsReady = () => !!gltf;

// ---------------------------------------------------------------
// KIT SHADER: the body is one mesh, so the kit is painted in the shader from
// BIND-POSE coordinates (the bind pose never changes, so every zone deforms
// perfectly with the animation):
//   boots (+ accent sole) -> socks (+ stripe) -> skin -> shorts -> jersey
//   (collar, sleeve cuffs, chest crest, NAME + NUMBER printed on the back)
//   -> skin/face (brows, mouth, stubble) -> hair
// Each zone also gets its own roughness: glossy boots, satin shorts, matte
// socks, skin with a soft sheen.
// ---------------------------------------------------------------
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xba8a63];
const HAIRS = [0x1c1512, 0x3b2a1a, 0x0d0d0d, 0x5b3b1a, 0x62514a];
const BOOT_ACCENTS = [0xf8fafc, 0x84cc16, 0xf97316, 0xec4899, 0x22d3ee, 0xfacc15];

export type KitTeam = 'A' | 'B' | 'REF';

export interface KitOpts {
  number?: number;   // shirt number printed on the back
  name?: string;     // surname printed above the number
}

/** back print: name arched over a big number, like a real shirt */
function backPrint(num: number, name: string, dark: boolean): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 256, 256);
  const fill = dark ? '#0f172a' : '#f8fafc';
  const edge = dark ? 'rgba(248,250,252,0.55)' : 'rgba(15,23,42,0.55)';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (name) {
    g.font = '800 34px system-ui, sans-serif';
    g.lineWidth = 3;
    g.strokeStyle = edge;
    g.fillStyle = fill;
    const t = name.toUpperCase().slice(0, 10);
    g.strokeText(t, 128, 40, 230);
    g.fillText(t, 128, 40, 230);
  }
  g.font = '900 150px system-ui, sans-serif';
  g.lineWidth = 7;
  g.strokeStyle = edge;
  g.strokeText(String(num), 128, 158, 230);
  g.fillStyle = fill;
  g.fillText(String(num), 128, 158, 230);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeKitMaterial(team: KitTeam, bindH: number, seed: number, keeper: boolean, kit: KitOpts) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.7 });
  // referees wear all-black; KEEPERS wear a distinct kit (amber / emerald)
  // with white gloves — you must be able to pick him out at a glance
  let jersey = team === 'A' ? 0x2563eb : team === 'B' ? 0xdc2626 : 0x141417;
  let shorts = team === 'A' ? 0x0f2557 : team === 'B' ? 0x5c1212 : 0x101013;
  let socks = team === 'A' ? 0x2563eb : team === 'B' ? 0xdc2626 : 0x141417;
  let trim = team === 'REF' ? 0xfacc15 : 0xf8fafc;
  if (keeper && team !== 'REF') {
    jersey = team === 'A' ? 0xf59e0b : 0x10b981;
    shorts = 0x1f2937;
    socks = jersey;
    trim = 0x111827;
  }
  const s = Math.abs(seed);
  const printDark = keeper; // light keeper shirts take a dark print
  const uniforms = {
    uTeam: { value: new THREE.Color(jersey) },
    uShorts: { value: new THREE.Color(shorts) },
    uSock: { value: new THREE.Color(socks) },
    uTrim: { value: new THREE.Color(trim) },
    uSkin: { value: new THREE.Color(SKINS[s % SKINS.length]) },
    uHair: { value: new THREE.Color(HAIRS[(s >> 2) % HAIRS.length]) },
    uBoot: { value: new THREE.Color(BOOT_ACCENTS[(s >> 3) % BOOT_ACCENTS.length]) },
    uH: { value: bindH },
    uGlove: { value: keeper ? 1 : 0 },
    uStubble: { value: (s >> 5) % 3 === 0 ? 1 : 0 },
    uBack: { value: kit.number ? backPrint(kit.number, kit.name ?? '', printDark) : null },
    uHasBack: { value: kit.number ? 1 : 0 },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', 'vBind = position;\n#include <begin_vertex>');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vBind;
         uniform vec3 uTeam, uShorts, uSock, uTrim, uSkin, uHair, uBoot;
         uniform float uH, uGlove, uStubble, uHasBack;
         uniform sampler2D uBack;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float kitRough = 0.7;
        {
          float f = vBind.y / uH;           // 0 feet .. 1 head top
          float armR = length(vBind.xz);    // T-pose: arms reach sideways
          vec3 kit = uSkin;
          kitRough = 0.5;
          if (f < 0.045) {
            // boots: glossy, with an accent sole + stripe
            kit = f < 0.012 ? uBoot : (f > 0.028 && f < 0.034 ? uBoot : vec3(0.05));
            kitRough = 0.22;
          } else if (f < 0.16) {
            kit = (f > 0.128 && f < 0.142) ? uTrim : uSock;  // sock stripe
            kitRough = 0.85;
          } else if (f < 0.47) {
            kit = uSkin;
          } else if (f < 0.60) {
            kit = uShorts;
            kitRough = 0.5;                                  // satin shorts
          } else if (f < 0.855) {
            // torso band: shirt, bare forearms/hands (short sleeves)
            bool arm = armR > uH * 0.34 && f > 0.72;
            kit = arm ? uSkin : uTeam;
            kitRough = arm ? 0.5 : 0.66;
            // sleeve cuff + collar in the trim color
            if (!arm && armR > uH * 0.318 && f > 0.72) kit = uTrim;
            if (f > 0.838 && armR < uH * 0.1) kit = uTrim;
            // chest crest (player's left breast = +x)
            if (vBind.z > 0.02 * uH && distance(vec2(vBind.x / uH, f), vec2(0.045, 0.785)) < 0.016)
              kit = uTrim;
            // name + number printed on the back
            if (uHasBack > 0.5 && vBind.z < -0.02 * uH && abs(vBind.x) < 0.1 * uH && f > 0.62 && f < 0.83) {
              vec2 bu = vec2(0.5 - vBind.x / (0.2 * uH), (f - 0.62) / 0.21);
              vec4 pr = texture2D(uBack, bu);
              kit = mix(kit, pr.rgb, pr.a);
            }
            // KEEPER GLOVES: white from the wrists out (hands are the
            // farthest points from the spine in the T-pose)
            if (uGlove > 0.5 && armR > uH * 0.435 && f > 0.72) { kit = vec3(0.93); kitRough = 0.7; }
          } else {
            // head zone
            kit = uSkin;
            kitRough = 0.48;
            bool front = vBind.z > 0.02 * uH;
            // hair: crown + back of the skull
            if (f > 0.935 || (f > 0.90 && vBind.z < -0.005)) { kit = uHair; kitRough = 0.42; }
            // stubble / beard on some players
            if (uStubble > 0.5 && front && f > 0.875 && f < 0.905) kit = mix(kit, uHair, 0.45);
            // eyes, brows, mouth
            vec2 e1 = vec2( 0.026 * uH, 0.924 * uH);
            vec2 e2 = vec2(-0.026 * uH, 0.924 * uH);
            if (front && (distance(vBind.xy, e1) < 0.007 * uH || distance(vBind.xy, e2) < 0.007 * uH))
              kit = vec3(0.05);
            if (front && abs(vBind.y - 0.937 * uH) < 0.0035 * uH && abs(abs(vBind.x) - 0.027 * uH) < 0.014 * uH)
              kit = uHair * 0.8;
            if (front && abs(vBind.y - 0.902 * uH) < 0.0028 * uH && abs(vBind.x) < 0.014 * uH)
              kit = kit * vec3(0.62, 0.42, 0.40);
          }
          diffuseColor.rgb = kit;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = kitRough;',
      );
  };
  return mat;
}

export interface CharState {
  speed: number;
  stamina: number;
  yawRate: number;
  shield?: boolean;
  sliding?: boolean;
  stunned?: boolean;
  /** keeper holding the ball in his hands (arms cradle) */
  holding?: boolean;
  /** keeper set-stance trigger: ball close enough to threaten */
  ready?: boolean;
  /** this player is carrying the ball (dribble touches) */
  hasBall?: boolean;
  /** throw-in taker holding the ball overhead */
  throwHold?: boolean;
  /** world yaw toward the ball — the head subtly tracks it */
  lookYaw?: number;
  /** the model's world yaw (to convert lookYaw into a local head turn) */
  bodyYaw?: number;
}

// ---------------------------------------------------------------
// procedural action library (authored for a RIGHT-footed player; left-
// footers are mirrored). Axis: 0 = X (pitch: + leans/bends forward for the
// spine, + extends the hip BACK for a thigh, + flexes a knee), 1 = Y (yaw:
// + turns the right hip forward), 2 = Z (roll: + raises the LEFT arm /
// leg sideways, - raises the RIGHT). Keys are [t(0..1), radians].
// ---------------------------------------------------------------
type Key = [number, number];
type BoneKey =
  | 'pelvis' | 'spine1' | 'spine2' | 'spine3' | 'neck' | 'head'
  | 'uarmL' | 'uarmR' | 'larmL' | 'larmR'
  | 'thighL' | 'thighR' | 'calfL' | 'calfR' | 'footL' | 'footR';
interface Track { b: BoneKey; ax: 0 | 1 | 2; k: Key[] }
interface ActionDef { dur: number; tracks: Track[]; drop?: Key[] }

const STRIKE_ARMS: Track[] = [
  { b: 'uarmL', ax: 2, k: [[0, 0], [0.15, 0.95], [0.5, 0.8], [1, 0]] },
  { b: 'uarmL', ax: 0, k: [[0, 0], [0.15, -0.4], [0.5, -0.3], [1, 0]] },
  { b: 'uarmR', ax: 2, k: [[0, 0], [0.3, -0.55], [1, 0]] },
  { b: 'uarmR', ax: 0, k: [[0, 0], [0.3, 0.45], [1, 0]] },
];
const PLANT: Track[] = [
  { b: 'thighL', ax: 0, k: [[0, 0], [0.2, -0.22], [0.5, -0.25], [1, 0]] },
  { b: 'calfL', ax: 0, k: [[0, 0], [0.2, 0.4], [0.5, 0.32], [1, 0]] },
];

const ACTIONS: Record<string, ActionDef> = {
  // contact lands ~140ms in (the sim's contact frame)
  shot: {
    dur: 0.6,
    tracks: [
      { b: 'thighR', ax: 0, k: [[0, 0], [0.12, 0.55], [0.233, -0.35], [0.42, -1.35], [0.7, -0.45], [1, 0]] },
      { b: 'calfR', ax: 0, k: [[0, 0], [0.12, 1.45], [0.233, 0.3], [0.42, 0.12], [0.7, 0.45], [1, 0]] },
      { b: 'footR', ax: 0, k: [[0, 0], [0.2, 0.55], [0.45, 0.4], [1, 0]] },
      { b: 'pelvis', ax: 1, k: [[0, 0], [0.12, -0.32], [0.3, 0.22], [0.5, 0.3], [1, 0]] },
      { b: 'spine1', ax: 0, k: [[0, 0], [0.12, -0.12], [0.3, 0.12], [0.5, 0.2], [1, 0]] },
      { b: 'spine3', ax: 1, k: [[0, 0], [0.12, 0.22], [0.35, -0.18], [1, 0]] },
      { b: 'neck', ax: 0, k: [[0, 0], [0.2, 0.3], [0.5, 0.18], [1, 0]] },
      ...PLANT,
      ...STRIKE_ARMS,
    ],
    drop: [[0, 0], [0.25, -0.05], [1, 0]],
  },
  pass: {
    dur: 0.48,
    tracks: [
      { b: 'thighR', ax: 0, k: [[0, 0], [0.14, 0.35], [0.29, -0.3], [0.5, -0.75], [0.8, -0.2], [1, 0]] },
      { b: 'thighR', ax: 1, k: [[0, 0], [0.14, -0.55], [0.5, -0.6], [1, 0]] }, // side-foot: hip opens out
      { b: 'calfR', ax: 0, k: [[0, 0], [0.14, 0.9], [0.29, 0.35], [0.55, 0.3], [1, 0]] },
      { b: 'footR', ax: 0, k: [[0, 0], [0.3, 0.15], [1, 0]] },
      { b: 'pelvis', ax: 1, k: [[0, 0], [0.14, -0.15], [0.4, 0.15], [1, 0]] },
      { b: 'spine1', ax: 0, k: [[0, 0], [0.3, 0.12], [1, 0]] },
      { b: 'neck', ax: 0, k: [[0, 0], [0.25, 0.25], [1, 0]] },
      { b: 'thighL', ax: 0, k: [[0, 0], [0.25, -0.15], [1, 0]] },
      { b: 'calfL', ax: 0, k: [[0, 0], [0.25, 0.3], [1, 0]] },
      { b: 'uarmL', ax: 2, k: [[0, 0], [0.3, 0.6], [1, 0]] },
    ],
  },
  through: {
    dur: 0.5,
    tracks: [
      { b: 'thighR', ax: 0, k: [[0, 0], [0.14, 0.45], [0.28, -0.35], [0.5, -0.95], [0.8, -0.25], [1, 0]] },
      { b: 'thighR', ax: 1, k: [[0, 0], [0.14, -0.35], [0.5, -0.4], [1, 0]] },
      { b: 'calfR', ax: 0, k: [[0, 0], [0.14, 1.1], [0.28, 0.3], [0.55, 0.25], [1, 0]] },
      { b: 'pelvis', ax: 1, k: [[0, 0], [0.14, -0.22], [0.4, 0.2], [1, 0]] },
      { b: 'spine1', ax: 0, k: [[0, 0], [0.3, 0.15], [1, 0]] },
      { b: 'neck', ax: 0, k: [[0, 0], [0.25, 0.25], [1, 0]] },
      ...PLANT,
      { b: 'uarmL', ax: 2, k: [[0, 0], [0.3, 0.75], [1, 0]] },
    ],
  },
  lob: {
    dur: 0.62,
    tracks: [
      { b: 'thighR', ax: 0, k: [[0, 0], [0.12, 0.5], [0.233, -0.4], [0.45, -1.6], [0.75, -0.4], [1, 0]] },
      { b: 'calfR', ax: 0, k: [[0, 0], [0.12, 1.3], [0.233, 0.35], [0.45, 0.25], [1, 0]] },
      { b: 'footR', ax: 0, k: [[0, 0], [0.233, -0.2], [1, 0]] },  // toes up: scoop under it
      { b: 'pelvis', ax: 1, k: [[0, 0], [0.12, -0.3], [0.35, 0.25], [1, 0]] },
      { b: 'spine1', ax: 0, k: [[0, 0], [0.12, -0.1], [0.4, -0.22], [1, 0]] }, // lean back
      { b: 'neck', ax: 0, k: [[0, 0], [0.2, 0.25], [1, 0]] },
      ...PLANT,
      ...STRIKE_ARMS,
    ],
  },
  volley: {
    dur: 0.6,
    tracks: [
      { b: 'thighR', ax: 0, k: [[0, 0], [0.12, 0.3], [0.233, -1.1], [0.45, -1.4], [0.75, -0.5], [1, 0]] },
      { b: 'thighR', ax: 2, k: [[0, 0], [0.233, -0.55], [0.5, -0.5], [1, 0]] }, // leg swung up and across
      { b: 'calfR', ax: 0, k: [[0, 0], [0.12, 1.2], [0.233, 0.25], [0.5, 0.2], [1, 0]] },
      { b: 'spine1', ax: 2, k: [[0, 0], [0.233, 0.3], [0.6, 0.2], [1, 0]] },   // body leans away
      { b: 'spine1', ax: 0, k: [[0, 0], [0.233, -0.2], [1, 0]] },
      { b: 'uarmL', ax: 2, k: [[0, 0], [0.25, 1.0], [1, 0]] },
      { b: 'uarmR', ax: 2, k: [[0, 0], [0.25, -0.7], [1, 0]] },
      ...PLANT,
    ],
  },
  header: {
    dur: 0.55,
    tracks: [
      { b: 'neck', ax: 0, k: [[0, 0], [0.18, -0.35], [0.27, 0.45], [0.5, 0.2], [1, 0]] }, // cock, snap
      { b: 'spine2', ax: 0, k: [[0, 0], [0.18, -0.25], [0.27, 0.25], [1, 0]] },
      { b: 'uarmL', ax: 2, k: [[0, 0], [0.2, 1.1], [0.6, 0.9], [1, 0]] },
      { b: 'uarmR', ax: 2, k: [[0, 0], [0.2, -1.1], [0.6, -0.9], [1, 0]] },
    ],
  },
  touch: {
    dur: 0.3,
    tracks: [
      { b: 'thighR', ax: 0, k: [[0, 0], [0.35, -0.4], [1, 0]] },
      { b: 'calfR', ax: 0, k: [[0, 0], [0.25, 0.5], [0.6, 0.25], [1, 0]] },
      { b: 'footR', ax: 0, k: [[0, 0], [0.4, 0.2], [1, 0]] },
      { b: 'neck', ax: 0, k: [[0, 0], [0.4, 0.15], [1, 0]] },
    ],
  },
  tackle: {
    dur: 0.5,
    tracks: [
      { b: 'thighR', ax: 0, k: [[0, 0], [0.3, -1.0], [0.6, -0.8], [1, 0]] },
      { b: 'thighR', ax: 1, k: [[0, 0], [0.3, -0.4], [1, 0]] },  // hook the foot around
      { b: 'calfR', ax: 0, k: [[0, 0], [0.3, 0.15], [1, 0]] },
      { b: 'spine1', ax: 0, k: [[0, 0], [0.3, 0.3], [1, 0]] },
      { b: 'thighL', ax: 0, k: [[0, 0], [0.3, -0.3], [1, 0]] },
      { b: 'calfL', ax: 0, k: [[0, 0], [0.3, 0.55], [1, 0]] },
      { b: 'uarmL', ax: 2, k: [[0, 0], [0.3, 0.6], [1, 0]] },
      { b: 'uarmR', ax: 2, k: [[0, 0], [0.3, -0.5], [1, 0]] },
    ],
    drop: [[0, 0], [0.3, -0.14], [1, 0]],
  },
  // throw-in: from the overhead hold, whip both arms forward, torso follows
  throw: {
    dur: 0.55,
    tracks: [
      { b: 'uarmL', ax: 0, k: [[0, -2.75], [0.3, -2.9], [0.55, -1.2], [1, 0]] },
      { b: 'uarmR', ax: 0, k: [[0, -2.75], [0.3, -2.9], [0.55, -1.2], [1, 0]] },
      { b: 'larmL', ax: 0, k: [[0, -1.3], [0.3, -1.6], [0.55, -0.2], [1, 0]] },
      { b: 'larmR', ax: 0, k: [[0, -1.3], [0.3, -1.6], [0.55, -0.2], [1, 0]] },
      { b: 'spine1', ax: 0, k: [[0, -0.2], [0.3, -0.3], [0.55, 0.32], [1, 0]] },
      { b: 'neck', ax: 0, k: [[0, -0.12], [0.3, -0.15], [0.55, 0.1], [1, 0]] },
    ],
  },
  // goal! arms wide "aeroplane", chest out, then fists pumping
  celebrate: {
    dur: 3.2,
    tracks: [
      { b: 'uarmL', ax: 2, k: [[0, 0], [0.08, 1.45], [0.6, 1.45], [0.7, 2.6], [0.8, 1.9], [0.9, 2.6], [1, 0]] },
      { b: 'uarmR', ax: 2, k: [[0, 0], [0.08, -1.45], [0.6, -1.45], [0.7, -2.6], [0.8, -1.9], [0.9, -2.6], [1, 0]] },
      { b: 'spine2', ax: 0, k: [[0, 0], [0.1, -0.22], [0.6, -0.2], [0.75, -0.3], [1, 0]] },
      { b: 'neck', ax: 0, k: [[0, 0], [0.1, -0.3], [0.7, -0.35], [1, 0]] },
    ],
  },
};

/** Catmull-Rom through the keys: continuous velocity, so a strike whips
 *  THROUGH the contact key instead of pausing on it */
function curve(t: number, k: Key[]): number {
  if (t <= k[0][0]) return k[0][1];
  const n = k.length;
  if (t >= k[n - 1][0]) return k[n - 1][1];
  let i = 1;
  while (i < n - 1 && t > k[i][0]) i++;
  const p0 = k[Math.max(0, i - 2)][1], p1 = k[i - 1][1], p2 = k[i][1], p3 = k[Math.min(n - 1, i + 1)][1];
  const u = (t - k[i - 1][0]) / Math.max(1e-6, k[i][0] - k[i - 1][0]);
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

const BONE_NAMES: Record<BoneKey, string> = {
  pelvis: 'pelvis', spine1: 'spine_01', spine2: 'spine_02', spine3: 'spine_03',
  neck: 'neck_01', head: 'Head',
  uarmL: 'upperarm_l', uarmR: 'upperarm_r', larmL: 'lowerarm_l', larmR: 'lowerarm_r',
  thighL: 'thigh_l', thighR: 'thigh_r', calfL: 'calf_l', calfR: 'calf_r', footL: 'foot_l', footR: 'foot_r',
};
const MIRROR: Partial<Record<BoneKey, BoneKey>> = {
  uarmL: 'uarmR', uarmR: 'uarmL', larmL: 'larmR', larmR: 'larmL',
  thighL: 'thighR', thighR: 'thighL', calfL: 'calfR', calfR: 'calfL', footL: 'footR', footR: 'footL',
};
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export class CharModel {
  group = new THREE.Group();
  /** kept for API-parity with HumanRig (unused — clips own the posture) */
  extraPitch = 0;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction> = {};
  private cur = 'idle';
  private pose = new THREE.Group(); // slide/dive posing wrapper
  private armature: THREE.Object3D | null = null;
  private bones: Partial<Record<BoneKey, THREE.Object3D>> = {};
  private qArm = new THREE.Quaternion();
  private headUpLocal = new THREE.Vector3(0, 1, 0); // bind-pose local up axis
  private headLook = 0; // smoothed head yaw offset
  private bank = 0;     // smoothed lean-into-turn
  private slideBlend = 0; // 0..1 smoothed slide pose weight
  private speedF = 0; // filtered speed for stable state picks
  private accelF = 0; // filtered d(speed)/dt: momentum lean
  private shieldBlend = 0;
  private holdOverhead = 0; // throw-in taker: ball held above the head
  private touchTimer = 0.2;
  private leftFooted: boolean;
  // procedural action in flight
  private act: { def: ActionDef; t: number } | null = null;
  // referee card ceremony
  private handL: THREE.Object3D | null = null;
  private cardMesh: THREE.Mesh | null = null;
  private cardT = 0;
  // keeper: both-arms burst + smoothed cradle while holding
  private armsT = 0;
  private cradle = 0;
  // keeper dive: full-body lateral stretch toward diveSide
  private diveT = 0;
  private diveSide = 1;
  private isKeeper = false;
  // one-shot CLIP (dive/pickup/punch/leap): overrides locomotion until done
  private oneShot: string | null = null;
  private oneShotLeft = 0;

  constructor(team: KitTeam, seed = 0, keeper = false, kit: KitOpts = {}) {
    this.isKeeper = keeper;
    // ~1 in 5 players is left-footed (their technique is mirrored)
    this.leftFooted = ((Math.abs(seed) >> 7) % 5) === 0;
    const model = skeletonClone(gltf!.scene);
    // normalize to 1.82m
    const bbox = new THREE.Box3().setFromObject(model);
    const h = Math.max(0.01, bbox.max.y - bbox.min.y);
    model.scale.setScalar(1.82 / h);
    // face +X at yaw 0 (offset empirically calibrated; see setModelYawOffset)
    model.rotation.y = MODEL_YAW;
    liveModels.push(model);
    const byName = new Map<string, THREE.Object3D>();
    model.traverse((o: any) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.frustumCulled = false; // skinned bounds pop otherwise
        o.material = makeKitMaterial(team, h, seed, keeper, kit);
      }
      if (o.name) byName.set(o.name, o);
    });
    for (const [k, n] of Object.entries(BONE_NAMES)) {
      const b = byName.get(n);
      if (b) this.bones[k as BoneKey] = b;
    }
    this.armature = byName.get('root')?.parent ?? model;
    this.handL = byName.get('hand_l') ?? null;
    // the card lives in the ref's hand, hidden until shown. Bone space still
    // carries the source scale, so size it in world meters divided out.
    if (team === 'REF' && this.handL) {
      const s = 1.82 / h;
      this.cardMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(0.09 / s, 0.12 / s),
        new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide }),
      );
      this.cardMesh.position.set(0, 0.1 / s, 0);
      this.cardMesh.visible = false;
      this.handL.add(this.cardMesh);
    }
    this.pose.add(model);
    this.group.add(this.pose);

    // head-look axis (world up in the head's bind frame)
    const head = this.bones.head;
    if (head) {
      model.updateMatrixWorld(true);
      head.getWorldQuaternion(_q);
      this.headUpLocal.set(0, 1, 0).applyQuaternion(_q.conjugate()).normalize();
    }

    this.mixer = new THREE.AnimationMixer(model);
    for (const [key, name] of Object.entries(CLIP_NAMES)) {
      const clip = THREE.AnimationClip.findByName(gltf!.animations, name);
      if (clip) this.actions[key] = this.mixer.clipAction(clip);
    }
    this.actions.idle?.play();
  }

  // ---------------- triggers ----------------

  /** start a procedural technique (shot/pass/through/lob/volley/header/
   *  touch/tackle/throw/celebrate) */
  triggerAction(kind: string) {
    const def = ACTIONS[kind];
    if (!def) return;
    this.act = { def, t: 0 };
    if (kind === 'header') this.playOneShot('leap', 0.55, 1.6);
    if (kind === 'throw') this.holdOverhead = 0;
  }

  /** legacy entry point: amp > 1 = volley */
  triggerKick(amp = 1) {
    this.triggerAction(amp > 1.2 ? 'volley' : 'shot');
  }

  triggerHeader() {
    this.triggerAction('header');
  }

  /** is a technique already playing? (lets the contact event skip a
   *  duplicate when the windup event already started it) */
  get acting() {
    return !!this.act && this.act.def !== ACTIONS.touch;
  }

  /** throw-in taker currently holding the ball overhead */
  get throwReady() {
    return this.holdOverhead > 0.5;
  }

  /** play a REAL one-shot clip over locomotion, then fall back to it */
  private playOneShot(key: string, dur: number, timeScale = 1) {
    const a = this.actions[key];
    if (!a) return false;
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = timeScale;
    const prev = this.actions[this.cur];
    if (prev && this.cur !== key) a.crossFadeFrom(prev, 0.08, false);
    a.play();
    this.cur = key;
    this.oneShot = key;
    this.oneShotLeft = dur;
    return true;
  }

  /** keeper save / celebration: both arms thrown up for ~0.8s */
  triggerArms() {
    this.armsT = 0.8;
  }

  /** keeper dive: the real Roll clip + body roll toward the ball side */
  triggerDive(side: number) {
    this.diveSide = side >= 0 ? 1 : -1;
    this.playOneShot('roll', 0.85, 1.35);
    this.diveT = 0.85; // pose roll composes over the clip — reads sideways
  }

  /** keeper gathering a ground ball into his gloves */
  triggerPickup() {
    if (!this.playOneShot('pickup', 0.9, 1.6)) this.triggerArms();
  }

  /** keeper parry: a real punch clip — fists the ball clear */
  triggerPunch() {
    if (!this.playOneShot('punch', 0.6, 1.4)) this.triggerArms();
  }

  /** throw-in release */
  triggerThrow() {
    this.triggerAction('throw');
  }

  /** referee: hold a card overhead for ~2s (yellow or red) */
  showCard(color: 'yellow' | 'red') {
    this.cardT = 2.2;
    if (this.cardMesh) {
      (this.cardMesh.material as THREE.MeshBasicMaterial).color.set(
        color === 'yellow' ? 0xfacc15 : 0xdc2626,
      );
    }
  }

  // ---------------- motion layer ----------------

  /** rotate a bone about a TRUE body axis (native model space), expressed
   *  in its parent's current frame — correct whatever the clip is doing */
  private rotM(key: BoneKey, ax: 0 | 1 | 2, angle: number) {
    if (Math.abs(angle) < 1e-4) return;
    let k = key;
    let a = angle;
    if (this.leftFooted) {
      k = MIRROR[key] ?? key;
      if (ax !== 0) a = -a; // mirror across the sagittal plane
    }
    const b = this.bones[k];
    if (!b || !b.parent) return;
    b.parent.matrixWorld.decompose(_p, _qp, _s);
    _v.copy(AXES[ax]).applyQuaternion(this.qArm).applyQuaternion(_qp.invert());
    _q.setFromAxisAngle(_v.normalize(), a);
    b.quaternion.premultiply(_q);
  }

  update(dt: number, s: CharState) {
    const prevSpeed = this.speedF;
    this.speedF += (s.speed - this.speedF) * (1 - Math.exp(-10 * dt));
    const sp = this.speedF;
    const accel = dt > 0 ? (sp - prevSpeed) / dt : 0;
    this.accelF += (accel - this.accelF) * (1 - Math.exp(-6 * dt));

    // locomotion state with hysteresis — boundary chatter (7.9 <-> 8.1 m/s)
    // used to re-trigger crossfades and looked twitchy
    let want: string;
    const hy = 0.3;
    const up = (thr: number) => sp > thr + hy;
    const down = (thr: number) => sp < thr - hy;
    // a REAL action clip (dive/pickup/punch/leap) owns the body until done
    if (this.oneShot) {
      this.oneShotLeft -= dt;
      if (this.oneShotLeft > 0) {
        want = this.oneShot;
      } else {
        this.oneShot = null;
        want = sp > 6 ? 'sprint' : sp > 2.4 ? 'jog' : sp > 0.35 ? 'walk' : 'idle';
      }
    } else if (s.sliding) want = this.cur; // slide is a POSE overlay, not a clip
    else if (s.stunned && this.actions.stun) want = 'stun';
    else {
      want = this.cur === 'stun' || this.cur === 'ready' || (!(this.cur in NOMINAL) && this.cur !== 'idle')
        ? 'idle'
        : this.cur;
      if (want === 'idle' && up(0.35)) want = 'walk';
      if (want === 'walk' && down(0.35)) want = 'idle';
      if (want === 'walk' && up(2.4)) want = 'jog';
      if (want === 'jog' && down(2.4)) want = 'walk';
      if (want === 'jog' && up(6.0)) want = 'sprint';
      if (want === 'sprint' && down(6.0)) want = 'jog';
      // the keeper's set stance: knees bent, gloves ready, eyes on the ball
      if (want === 'idle' && this.isKeeper && s.ready && this.actions.ready) want = 'ready';
      if (!this.actions[want]) want = 'idle';
    }

    if (want !== this.cur && this.actions[want]) {
      const prev = this.actions[this.cur];
      const next = this.actions[want];
      next.reset();
      if (want === 'stun') {
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
      } else {
        next.setLoop(THREE.LoopRepeat, Infinity);
      }
      if (prev) next.crossFadeFrom(prev, 0.16, false);
      next.play();
      this.cur = want;
    }
    // feet track the ground: sync playback rate to actual speed
    if (this.cur in NOMINAL) {
      this.actions[this.cur].timeScale = THREE.MathUtils.clamp(sp / NOMINAL[this.cur], 0.55, 1.7);
    }
    this.mixer.update(dt);

    // ---- procedural motion layer (after the mixer so it wins) ----
    // body frame from the SAME (last-render) matrices the bone parents use,
    // so axis conversions stay consistent even mid-turn
    this.armature?.matrixWorld.decompose(_p, this.qArm, _s);

    // dribbling: little prods on the ball every few strides
    if (s.hasBall && sp > 0.8 && sp < 6.2 && !this.act && !s.stunned && !s.sliding) {
      this.touchTimer -= dt;
      if (this.touchTimer <= 0) {
        this.triggerAction('touch');
        this.touchTimer = THREE.MathUtils.clamp(0.62 - sp * 0.06, 0.34, 0.6);
      }
    } else {
      this.touchTimer = Math.min(this.touchTimer, 0.15);
    }

    // the technique in flight
    let drop = 0;
    if (this.act) {
      this.act.t += dt / this.act.def.dur;
      if (this.act.t >= 1) {
        this.act = null;
      } else {
        const t = this.act.t;
        for (const tr of this.act.def.tracks) this.rotM(tr.b, tr.ax, curve(t, tr.k));
        if (this.act.def.drop) drop = curve(t, this.act.def.drop);
      }
    }

    // momentum: lean into acceleration, a touch back when braking; sprinters
    // run tall-but-forward
    const lean = THREE.MathUtils.clamp(this.accelF * 0.028, -0.14, 0.2) + 0.1 * Math.min(1, sp / 8);
    this.rotM('spine1', 0, lean);

    // jockey / shield stance: knees bent, weight low, arms wide for balance
    this.shieldBlend += ((s.shield ? 1 : 0) - this.shieldBlend) * (1 - Math.exp(-9 * dt));
    if (this.shieldBlend > 0.01) {
      const b = this.shieldBlend;
      this.rotM('thighL', 0, -0.32 * b);
      this.rotM('thighR', 0, -0.32 * b);
      this.rotM('calfL', 0, 0.55 * b);
      this.rotM('calfR', 0, 0.55 * b);
      this.rotM('spine1', 0, 0.2 * b);
      this.rotM('uarmL', 2, 0.5 * b);
      this.rotM('uarmR', 2, -0.5 * b);
      drop += -0.09 * b;
    }

    // throw-in taker: both hands hold the ball above the head
    this.holdOverhead += ((s.throwHold ? 1 : 0) - this.holdOverhead) * (1 - Math.exp(-8 * dt));
    if (this.holdOverhead > 0.01 && !this.act) {
      const b = this.holdOverhead;
      this.rotM('uarmL', 0, -2.75 * b);
      this.rotM('uarmR', 0, -2.75 * b);
      this.rotM('larmL', 0, -1.3 * b);
      this.rotM('larmR', 0, -1.3 * b);
      this.rotM('spine1', 0, -0.2 * b);
    }

    // keeper overlays — save burst (arms up) and ball-cradle while holding
    if (this.armsT > 0) {
      this.armsT = Math.max(0, this.armsT - dt);
      const a = Math.min(1, this.armsT / 0.25);
      this.rotM('uarmL', 2, 2.2 * a);
      this.rotM('uarmR', 2, -2.2 * a);
    }
    this.cradle += ((s.holding ? 1 : 0) - this.cradle) * (1 - Math.exp(-10 * dt));
    if (this.cradle > 0.02) {
      // forearms wrapped in front of the chest around the held ball
      this.rotM('uarmL', 0, -0.9 * this.cradle);
      this.rotM('uarmR', 0, -0.9 * this.cradle);
      this.rotM('larmL', 0, -1.2 * this.cradle);
      this.rotM('larmR', 0, -1.2 * this.cradle);
    }

    // card ceremony: left arm straight up, card visible in hand
    if (this.cardT > 0) {
      this.cardT = Math.max(0, this.cardT - dt);
      const a = Math.min(1, Math.min(this.cardT / 0.25, (2.2 - this.cardT) / 0.25));
      this.rotM('uarmL', 2, 2.5 * a);
      if (this.cardMesh) this.cardMesh.visible = a > 0.4;
    } else if (this.cardMesh?.visible) {
      this.cardMesh.visible = false;
    }

    // head subtly tracks the ball (life!), clamped to a natural range
    const head = this.bones.head;
    if (head && s.lookYaw !== undefined && s.bodyYaw !== undefined) {
      let d = s.lookYaw - s.bodyYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const target = Math.abs(d) < 1.9 ? THREE.MathUtils.clamp(d, -0.65, 0.65) : 0;
      this.headLook += (target - this.headLook) * (1 - Math.exp(-8 * dt));
      if (Math.abs(this.headLook) > 0.01) head.rotateOnAxis(this.headUpLocal, -this.headLook);
    }

    // keeper dive arms: both at full stretch
    if (this.diveT > 0) {
      this.diveT = Math.max(0, this.diveT - dt);
      const e = this.diveT > 0.55 ? (0.85 - this.diveT) / 0.3 : this.diveT / 0.55;
      const env = Math.min(1, Math.max(0, e));
      this.rotM('uarmL', 2, 2.6 * env);
      this.rotM('uarmR', 2, -2.6 * env);
    }

    // ---- whole-body posing (pose group: forward = +X, rot.z + = lean back) ----
    const bankTarget = THREE.MathUtils.clamp(-s.yawRate * 0.05, -0.14, 0.14);
    this.bank += (bankTarget - this.bank) * (1 - Math.exp(-10 * dt));
    this.pose.rotation.x = this.bank;

    // SLIDE TACKLE pose: body low and leaned back, leading leg out front,
    // trailing leg tucked — a proper ground slide, not a somersault
    this.slideBlend += ((s.sliding ? 1 : 0) - this.slideBlend) * (1 - Math.exp(-14 * dt));
    if (this.slideBlend > 0.01) {
      const b = this.slideBlend;
      this.pose.rotation.z = 0.95 * b;
      this.pose.position.y = -0.62 * b;
      this.rotM('thighR', 0, -1.35 * b);
      this.rotM('calfR', 0, 0.15 * b);
      this.rotM('thighL', 0, -0.45 * b);
      this.rotM('calfL', 0, 1.1 * b);
    } else {
      this.pose.rotation.z = 0;
      this.pose.position.y = drop;
    }

    // keeper dive: full-body roll toward the ball side, dropping to the grass
    if (this.diveT > 0) {
      const e = this.diveT > 0.55 ? (0.85 - this.diveT) / 0.3 : this.diveT / 0.55;
      const env = Math.min(1, Math.max(0, e));
      this.pose.rotation.x = this.bank + this.diveSide * 1.25 * env;
      this.pose.position.y = Math.min(this.pose.position.y, -0.5 * env);
    }
  }
}
