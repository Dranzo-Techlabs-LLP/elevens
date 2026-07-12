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
  // real action clips (all in the CC0 UAL pack):
  roll: 'Roll',                 // keeper dive = committed body roll
  pickup: 'PickUp_Table',       // keeper gathering a ground ball
  punch: 'Punch_Cross',         // keeper parry — fists the ball away
  throwrel: 'Spell_Simple_Shoot', // two-handed forward release (throw-in)
  ready: 'Crouch_Idle_Loop',    // keeper set stance, knees bent, ready
} as const;

// nominal ground speed each loop was authored at (m/s) — playback timeScale
// is speed/nominal so the feet track the ground at any velocity
const NOMINAL: Record<string, number> = { walk: 1.5, jog: 3.5, sprint: 7.4 };
const UP = new THREE.Vector3(0, 1, 0);

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

export type KitTeam = 'A' | 'B' | 'REF';

function makeKitMaterial(team: KitTeam, bindH: number, seed: number, keeper = false) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.72 });
  // referees wear all-black; KEEPERS wear a distinct kit (amber / emerald)
  // with white gloves — you must be able to pick him out at a glance
  let jersey = team === 'A' ? 0x2563eb : team === 'B' ? 0xdc2626 : 0x141417;
  let shorts = team === 'A' ? 0x122a5c : team === 'B' ? 0x5c1212 : 0x101013;
  let socks = team === 'A' ? 0x2563eb : team === 'B' ? 0xdc2626 : 0x141417;
  if (keeper && team !== 'REF') {
    jersey = team === 'A' ? 0xf59e0b : 0x10b981;
    shorts = 0x1f2937;
    socks = jersey;
  }
  const uGlove = { value: keeper ? 1 : 0 };
  const uTeam = { value: new THREE.Color(jersey) };
  const uShorts = { value: new THREE.Color(shorts) };
  const uSock = { value: new THREE.Color(socks) };
  const uSkin = { value: new THREE.Color(SKINS[Math.abs(seed) % SKINS.length]) };
  const uHair = { value: new THREE.Color(HAIRS[Math.abs(seed >> 2) % HAIRS.length]) };
  const uH = { value: bindH };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTeam, uShorts, uSock, uSkin, uHair, uH, uGlove });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBind;')
      .replace('#include <begin_vertex>', 'vBind = position;\n#include <begin_vertex>');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         varying vec3 vBind;
         uniform vec3 uTeam, uShorts, uSock, uSkin, uHair;
         uniform float uH, uGlove;`,
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
            // KEEPER GLOVES: white from the wrists out (T-pose: hands are
            // the farthest points from the spine)
            if (uGlove > 0.5 && armR > uH * 0.435 && f > 0.72) kit = vec3(0.93);
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
  /** keeper holding the ball in his hands (arms cradle) */
  holding?: boolean;
  /** keeper set-stance trigger: ball close enough to threaten */
  ready?: boolean;
  /** world yaw toward the ball — the head subtly tracks it */
  lookYaw?: number;
  /** the model's world yaw (to convert lookYaw into a local head turn) */
  bodyYaw?: number;
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
  private head: THREE.Object3D | null = null;
  private headUpLocal = new THREE.Vector3(0, 1, 0); // bind-pose local up axis
  private headLook = 0; // smoothed head yaw offset
  private bank = 0;     // smoothed lean-into-turn
  private kickT = 0;
  private slideBlend = 0; // 0..1 smoothed slide pose weight
  private speedF = 0; // filtered speed for stable state picks
  // referee card ceremony: arm held high, card in hand
  private upperArmL: THREE.Object3D | null = null;
  private upperArmR: THREE.Object3D | null = null;
  private handL: THREE.Object3D | null = null;
  private cardMesh: THREE.Mesh | null = null;
  private cardT = 0;
  // keeper: both-arms burst + smoothed cradle while holding
  private armsT = 0;
  private cradle = 0;
  // keeper dive: full-body lateral stretch toward diveSide
  private diveT = 0;
  private diveSide = 1;
  // throw-in: two-handed overhead throw (raise -> snap forward)
  private throwT = 0;

  private isKeeper = false;
  // one-shot action clip (dive/pickup/punch/throw): overrides locomotion
  // until its timer runs out, then crossfades back
  private oneShot: string | null = null;
  private oneShotLeft = 0;

  constructor(team: KitTeam, seed = 0, keeper = false) {
    this.isKeeper = keeper;
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
        o.material = makeKitMaterial(team, h, seed, keeper);
      }
      if (o.name === 'thigh_r') this.thighR = o;
      if (o.name === 'calf_r') this.calfR = o;
      if (o.name === 'thigh_l') this.thighL = o;
      if (o.name === 'calf_l') this.calfL = o;
      if (o.name === 'Head') this.head = o;
      if (o.name === 'upperarm_l') this.upperArmL = o;
      if (o.name === 'upperarm_r') this.upperArmR = o;
      if (o.name === 'hand_l') this.handL = o;
    });
    // the card lives in the ref's hand, hidden until shown. Bone space still
    // carries the source scale, so size it in world meters divided out.
    if (team === 'REF' && this.handL) {
      const s = 1.82 / h;
      const geo = new THREE.PlaneGeometry(0.09 / s, 0.12 / s);
      this.cardMesh = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0xfacc15, side: THREE.DoubleSide }),
      );
      this.cardMesh.position.set(0, 0.1 / s, 0);
      this.cardMesh.visible = false;
      this.handL.add(this.cardMesh);
    }
    this.pose.add(model);
    this.group.add(this.pose);

    // cache the head bone's LOCAL axis that corresponds to world-up in the
    // bind pose — per-frame head-look then rotates around it locally (a
    // world-axis rotate would force whole-skeleton matrix updates per call)
    if (this.head) {
      model.updateMatrixWorld(true);
      const q = new THREE.Quaternion();
      this.head.getWorldQuaternion(q);
      this.headUpLocal.set(0, 1, 0).applyQuaternion(q.conjugate()).normalize();
    }

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
    if (this.playOneShot('roll', 0.85, 1.35)) {
      this.diveT = 0.85; // pose roll composes over the clip — reads sideways
    } else {
      this.diveT = 0.85;
    }
  }

  /** keeper gathering a ground ball into his gloves */
  triggerPickup() {
    if (!this.playOneShot('pickup', 0.9, 1.6)) this.triggerArms();
  }

  /** keeper parry: a real punch clip — fists the ball clear */
  triggerPunch() {
    if (!this.playOneShot('punch', 0.6, 1.4)) this.triggerArms();
  }

  /** throw-in: ball overhead, snapped forward with both hands */
  triggerThrow() {
    this.throwT = 0.7;
    this.playOneShot('throwrel', 0.7, 1.3);
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

  update(dt: number, s: CharState) {
    this.speedF += (s.speed - this.speedF) * (1 - Math.exp(-10 * dt));
    const sp = this.speedF;

    // locomotion state with hysteresis — boundary chatter (7.9 <-> 8.1 m/s)
    // used to re-trigger crossfades and looked twitchy
    let want: string;
    const h = 0.3;
    const up = (thr: number) => sp > thr + h;
    const down = (thr: number) => sp < thr - h;
    // a REAL action clip (dive/pickup/punch/throw) owns the body until done
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
      want = this.cur === 'stun' || this.cur === 'ready' || !(this.cur in NOMINAL) && this.cur !== 'idle'
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

    // procedural kick overlay AFTER the mixer so it wins the pose
    if (this.kickT > 0) {
      this.kickT = Math.max(0, this.kickT - dt * 4.5);
      const k = Math.sin(this.kickT * Math.PI);
      // UE-style skeleton: swing the thigh forward, extend the calf
      this.thighR?.rotateZ(-1.15 * k);
      this.calfR?.rotateZ(0.35 * k);
    }

    // keeper overlays — save burst (arms up) and ball-cradle while holding
    if (this.armsT > 0) {
      this.armsT = Math.max(0, this.armsT - dt);
      const a = Math.min(1, this.armsT / 0.25);
      this.upperArmL?.rotateZ(2.2 * a);
      this.upperArmR?.rotateZ(-2.2 * a);
    }

    // THROW-IN: both hands take the ball overhead, then a sharp forward
    // snap with the torso following through — a real two-handed delivery
    if (this.throwT > 0) {
      this.throwT = Math.max(0, this.throwT - dt);
      const t = this.throwT;
      if (t > 0.22) {
        // wind-up: arms straight overhead
        const a = Math.min(1, (0.7 - t) / 0.18);
        this.upperArmL?.rotateZ(2.5 * a);
        this.upperArmR?.rotateZ(-2.5 * a);
      } else {
        // release: arms whip forward (torso lean composed after the slide
        // block below — it owns the pose group)
        const a = t / 0.22;
        this.upperArmL?.rotateZ(1.1 + 1.4 * a);
        this.upperArmR?.rotateZ(-(1.1 + 1.4 * a));
      }
    }
    const cradleTarget = s.holding ? 1 : 0;
    this.cradle += (cradleTarget - this.cradle) * (1 - Math.exp(-10 * dt));
    if (this.cradle > 0.02) {
      // forearms wrapped in front of the chest around the held ball
      this.upperArmL?.rotateZ(1.15 * this.cradle);
      this.upperArmR?.rotateZ(-1.15 * this.cradle);
    }

    // card ceremony overlay: left arm straight up, card visible in hand
    if (this.cardT > 0) {
      this.cardT = Math.max(0, this.cardT - dt);
      // ease in fast, hold, ease out
      const a = Math.min(1, Math.min(this.cardT / 0.25, (2.2 - this.cardT) / 0.25));
      this.upperArmL?.rotateZ(2.35 * a);
      if (this.cardMesh) this.cardMesh.visible = a > 0.4;
    } else if (this.cardMesh?.visible) {
      this.cardMesh.visible = false;
    }

    // head subtly tracks the ball (life!), clamped to a natural range
    if (this.head && s.lookYaw !== undefined && s.bodyYaw !== undefined) {
      let d = s.lookYaw - s.bodyYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const target = Math.abs(d) < 1.9 ? THREE.MathUtils.clamp(d, -0.65, 0.65) : 0;
      this.headLook += (target - this.headLook) * (1 - Math.exp(-8 * dt));
      if (Math.abs(this.headLook) > 0.01) {
        this.head.rotateOnAxis(this.headUpLocal, -this.headLook); // local, cheap
      }
    }

    // bank into turns (small, smoothed)
    const bankTarget = THREE.MathUtils.clamp(-s.yawRate * 0.05, -0.14, 0.14);
    this.bank += (bankTarget - this.bank) * (1 - Math.exp(-10 * dt));
    this.pose.rotation.x = this.bank;

    // KEEPER DIVE arms: both at full stretch (pose roll composed after the
    // slide block, which owns the pose group)
    if (this.diveT > 0) {
      this.diveT = Math.max(0, this.diveT - dt);
      const e = this.diveT > 0.55 ? (0.85 - this.diveT) / 0.3 : this.diveT / 0.55;
      const env = Math.min(1, Math.max(0, e));
      this.upperArmL?.rotateZ(2.6 * env);
      this.upperArmR?.rotateZ(-2.6 * env);
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

    // pose-level keeper/throw overlays AFTER the slide block (it resets the
    // pose group each frame, so these must compose on top of it)
    if (this.diveT > 0) {
      const e = this.diveT > 0.55 ? (0.85 - this.diveT) / 0.3 : this.diveT / 0.55;
      const env = Math.min(1, Math.max(0, e));
      // full-body roll toward the ball side, dropping toward the grass
      this.pose.rotation.x = this.bank + this.diveSide * 1.25 * env;
      this.pose.position.y = Math.min(this.pose.position.y, -0.5 * env);
    }
    if (this.throwT > 0 && this.throwT <= 0.22) {
      // torso follows the throw through
      this.pose.rotation.z -= 0.3 * (1 - this.throwT / 0.22);
    }
  }
}
