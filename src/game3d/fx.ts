import * as THREE from 'three';

// Shared scratch objects: every per-frame transform composition reuses these, so FX.update()
// allocates nothing -- GC pauses are the #1 cause of visible hitches in a 60fps match client.
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

// Trail tuning. The alpha ramp spans LO..HI m/s so the comet tail only appears on
// genuinely hard hits (shots, long balls) and never flickers during dribbling.
const TRAIL_LEN = 22;
const TRAIL_LO = 9;
const TRAIL_HI = 20;
const TRAIL_MAX_ALPHA = 0.55;

const PUFF_COUNT = 14;
const PUFF_LIFE = 0.45;

const CONF_COUNT = 160;
const CONF_LIFE = 2.6;
// Festive palette cycled across instances; chosen to read against green pitch,
// white lines and the net (yellow/green/blue/red/near-white).
const CONF_COLORS = [0xfacc15, 0x22c55e, 0x3b82f6, 0xef4444, 0xf8fafc];

export class FX {
  // --- ball trail ---
  private trail: THREE.Points;
  private trailMat: THREE.PointsMaterial;
  private trailPos: Float32Array;   // ring buffer: last TRAIL_LEN ball positions (xyz)
  private trailAttr: THREE.BufferAttribute;
  private trailHead = 0;            // next ring slot to overwrite
  private trailIdle = true;         // true while hidden; triggers a re-seed on wake

  // --- kick puff ---
  private puff: THREE.Points;
  private puffMat: THREE.PointsMaterial;
  private puffPos: Float32Array;
  private puffVel: Float32Array;
  private puffAttr: THREE.BufferAttribute;
  private puffAge = PUFF_LIFE;      // starts "expired" so update() early-outs immediately

  // --- goal confetti ---
  private conf: THREE.InstancedMesh;
  private confPos: Float32Array;
  private confVel: Float32Array;
  private confRot: Float32Array;    // per-instance euler angles (tumble state)
  private confSpin: Float32Array;   // per-instance angular velocity
  private confLife: Float32Array;   // per-instance lifespan; staggered deaths look organic
  private confAge = Infinity;       // Infinity = idle -> one float compare per frame

  constructor(scene: THREE.Scene) {
    // TRAIL: one Points draw call. Additive blending makes overlapping samples brighten
    // into a hot core near the ball; depthWrite off so the translucent tail never
    // punches holes in the ball or players rendered after it.
    this.trailPos = new Float32Array(TRAIL_LEN * 3);
    this.trailAttr = new THREE.BufferAttribute(this.trailPos, 3);
    this.trailAttr.setUsage(THREE.DynamicDrawUsage);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', this.trailAttr);
    this.trailMat = new THREE.PointsMaterial({
      color: 0xd9ffe0, size: 0.09, sizeAttenuation: true, transparent: true,
      opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.trail = new THREE.Points(tGeo, this.trailMat);
    // World-space positions make the geometry's stale origin-centred bounds meaningless,
    // so culling must be off or the effect vanishes mid-screen. Same for all three systems.
    this.trail.frustumCulled = false;
    this.trail.visible = false;
    scene.add(this.trail);

    // KICK PUFF: a single reusable 14-particle pool. Kicks happen constantly, so we
    // never allocate per kick -- kickPuff() just rewinds and re-scatters this pool.
    this.puffPos = new Float32Array(PUFF_COUNT * 3);
    this.puffVel = new Float32Array(PUFF_COUNT * 3);
    this.puffAttr = new THREE.BufferAttribute(this.puffPos, 3);
    this.puffAttr.setUsage(THREE.DynamicDrawUsage);
    const pGeo = new THREE.BufferGeometry();
    pGeo.setAttribute('position', this.puffAttr);
    this.puffMat = new THREE.PointsMaterial({
      color: 0x1d4d28, size: 0.07, sizeAttenuation: true, transparent: true,
      opacity: 0, depthWrite: false, // dark green = shadowed turf chips, not dust
    });
    this.puff = new THREE.Points(pGeo, this.puffMat);
    this.puff.frustumCulled = false;
    this.puff.visible = false;
    scene.add(this.puff);

    // CONFETTI: one InstancedMesh = 160 tumbling quads in a single draw call.
    // vertexColors stays OFF -- per-instance tint comes from instanceColor, which is
    // far cheaper than 160 materials or a per-vertex color attribute.
    // sized for the broadcast camera ~20m out: at 0.06x0.10 the quads
    // rasterize to 2-3px and the celebration is invisible on TV
    const cGeo = new THREE.PlaneGeometry(0.16, 0.24);
    const cMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, transparent: true });
    this.conf = new THREE.InstancedMesh(cGeo, cMat, CONF_COUNT);
    this.conf.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const col = new THREE.Color();
    for (let i = 0; i < CONF_COUNT; i++) {
      this.conf.setColorAt(i, col.setHex(CONF_COLORS[i % CONF_COLORS.length]));
      _m4.makeScale(0, 0, 0); // park every instance degenerate so nothing flashes pre-burst
      this.conf.setMatrixAt(i, _m4);
    }
    if (this.conf.instanceColor) this.conf.instanceColor.needsUpdate = true;
    this.conf.frustumCulled = false;
    this.conf.visible = false;
    scene.add(this.conf);

    this.confPos = new Float32Array(CONF_COUNT * 3);
    this.confVel = new Float32Array(CONF_COUNT * 3);
    this.confRot = new Float32Array(CONF_COUNT * 3);
    this.confSpin = new Float32Array(CONF_COUNT * 3);
    this.confLife = new Float32Array(CONF_COUNT);
  }

  // Call once per rendered frame with the ball's world position and scalar speed (m/s).
  update(dt: number, ballX: number, ballY: number, ballZ: number, ballSpeed: number): void {
    this.updateTrail(ballX, ballY, ballZ, ballSpeed);
    this.updatePuff(dt);
    this.updateConfetti(dt);
  }

  private updateTrail(x: number, y: number, z: number, speed: number): void {
    // Smoothstep the speed->alpha ramp: a hard threshold makes the tail pop in and out
    // every frame as physics speed jitters around the cutoff; the S-curve fades it.
    const t = Math.min(1, Math.max(0, (speed - TRAIL_LO) / (TRAIL_HI - TRAIL_LO)));
    const alpha = TRAIL_MAX_ALPHA * t * t * (3 - 2 * t);
    if (alpha <= 0.001) {
      // Slow ball: just hide and flag idle. We deliberately do NOT keep writing the
      // buffer -- the re-seed below handles staleness, keeping the idle path free.
      if (!this.trailIdle) { this.trailIdle = true; this.trail.visible = false; }
      return;
    }
    if (this.trailIdle) {
      // Waking from idle: collapse every sample onto the ball NOW, otherwise the ring still
      // holds the previous fast spell and would draw a stale streak from the old position.
      for (let i = 0; i < TRAIL_LEN * 3; i += 3) {
        this.trailPos[i] = x; this.trailPos[i + 1] = y; this.trailPos[i + 2] = z;
      }
      this.trailIdle = false;
      this.trail.visible = true;
    }
    // Ring buffer: overwrite the oldest slot each frame. Points render unordered, so
    // no shifting/copying is needed -- one 3-float write per frame.
    const h = this.trailHead * 3;
    this.trailPos[h] = x; this.trailPos[h + 1] = y; this.trailPos[h + 2] = z;
    this.trailHead = (this.trailHead + 1) % TRAIL_LEN;
    this.trailMat.opacity = alpha;
    this.trailAttr.needsUpdate = true;
  }

  // Small burst of turf chips at a kick. Re-calling mid-flight is fine by design: rapid
  // kicks reuse the pool, and cutting the old puff short is invisible under the fresh one.
  kickPuff(x: number, z: number): void {
    this.puffAge = 0;
    for (let i = 0; i < PUFF_COUNT * 3; i += 3) {
      this.puffPos[i] = x; this.puffPos[i + 1] = 0.05; this.puffPos[i + 2] = z;
      // Tight upward cone: mostly vertical, mild lateral scatter -- turf flicked by a boot.
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 0.9;
      this.puffVel[i] = Math.cos(a) * r;
      this.puffVel[i + 1] = 1.5 + Math.random() * 1.6;
      this.puffVel[i + 2] = Math.sin(a) * r;
    }
    this.puffMat.opacity = 1;
    this.puffAttr.needsUpdate = true;
    this.puff.visible = true;
  }

  private updatePuff(dt: number): void {
    if (this.puffAge >= PUFF_LIFE) return; // idle early-out: one compare
    this.puffAge += dt;
    if (this.puffAge >= PUFF_LIFE) { this.puff.visible = false; return; }
    for (let i = 0; i < PUFF_COUNT * 3; i += 3) {
      // Full -9.8 gravity: dense grass chips arc down fast, contrasting the floaty confetti.
      this.puffVel[i + 1] -= 9.8 * dt;
      this.puffPos[i] += this.puffVel[i] * dt;
      this.puffPos[i + 1] += this.puffVel[i + 1] * dt;
      this.puffPos[i + 2] += this.puffVel[i + 2] * dt;
    }
    this.puffMat.opacity = 1 - this.puffAge / PUFF_LIFE; // linear fade to zero at death
    this.puffAttr.needsUpdate = true;
  }

  // Confetti cannon at the goal mouth: all 160 instances launch at once from (x, 1.2, z)
  // -- 1.2m up so the burst reads over players' legs and the net's lower edge.
  goalBurst(x: number, z: number): void {
    this.confAge = 0;
    for (let i = 0; i < CONF_COUNT; i++) {
      const j = i * 3;
      this.confPos[j] = x; this.confPos[j + 1] = 1.2; this.confPos[j + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 3; // lateral spread within +-3 m/s
      this.confVel[j] = Math.cos(a) * r;
      this.confVel[j + 1] = 4 + Math.random() * 5; // 4-9 m/s up: proper cannon pop
      this.confVel[j + 2] = Math.sin(a) * r;
      for (let k = 0; k < 3; k++) {
        this.confRot[j + k] = Math.random() * Math.PI * 2;       // random start facing
        this.confSpin[j + k] = (Math.random() - 0.5) * 14;       // fast tumble sells "paper"
      }
      // Staggered lifespans (70-100% of max): a wall of quads all dying on the same
      // frame reads as a glitch; ragged expiry reads as confetti settling naturally.
      this.confLife[i] = CONF_LIFE * (0.7 + Math.random() * 0.3);
    }
    this.conf.visible = true;
  }

  private updateConfetti(dt: number): void {
    if (this.confAge > CONF_LIFE) return; // Infinity when idle -> cheapest possible skip
    const prevAge = this.confAge;
    this.confAge += dt;
    if (this.confAge > CONF_LIFE) { this.conf.visible = false; return; }
    for (let i = 0; i < CONF_COUNT; i++) {
      const life = this.confLife[i];
      if (this.confAge >= life) {
        // Collapse to scale 0 exactly once, on the death frame -- long-dead instances then
        // cost one compare. Degenerate quads rasterize to nothing, keeping one draw call.
        if (prevAge < life) { _m4.makeScale(0, 0, 0); this.conf.setMatrixAt(i, _m4); }
        continue;
      }
      const j = i * 3;
      // -6 gravity (not -9.8): paper has huge drag relative to mass, so confetti
      // flutters down noticeably slower than a solid object would.
      this.confVel[j + 1] -= 6 * dt;
      this.confPos[j] += this.confVel[j] * dt;
      this.confPos[j + 1] += this.confVel[j + 1] * dt;
      this.confPos[j + 2] += this.confVel[j + 2] * dt;
      this.confRot[j] += this.confSpin[j] * dt;
      this.confRot[j + 1] += this.confSpin[j + 1] * dt;
      this.confRot[j + 2] += this.confSpin[j + 2] * dt;
      // Shrink over each instance's final 0.4s as a stand-in for alpha fade:
      // InstancedMesh has per-instance color but no per-instance opacity.
      const rem = life - this.confAge;
      const k = rem < 0.4 ? rem / 0.4 : 1;
      _p.set(this.confPos[j], this.confPos[j + 1], this.confPos[j + 2]);
      _q.setFromEuler(_e.set(this.confRot[j], this.confRot[j + 1], this.confRot[j + 2]));
      _m4.compose(_p, _q, _s.setScalar(k));
      this.conf.setMatrixAt(i, _m4);
    }
    this.conf.instanceMatrix.needsUpdate = true;
  }
}
