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
  slide: 'Roll',
  stun: 'Hit_Chest',
} as const;

// nominal ground speed each loop was authored at (m/s) — playback timeScale
// is speed/nominal so the feet track the ground at any velocity
const NOMINAL: Record<string, number> = { walk: 1.5, jog: 3.5, sprint: 7.4 };

let gltf: { scene: THREE.Group; animations: THREE.AnimationClip[] } | null = null;

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
  private thighR: THREE.Object3D | null = null;
  private calfR: THREE.Object3D | null = null;
  private kickT = 0;
  private speedF = 0; // filtered speed for stable state picks

  constructor(team: 'A' | 'B') {
    const model = skeletonClone(gltf!.scene);
    // normalize to 1.82m
    const bbox = new THREE.Box3().setFromObject(model);
    const h = Math.max(0.01, bbox.max.y - bbox.min.y);
    model.scale.setScalar(1.82 / h);
    // glTF assets face +Z; our players face +X (yaw 0) -> rotate the child
    model.rotation.y = -Math.PI / 2;
    model.traverse((o: any) => {
      if (o.isMesh || o.isSkinnedMesh) {
        o.castShadow = true;
        o.frustumCulled = false; // skinned bounds pop otherwise
        const m = (o.material as THREE.MeshStandardMaterial).clone();
        m.color = new THREE.Color(team === 'A' ? 0x3b82f6 : 0xef4444);
        m.roughness = 0.72;
        o.material = m;
      }
      if (o.name === 'thigh_r') this.thighR = o;
      if (o.name === 'calf_r') this.calfR = o;
    });
    this.group.add(model);

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
    if (s.sliding && this.actions.slide) want = 'slide';
    else if (s.stunned && this.actions.stun) want = 'stun';
    else if (sp < 0.35) want = 'idle';
    else if (sp < 2.4) want = 'walk';
    else if (sp < 6.0) want = 'jog';
    else want = 'sprint';

    if (want !== this.cur && this.actions[want]) {
      const prev = this.actions[this.cur];
      const next = this.actions[want];
      next.reset();
      if (want === 'slide' || want === 'stun') {
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
  }
}
