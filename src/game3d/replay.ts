// ============================================================
// REPLAY — the broadcast action replay after every goal.
//
// The client records what it RENDERED (not raw snapshots): every body's
// position/heading/speed/state plus the ball at 30Hz, and every technique a
// character played, into a rolling 8s buffer. After a goal the director
// plays the build-up back in slow motion from two cinematic angles — a low
// tracking shot beside the play, then from behind the net as it bulges —
// while the stadium is still celebrating. The sim is paused for the goal
// the whole time, so nothing live is missed.
// ============================================================

export interface RBody {
  id: string;
  x: number; z: number; yaw: number; spd: number;
  sliding: boolean; stunned: boolean; holding: boolean; shield: boolean;
  keeper: boolean; hasBall: boolean;
}
export interface RFrame {
  t: number;              // performance.now() ms
  bx: number; by: number; bz: number;
  bodies: RBody[];
  ref: { x: number; z: number; yaw: number; spd: number } | null;
}
export interface RAction { t: number; id: string; kind: string; arg?: number }

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const lerpAngle = (a: number, b: number, k: number) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
};

export class Recorder {
  frames: RFrame[] = [];
  actions: RAction[] = [];
  private lastPush = -1e9;
  keepMs = 8000;

  /** record at ~30Hz (enough for smooth interpolated playback) */
  wants(now: number) {
    return now - this.lastPush >= 33;
  }
  push(f: RFrame) {
    this.lastPush = f.t;
    this.frames.push(f);
    const cut = f.t - this.keepMs;
    let i = 0;
    while (i < this.frames.length && this.frames[i].t < cut) i++;
    if (i) this.frames.splice(0, i);
    let j = 0;
    while (j < this.actions.length && this.actions[j].t < cut) j++;
    if (j) this.actions.splice(0, j);
  }
  log(a: RAction) {
    this.actions.push(a);
  }

  /** interpolated frame at time t (ms) */
  sample(t: number): RFrame | null {
    const F = this.frames;
    if (!F.length) return null;
    if (t <= F[0].t) return F[0];
    if (t >= F[F.length - 1].t) return F[F.length - 1];
    let lo = 0, hi = F.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (F[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = F[lo], b = F[hi];
    const k = (t - a.t) / Math.max(1, b.t - a.t);
    const bodies: RBody[] = [];
    for (const pb of b.bodies) {
      const pa = a.bodies.find((q) => q.id === pb.id) ?? pb;
      bodies.push({
        ...pb,
        x: lerp(pa.x, pb.x, k), z: lerp(pa.z, pb.z, k),
        yaw: lerpAngle(pa.yaw, pb.yaw, k), spd: lerp(pa.spd, pb.spd, k),
      });
    }
    return {
      t,
      bx: lerp(a.bx, b.bx, k), by: lerp(a.by, b.by, k), bz: lerp(a.bz, b.bz, k),
      bodies,
      ref: a.ref && b.ref
        ? { x: lerp(a.ref.x, b.ref.x, k), z: lerp(a.ref.z, b.ref.z, k), yaw: lerpAngle(a.ref.yaw, b.ref.yaw, k), spd: b.ref.spd }
        : b.ref,
    };
  }

  actionsBetween(t0: number, t1: number) {
    return this.actions.filter((a) => a.t > t0 && a.t <= t1);
  }
}

/** playback state for one goal's replay */
export class ReplayDirector {
  active = false;
  t = 0;          // playback cursor (recorded ms)
  start = 0;
  end = 0;
  goalSide = 1;   // +1: the +x goal, -1: the -x goal
  speed = 0.8;
  /** debug/inspection: keep playing past the kickoff whistle */
  hold = false;

  begin(goalAtMs: number, goalSide: number) {
    // build-up: ~3.3s before the rendered ball crossed the line, then a
    // beat after it hits the net
    this.start = goalAtMs - 3300;
    this.end = goalAtMs + 900;
    this.t = this.start;
    this.goalSide = goalSide;
    this.active = true;
  }

  /** advance; returns [prevT, t] for firing logged actions */
  advance(dtMs: number): [number, number] {
    const p = this.t;
    this.t = Math.min(this.end, this.t + dtMs * this.speed);
    if (this.t >= this.end) this.active = false;
    return [p, this.t];
  }

  /** 0..1 progress through the replay */
  get progress() {
    return (this.t - this.start) / Math.max(1, this.end - this.start);
  }
}
