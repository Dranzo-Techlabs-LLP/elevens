// Unified input, PES-style:
//   move    — WASD/arrows or virtual joystick (left half of screen)
//   pass    — Space/J or PASS button (doubles as pressure/tackle defending)
//   shoot   — K or SHOOT button (hold = power)
//   lob     — L or LOB button (lofted through ball)
//   sprint  — Shift or SPRINT button (hold)
const JOY_RADIUS = 60; // px drag for full speed
const JOY_DEADZONE = 0.12;

export interface ActionButtons {
  pass: HTMLElement;
  shoot: HTMLElement;
  lob: HTMLElement;
  sprint: HTMLElement;
}

export class Input {
  // current held state, polled by the main loop each frame
  mx = 0;
  my = 0;
  pass = false;
  shoot = false;
  lob = false;
  sprint = false;

  /** main.ts flips this when a match is on screen; while false we don't
   *  intercept touches (menus need normal taps and text inputs). */
  enabled = false;

  // exposed for rendering the on-screen stick
  joyActive = false;
  joyBase = { x: 0, y: 0 };
  joyKnob = { x: 0, y: 0 };

  /** local hold-start times so the charge ring shows with zero latency */
  heldSince: Record<'pass' | 'shoot' | 'lob', number> = { pass: 0, shoot: 0, lob: 0 };

  private keys = new Set<string>();
  private touchHeld = { pass: false, shoot: false, lob: false, sprint: false };
  private joyTouchId: number | null = null;

  constructor(buttons: ActionButtons) {
    addEventListener('keydown', (e) => {
      if (this.enabled && ['Space', 'KeyJ', 'KeyK', 'KeyL'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));

    addEventListener('touchstart', (e) => this.touchStart(e), { passive: false });
    addEventListener('touchmove', (e) => this.touchMove(e), { passive: false });
    addEventListener('touchend', (e) => this.touchEnd(e));
    addEventListener('touchcancel', (e) => this.touchEnd(e));

    // hold-to-charge action buttons (touch + mouse); stopPropagation keeps
    // these touches away from the joystick handler on window
    for (const name of ['pass', 'shoot', 'lob', 'sprint'] as const) {
      const el = buttons[name];
      const down = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        this.touchHeld[name] = true;
        el.classList.add('held');
      };
      const up = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        this.touchHeld[name] = false;
        el.classList.remove('held');
      };
      el.addEventListener('touchstart', down, { passive: false });
      el.addEventListener('touchend', up);
      el.addEventListener('touchcancel', up);
      el.addEventListener('mousedown', down);
      el.addEventListener('mouseup', up);
      el.addEventListener('mouseleave', up);
    }
  }

  private touchStart(e: TouchEvent) {
    if (!this.enabled) return;
    // taps on buttons/overlays (settings gear, cam switch, menus) must reach
    // them — only raw pitch touches become joystick input
    const target = e.target as HTMLElement | null;
    if (target?.closest?.('.ui, .overlay, button')) return;
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
    if (!this.enabled || this.joyTouchId === null) return;
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

    const now = performance.now();
    const set = (name: 'pass' | 'shoot' | 'lob', held: boolean) => {
      if (held && !this[name]) this.heldSince[name] = now;
      this[name] = held;
    };
    set('pass', this.keys.has('Space') || this.keys.has('KeyJ') || this.touchHeld.pass);
    set('shoot', this.keys.has('KeyK') || this.touchHeld.shoot);
    set('lob', this.keys.has('KeyL') || this.touchHeld.lob);
    this.sprint =
      this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchHeld.sprint;
  }

  /** 0..1 charge of whichever chargeable button is held (for the ring). */
  localCharge(chargeMs: number): number {
    const now = performance.now();
    let c = 0;
    if (this.shoot) c = Math.max(c, (now - this.heldSince.shoot) / chargeMs);
    if (this.lob) c = Math.max(c, (now - this.heldSince.lob) / chargeMs);
    if (this.pass) c = Math.max(c, (now - this.heldSince.pass) / chargeMs);
    return Math.min(1, c);
  }
}
