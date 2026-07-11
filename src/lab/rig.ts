// ============================================================
// PROCEDURAL HUMAN RIG (fallback until Mixamo GLBs land — see ASSETS.md).
// Meters scale, 1.82m tall. Exposes the same LocoAnim surface a clip-based
// AnimationMixer implementation will provide, so swapping to real clips is
// a drop-in.
//
// Anti-foot-slide without IK: the stride is CADENCE-MATCHED — cadence rises
// with speed and the hip swing amplitude is solved from the actual distance
// covered per step (stride = speed / cadence), so foot ground-speed matches
// body speed. At walk the feet plant; at sprint they turn over fast. No
// moonwalking.
// ============================================================
import * as THREE from 'three';
import { PLAYER } from '../shared/config3d';

export interface LocoState {
  speed: number;    // m/s ground speed
  yawRate: number;  // rad/s, for lean-into-turn
  stamina: number;  // 0..1 — tired players pump arms less, lean more
  shield?: boolean; // wide-arm hold-up stance
  kick?: boolean;   // one-shot trigger
}

interface Limb {
  root: THREE.Group;
  joint: THREE.Group;
}

const LEG_UPPER = 0.46;
const LEG_LOWER = 0.44;

export class HumanRig {
  group = new THREE.Group();
  private lean = new THREE.Group();
  private legL: Limb;
  private legR: Limb;
  private armL: Limb;
  private armR: Limb;
  private phase = Math.random() * 6.28;
  private kickT = 0;
  /** extra body pitch (rad) — slide = throw the body low, stun = slump */
  extraPitch = 0;

  constructor(jerseyColor = 0x2563eb) {
    const jersey = new THREE.MeshStandardMaterial({ color: jerseyColor, roughness: 0.7 });
    const shorts = new THREE.MeshStandardMaterial({ color: 0x111c3f, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: 0xd7a06b, roughness: 0.75 });
    const boots = new THREE.MeshStandardMaterial({ color: 0x18181b, roughness: 0.5 });

    this.group.add(this.lean);

    const mkLimb = (
      side: number,
      y: number,
      upLen: number,
      loLen: number,
      upR: number,
      loR: number,
      upMat: THREE.Material,
      loMat: THREE.Material,
      foot?: boolean,
    ): Limb => {
      const root = new THREE.Group();
      root.position.set(0, y, side);
      const up = new THREE.Mesh(new THREE.CapsuleGeometry(upR, upLen - upR * 2, 4, 8), upMat);
      up.position.y = -upLen / 2;
      up.castShadow = true;
      root.add(up);
      const joint = new THREE.Group();
      joint.position.y = -upLen;
      const lo = new THREE.Mesh(new THREE.CapsuleGeometry(loR, loLen - loR * 2, 4, 8), loMat);
      lo.position.y = -loLen / 2;
      lo.castShadow = true;
      joint.add(lo);
      if (foot) {
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.09, 0.12), boots);
        f.position.set(0.07, -loLen - 0.02, 0);
        f.castShadow = true;
        joint.add(f);
      }
      root.add(joint);
      this.lean.add(root);
      return { root, joint };
    };

    // legs: hip at 0.94
    this.legL = mkLimb(-0.13, 0.94, LEG_UPPER, LEG_LOWER, 0.085, 0.062, shorts, skin, true);
    this.legR = mkLimb(0.13, 0.94, LEG_UPPER, LEG_LOWER, 0.085, 0.062, shorts, skin, true);

    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.2, 0.34), shorts);
    pelvis.position.y = 1.02;
    pelvis.castShadow = true;
    this.lean.add(pelvis);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.34, 4, 10), jersey);
    torso.position.y = 1.34;
    torso.scale.set(0.75, 1, 1.15);
    torso.castShadow = true;
    this.lean.add(torso);

    // arms: shoulder at 1.5
    this.armL = mkLimb(-0.28, 1.5, 0.32, 0.3, 0.062, 0.05, jersey, skin);
    this.armR = mkLimb(0.28, 1.5, 0.32, 0.3, 0.062, 0.05, jersey, skin);

    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.115, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xd7a06b, roughness: 0.75 }),
    );
    head.position.y = 1.72;
    head.castShadow = true;
    this.lean.add(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new THREE.MeshStandardMaterial({ color: 0x2a1e14, roughness: 0.9 }),
    );
    hair.position.y = 1.72;
    hair.rotation.z = -0.45;
    this.lean.add(hair);
  }

  triggerKick() {
    this.kickT = 1;
  }

  /** Drive the rig. Call every render frame. */
  update(dt: number, s: LocoState) {
    const speed = s.speed;
    // cadence rises with speed (Hz of FULL gait cycle, i.e. two steps)
    const cadence = 0.9 + speed * 0.21;
    this.phase += dt * cadence * Math.PI * 2;

    // stride-matched hip amplitude: distance per step = speed / (2*cadence);
    // the hip arc that covers it with our leg length:
    const stepLen = speed / (2 * cadence);
    const legLen = LEG_UPPER + LEG_LOWER;
    const amp = Math.asin(Math.min(0.92, stepLen / (2 * legLen) * 2));

    const sn = Math.sin(this.phase);
    const alt = Math.sin(this.phase + Math.PI);

    this.legL.root.rotation.z = sn * amp;
    this.legR.root.rotation.z = alt * amp;
    // knee flexes on the swing-through (leg going backward relative to body)
    this.legL.joint.rotation.z = -Math.max(0, -sn) * (0.4 + amp * 1.1) - 0.04;
    this.legR.joint.rotation.z = -Math.max(0, -alt) * (0.4 + amp * 1.1) - 0.04;

    if (this.kickT > 0) {
      this.kickT = Math.max(0, this.kickT - dt * 4.5);
      const k = Math.sin(this.kickT * Math.PI);
      this.legR.root.rotation.z = -1.3 * k;
      this.legR.joint.rotation.z = -0.3 * k;
    }

    // arms counter-swing; tired players pump less; shielding spreads them wide
    if (s.shield) {
      this.armL.root.rotation.z = 0.15;
      this.armR.root.rotation.z = 0.15;
      this.armL.root.rotation.x = -1.15; // out sideways
      this.armR.root.rotation.x = 1.15;
      this.armL.joint.rotation.z = -0.25;
      this.armR.joint.rotation.z = -0.25;
    } else {
      this.armL.root.rotation.x = 0;
      this.armR.root.rotation.x = 0;
      const armAmp = amp * (0.55 + 0.35 * s.stamina);
      this.armL.root.rotation.z = alt * armAmp;
      this.armR.root.rotation.z = sn * armAmp;
      this.armL.joint.rotation.z = -0.55 - amp * 0.4;
      this.armR.joint.rotation.z = -0.55 - amp * 0.4;
    }

    // forward lean with speed (+ extra when gassed), bank into turns
    const runFrac = Math.min(1, speed / PLAYER.sprintSpeed);
    this.lean.rotation.z = -(0.04 + runFrac * 0.22 + (1 - s.stamina) * 0.05) + this.extraPitch;
    this.lean.rotation.x = THREE.MathUtils.clamp(s.yawRate * 0.10, -0.22, 0.22);
    // stride bob (vertical), breathing at rest
    this.lean.position.y =
      speed > 0.3 ? Math.abs(Math.sin(this.phase)) * 0.035 * runFrac : Math.sin(this.phase * 0.3) * 0.006;
  }
}
