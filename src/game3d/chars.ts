// ============================================================
// REAL RIGGED CHARACTERS — Quaternius Universal Animation Library (CC0).
// One skinned mannequin + 43 mocap-class clips; we clone the skeleton per
// player and drive a locomotion blend tree (idle/walk/jog/sprint) with
// cadence-synced playback, crossfades, slide (Roll) and stun (Hit_Chest)
// one-shots, and a procedural KICK overlay on the right leg bones applied
// after the mixer (Standard tier ships no kick clip).
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
// KIT SHADER: the mannequin is one mesh, so the kit is painted in the
// shader from BIND-POSE height bands (the bind pose never changes, so the
// jersey/shorts/socks zones deform perfectly with the animation):
//   boots -> socks -> skin legs -> shorts -> jersey (short sleeves via
//   arm-distance cut) -> neck/head skin -> hair cap + simple face (eyes)
// ---------------------------------------------------------------
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xba8a63];
const HAIRS = [0x1c1512, 0x3b2a1a, 0x0d0d0d, 0x5b3b1a, 0x62514a];

function makeKitMaterial(team: 'A' | 'B', bindH: number, seed: number) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.72 });
  const uTeam = { value: new THREE.Color(team === 'A' ? 0x2563eb : 0xdc2626) };
  const uShorts = { value: new THREE.Color(team === 'A' ? 0x122a5c : 0x5c1212) };
  const uSock = { value: new THREE.Color(team === 'A' ? 0x2563eb : 0xdc2626) };
  const uSkin = { value: new THREE.Color(SKINS[Math.abs(seed) % SKINS.length]) };
  const uHair = { value: new THREE.Color(HAIRS[Math.abs(seed >> 2) % HAIRS.length]) };
  const uH = { value: bindH };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTeam, uShorts, uSock, uSkin, uHair, uH });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', 'vBind = position;\n#include <begin_vertex>');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vBind;
         uniform vec3 uTeam, uShorts, uSock, uSkin, uHair;
         uniform float uH;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          float f = vBind.y / uH;           // 0 feet .. 1 head top
          float armR = length(vBind.xz);    // T-pose: arms reach sideways
          vec3 kit = uSkin;
          if (f < 0.045) kit = vec3(0.08);                 // boots
          else if (f < 0.16) kit = uSock;                  // socks
          else if (f < 0.47) kit = uSkin;                  // legs
          else if (f < 0.60) kit = uShorts;                // shorts
          else if (f < 0.855) {
            // torso band: shirt, but bare forearms/hands (short sleeves)
            kit = (armR > uH * 0.34 && f > 0.72) ? uSkin : uTeam;
          } else {
            // head zone
            kit = uSkin;
            // hair: upper-back of the skull
            if (f > 0.935 || (f > 0.90 && vBind.z < -0.005)) kit = uHair;
            // eyes: two dots on the front of the face
            vec2 e1 = vec2( 0.026 * uH, 0.924 * uH);
            vec2 e2 = vec2(-0.026 * uH, 0.924 * uH);
            if (vBind.z > 0.02 && (distance(vBind.xy, e1) < 0.007 * uH || distance(vBind.xy, e2) < 0.007 * uH))
              kit = vec3(0.05);
          }
          diffuseColor.rgb = kit;
        }`,
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
}

export class CharModel {
  group = new THREE.Group();
  /** kept for API-parity with HumanRig (unused — clips own the posture) */
  extraPitch = 0;
  private mixer: THREE.AnimationMixer;
  private actions: Record<string, THREE.AnimationAction> = {};
  private cur = 'idle';
  private pose = new THREE.Group(); // slide/stun body posing wrapper
  private thighR: THREE.Object3D | null = null;
  private calfR: THREE.Object3D | null = null;
  private thighL: THREE.Object3D | null = null;
  private calfL: THREE.Object3D | null = null;
  private kickT = 0;
  private slideBlend = 0; // 0..1 smoothed slide pose weight
  private speedF = 0; // filtered speed for stable state picks

  constructor(team: 'A' | 'B', seed = 0) {
    const model = skeletonClone(gltf!.scene);
    // normalize to 1.82m
    const bbox = new THREE.Box3().setFromObject(model);
    const h = Math.max(0.01, bbox.max.y - bbox.min.y);
    model.scale.setScalar(1.82 / h);
    // face +X at yaw 0 (offset empirically calibrated; see setModelYawOffset)
    model.rotation.y = MODEL_YAW;
    liveModels.push(model);
    model.traverse((o: any) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.frustumCulled = false; // skinned bounds pop otherwise
        o.material = makeKitMaterial(team, h, seed);
      }
      if (o.name === 'thigh_r') this.thighR = o;
      if (o.name === 'calf_r') this.calfR = o;
      if (o.name === 'thigh_l') this.thighL = o;
      if (o.name === 'calf_l') this.calfL = o;
    });
    this.pose.add(model);
    this.group.add(this.pose);

    this.mixer = new THREE.AnimationMixer(model);
    for (const [key, name] of Object.entries(CLIP_NAMES)) {
      const clip = THREE.AnimationClip.findByName(gltf!.animations, name);
      if (clip) this.actions[key] = this.mixer.clipAction(clip);
    }
    this.actions.idle?.play();
  }

  triggerKick() {
    this.kickT = 1;
  }

  update(dt: number, s: CharState) {
    this.speedF += (s.speed - this.speedF) * (1 - Math.exp(-10 * dt));
    const sp = this.speedF;

    let want: string;
    if (s.sliding) want = this.cur; // slide is a POSE overlay, not a clip
    else if (s.stunned && this.actions.stun) want = 'stun';
    else if (sp < 0.35) want = 'idle';
    else if (sp < 2.4) want = 'walk';
    else if (sp < 6.0) want = 'jog';
    else want = 'sprint';

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

    // procedural kick overlay AFTER the mixer so it wins the pose
    if (this.kickT > 0) {
      this.kickT = Math.max(0, this.kickT - dt * 4.5);
      const k = Math.sin(this.kickT * Math.PI);
      // UE-style skeleton: swing the thigh forward, extend the calf
      this.thighR?.rotateZ(-1.15 * k);
      this.calfR?.rotateZ(0.35 * k);
    }

    // SLIDE TACKLE pose (overlay, smoothed): body low and leaned back,
    // leading leg extended along the slide, trailing leg tucked — a proper
    // ground slide, not a somersault
    const target = s.sliding ? 1 : 0;
    this.slideBlend += (target - this.slideBlend) * (1 - Math.exp(-14 * dt));
    if (this.slideBlend > 0.01) {
      const b = this.slideBlend;
      this.pose.rotation.z = 0.95 * b;    // lean back (forward = +X local)
      this.pose.position.y = -0.62 * b;   // hips to the grass
      this.thighR?.rotateZ(-1.35 * b);    // leading leg out front
      this.calfR?.rotateZ(0.15 * b);
      this.thighL?.rotateZ(0.55 * b);     // trailing leg tucked
      this.calfL?.rotateZ(-1.0 * b);
    } else {
      this.pose.rotation.z = 0;
      this.pose.position.y = 0;
    }
  }
}
