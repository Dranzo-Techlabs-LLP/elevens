// ============================================================
// GOAL NETS — cloth panels that bulge and ripple.
//
// The sim lets the ball travel ~0.4m past the rest plane of the back net
// (and a little past the side/roof planes) before a soft stop; visually
// every net vertex is spring-damped toward a displacement target set by the
// ball pressing into its panel, so the net wraps around the ball, then
// shivers back — the moment every goal replay lingers on.
//
// A panel only reacts once the ball has ENTERED that goal through the mouth
// (under the bar, between the posts); a ball rolling past the outside of the
// side netting never makes it bulge from the wrong side.
// ============================================================
import * as THREE from 'three';

interface Panel {
  goal: number;         // 0 = -x goal, 1 = +x goal
  mesh: THREE.Mesh;
  rest: Float32Array;   // rest positions (local)
  disp: Float32Array;   // displacement per vertex along the panel normal
  vel: Float32Array;
  pin: Float32Array;    // 0 at the frame edges (tied to posts/bar), 1 mid-panel
  origin: THREE.Vector3;
  normal: THREE.Vector3;
  tu: THREE.Vector3;
  tv: THREE.Vector3;
  active: boolean;
}

function netTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 5;
  // diamond mesh, seamless on a 128 tile
  for (let k = -128; k <= 256; k += 64) {
    g.beginPath(); g.moveTo(k, 0); g.lineTo(k + 128, 128); g.stroke();
    g.beginPath(); g.moveTo(k + 128, 0); g.lineTo(k, 128); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class GoalNets {
  private panels: Panel[] = [];
  private tmp = new THREE.Vector3();
  private inGoal = [false, false];
  private prev = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private L: number,
    private gw: number,
    private gh: number,
    private gd: number,
  ) {
    const tex = netTexture();
    const cell = 0.24; // one diamond tile per 24cm
    const mk = (
      goal: number, w: number, h: number, segW: number, segH: number,
      origin: THREE.Vector3, normal: THREE.Vector3, tu: THREE.Vector3, tv: THREE.Vector3,
    ) => {
      const geo = new THREE.PlaneGeometry(w, h, segW, segH);
      const map = tex.clone();
      map.needsUpdate = true;
      map.repeat.set(w / cell, h / cell);
      const mat = new THREE.MeshStandardMaterial({
        map, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        roughness: 0.8, alphaTest: 0.05,
      });
      const mesh = new THREE.Mesh(geo, mat);
      // orient: local x -> tu, local y -> tv, local z -> normal (right-handed)
      mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(tu, tv, normal));
      mesh.position.copy(origin);
      mesh.renderOrder = 2;
      scene.add(mesh);
      const pos = geo.getAttribute('position') as THREE.BufferAttribute;
      const pin = new Float32Array(pos.count);
      for (let i = 0; i < pos.count; i++) {
        const fx = 1 - Math.abs(pos.getX(i)) / (w / 2);
        const fy = 1 - Math.abs(pos.getY(i)) / (h / 2);
        pin[i] = Math.min(1, 3.5 * Math.min(fx, fy));
      }
      this.panels.push({
        goal, mesh, pin,
        rest: Float32Array.from(pos.array as Float32Array),
        disp: new Float32Array(pos.count),
        vel: new Float32Array(pos.count),
        origin: origin.clone(), normal: normal.clone(), tu: tu.clone(), tv: tv.clone(),
        active: false,
      });
    };
    const Y = new THREE.Vector3(0, 1, 0);
    for (const sx of [-1, 1]) {
      const goal = sx < 0 ? 0 : 1;
      const gx = sx * L / 2;
      // back net: plane x = gx + sx*gd, outward normal +sx x
      mk(goal, gw, gh, 22, 10,
        new THREE.Vector3(gx + sx * gd, gh / 2, 0),
        new THREE.Vector3(sx, 0, 0), new THREE.Vector3(0, 0, -sx), Y);
      // side nets: planes z = +-gw/2, outward normal +-z
      for (const sz of [-1, 1]) {
        mk(goal, gd, gh, 6, 10,
          new THREE.Vector3(gx + sx * gd / 2, gh / 2, sz * gw / 2),
          new THREE.Vector3(0, 0, sz), new THREE.Vector3(sz, 0, 0), Y);
      }
      // roof net: plane y = gh, outward normal +y
      mk(goal, gd, gw, 6, 22,
        new THREE.Vector3(gx + sx * gd / 2, gh, 0),
        Y.clone(), new THREE.Vector3(sx, 0, 0), new THREE.Vector3(0, 0, -sx));
    }
  }

  /** per frame: ball world position + radius drive the cloth */
  update(dt: number, ball: THREE.Vector3, r: number) {
    const { L, gw, gh, gd } = this;
    // track entry through the mouth, per goal
    for (const goal of [0, 1]) {
      const sx = goal === 0 ? -1 : 1;
      const px = sx * this.prev.x, cx = sx * ball.x;
      if (px <= L / 2 && cx > L / 2 && Math.abs(ball.z) < gw / 2 && ball.y < gh) this.inGoal[goal] = true;
      // left the goal box (restart, kickoff teleport, rebound out)
      if (cx < L / 2 - 0.5 || cx > L / 2 + gd + 1.5 || Math.abs(ball.z) > gw / 2 + 1) this.inGoal[goal] = false;
    }
    this.prev.copy(ball);

    const h = Math.min(dt, 1 / 30);
    for (const p of this.panels) {
      this.tmp.copy(ball).sub(p.origin);
      const depth = this.tmp.dot(p.normal) + r;  // >0: pressing outward through the plane
      const pressing = this.inGoal[p.goal] && depth > 0 && depth < 0.9;
      if (!pressing && !p.active) continue;
      const bu = this.tmp.dot(p.tu), bv = this.tmp.dot(p.tv);
      let moving = false;
      const pos = p.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < p.disp.length; i++) {
        let target = 0;
        if (pressing) {
          const du = p.rest[i * 3] - bu, dv = p.rest[i * 3 + 1] - bv;
          // wraps around the ball (ball-sized core, soft skirt), held tight
          // where it is tied to the frame
          target = depth * Math.exp(-(du * du + dv * dv) / (2 * 0.33 * 0.33)) * p.pin[i];
        }
        // spring-damper: the bulge follows the ball, then shivers back
        const a = (target - p.disp[i]) * 210 - p.vel[i] * 11;
        p.vel[i] += a * h;
        p.disp[i] += p.vel[i] * h;
        if (Math.abs(p.disp[i]) > 0.002 || Math.abs(p.vel[i]) > 0.01) moving = true;
        arr[i * 3 + 2] = p.disp[i];
      }
      pos.needsUpdate = true;
      p.active = moving || pressing;
    }
  }
}
