// Unified input: keyboard (WASD/arrows + Space) and touch (virtual joystick
// on the left half of the screen + a KICK button bottom-right).
const JOY_RADIUS = 60;   // px drag for full speed
const JOY_DEADZONE = 0.12;

export class Input {
  // current held state, polled by the main loop each frame
  mx = 0;
  my = 0;
  kick = false;

  /** main.ts flips this when a match is on screen; while false we don't
   *  intercept touches (menus need normal taps and text inputs). */
  enabled = false;

  // exposed for rendering the on-screen stick
  joyActive = false;
  joyBase = { x: 0, y: 0 };
  joyKnob = { x: 0, y: 0 };

  /** local kick-hold start time — lets us render our own charge ring with
   *  zero latency instead of waiting for the server snapshot */
  kickHeldSince = 0;

  private keys = new Set<string>();
  private joyTouchId: number | null = null;
  private kickTouch = false;

  constructor(kickEl: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.code === 'Space' && this.enabled) e.preventDefault();
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));

    addEventListener('touchstart', (e) => this.touchStart(e), { passive: false });
    addEventListener('touchmove', (e) => this.touchMove(e), { passive: false });
    addEventListener('touchend', (e) => this.touchEnd(e));
    addEventListener('touchcancel', (e) => this.touchEnd(e));

    // kick button: hold to charge, release to fire (stopPropagation keeps
    // these touches away from the joystick handler on window)
    const down = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.kickTouch = true;
    };
    const up = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.kickTouch = false;
    };
    kickEl.addEventListener('touchstart', down, { passive: false });
    kickEl.addEventListener('touchend', up);
    kickEl.addEventListener('touchcancel', up);
    kickEl.addEventListener('mousedown', down);
    kickEl.addEventListener('mouseup', up);
  }

  private touchStart(e: TouchEvent) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      // left ~55% of the screen spawns the joystick where the finger lands
      if (this.joyTouchId === null && t.clientX < innerWidth * 0.55) {
        this.joyTouchId = t.identifier;
        this.joyBase = { x: t.clientX, y: t.clientY };
        this.joyKnob = { x: t.clientX, y: t.clientY };
        this.joyActive = true;
      }
    }
  }

  private touchMove(e: TouchEvent) {
    if (!this.enabled) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.joyTouchId) {
        this.joyKnob = { x: t.clientX, y: t.clientY };
      }
    }
  }

  private touchEnd(e: TouchEvent) {
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.joyTouchId) {
        this.joyTouchId = null;
        this.joyActive = false;
      }
    }
  }

  /** Recompute held state. Call once per frame before sending. */
  update() {
    let mx = 0, my = 0;
    // keyboard
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my += 1;
    const klen = Math.hypot(mx, my);
    if (klen > 1) {
      mx /= klen;
      my /= klen;
    }
    // joystick overrides keyboard when active
    if (this.joyActive) {
      let jx = (this.joyKnob.x - this.joyBase.x) / JOY_RADIUS;
      let jy = (this.joyKnob.y - this.joyBase.y) / JOY_RADIUS;
      const len = Math.hypot(jx, jy);
      if (len > 1) {
        jx /= len;
        jy /= len;
      }
      if (len > JOY_DEADZONE) {
        mx = jx;
        my = jy;
      } else {
        mx = 0;
        my = 0;
      }
    }
    this.mx = mx;
    this.my = my;

    const kick = this.keys.has('Space') || this.kickTouch;
    if (kick && !this.kick) this.kickHeldSince = performance.now();
    this.kick = kick;
  }
}
