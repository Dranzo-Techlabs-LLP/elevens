import type { WebSocket } from 'ws';
import { CONFIG as C } from '../shared/config';
import type { ClientMsg, Phase, ServerMsg, Team } from '../shared/protocol';
import { botThink } from './bot';

const DT = 1 / C.TICK_RATE;      // fixed timestep, seconds
const TICK_MS = 1000 / C.TICK_RATE;

export interface PlayerInput {
  mx: number;
  my: number;
  sprint: boolean;
  pass: boolean;
  shoot: boolean;
  lob: boolean;
}

export const idleInput = (): PlayerInput => ({
  mx: 0, my: 0, sprint: false, pass: false, shoot: false, lob: false,
});

export interface Entity {
  id: string;
  name: string;
  team: Team;
  bot: boolean;
  ws: WebSocket | null; // null for bots
  x: number;
  y: number;
  vx: number;
  vy: number;
  dir: number; // facing, radians — follows movement direction
  input: PlayerInput;
  prevPass: boolean; // rising-edge detection: pass = tackle when defending
  passHeldMs: number;
  shootHeldMs: number;
  lobHeldMs: number;
  lungeTicks: number; // >0 while committed to a tackle lunge
  lungeVx: number;
  lungeVy: number;
  recoverTicks: number; // stumble after a missed tackle / being dispossessed
  tackleCooldownUntil: number;
  kickCooldownUntil: number; // tick until which this player can't (re)control the ball
  avatar?: string; // tiny selfie data URL, humans only
}

export function makeEntityDefaults() {
  return {
    x: 0, y: 0, vx: 0, vy: 0,
    input: idleInput(),
    prevPass: false,
    passHeldMs: 0,
    shootHeldMs: 0,
    lobHeldMs: 0,
    lungeTicks: 0,
    lungeVx: 0,
    lungeVy: 0,
    recoverTicks: 0,
    tackleCooldownUntil: 0,
    kickCooldownUntil: 0,
  };
}

export const rooms = new Map<string, Room>();

let nextId = 1;

function roomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O — ambiguous on phones
  let code: string;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

export class Room {
  code: string;
  entities = new Map<string, Entity>();
  hostId: string | null = null;
  phase: Phase = 'lobby';
  score: [number, number] = [0, 0];
  timeLeft = C.MATCH_SECONDS;
  ball = { x: C.PITCH_W / 2, y: C.PITCH_H / 2, z: 0, vx: 0, vy: 0, vz: 0 };
  /** id of the player currently carrying/controlling the ball, if any */
  ownerId: string | null = null;
  private ownerSince = 0; // tick when possession last changed hands
  tick = 0;
  rematchVotes = new Set<string>();
  private pauseUntilTick = 0;
  private loop: NodeJS.Timeout;

  static create(): Room {
    const room = new Room(roomCode());
    rooms.set(room.code, room);
    return room;
  }

  constructor(code: string) {
    this.code = code;
    // Fixed-timestep loop. setInterval alone drifts, so we track elapsed real
    // time ourselves and run however many ticks are owed (usually exactly 1).
    // The interval fires at 2x tick rate so a late wake-up rarely skips a tick.
    let last = Date.now();
    let owed = 0;
    this.loop = setInterval(() => {
      const now = Date.now();
      owed += now - last;
      last = now;
      if (owed > 250) owed = 250; // event loop stalled hard — don't death-spiral
      while (owed >= TICK_MS) {
        owed -= TICK_MS;
        this.step();
      }
    }, TICK_MS / 2);
  }

  destroy() {
    clearInterval(this.loop);
    rooms.delete(this.code);
  }

  // ---------- membership ----------

  /** Returns the new player id, or null if the room is full. */
  addHuman(ws: WebSocket, name: string, avatar?: string): string | null {
    const humans = [...this.entities.values()].filter((e) => !e.bot);

    if (this.phase === 'lobby') {
      if (humans.length >= C.TEAM_SIZE * 2) return null;
      const a = humans.filter((e) => e.team === 'A').length;
      const b = humans.filter((e) => e.team === 'B').length;
      const team: Team = a <= b ? 'A' : 'B';
      const id = `p${nextId++}`;
      const e: Entity = {
        id, name, team, bot: false, ws,
        dir: team === 'A' ? 0 : Math.PI,
        ...makeEntityDefaults(),
        avatar,
      };
      this.entities.set(id, e);
      this.placeAtFormation(e);
      if (!this.hostId) this.hostId = id;
      this.sendTo(e, { type: 'joined', room: this.code, playerId: id, team });
      this.broadcastLobby();
      this.broadcastAvatars();
      return id;
    }

    // Mid-match join: take over a bot slot if one exists (prefer the team
    // with fewer humans so late joiners balance sides).
    const bots = [...this.entities.values()].filter((e) => e.bot);
    if (!bots.length) return null;
    const humansOn = (t: Team) => humans.filter((e) => e.team === t).length;
    bots.sort((x, y) => humansOn(x.team) - humansOn(y.team));
    const slot = bots[0];
    slot.bot = false;
    slot.ws = ws;
    slot.name = name;
    slot.avatar = avatar;
    slot.input = idleInput();
    if (!this.hostId) this.hostId = slot.id;
    this.sendTo(slot, { type: 'joined', room: this.code, playerId: slot.id, team: slot.team });
    this.broadcastAvatars();
    return slot.id;
  }

  removePlayer(id: string) {
    const e = this.entities.get(id);
    if (!e) return;
    this.rematchVotes.delete(id);

    if (this.phase === 'lobby' || !C.BOT_FILL) {
      this.entities.delete(id);
    } else {
      // Mid-match: hand the body to a bot so the match stays playable.
      e.bot = true;
      e.ws = null;
      e.name = `Bot (${e.name})`;
      e.input = idleInput();
      delete e.avatar;
    }

    const humans = [...this.entities.values()].filter((p) => !p.bot);
    if (!humans.length) return this.destroy();
    if (this.hostId === id) this.hostId = humans[0].id;
    if (this.phase === 'lobby') this.broadcastLobby();
    this.broadcastAvatars();
  }

  // ---------- messages ----------

  onMessage(id: string, msg: ClientMsg) {
    const e = this.entities.get(id);
    if (!e) return;
    switch (msg.type) {
      case 'input': {
        let { mx, my } = msg;
        if (!Number.isFinite(mx) || !Number.isFinite(my)) return;
        const len = Math.hypot(mx, my);
        if (len > 1) {
          mx /= len;
          my /= len;
        }
        e.input = {
          mx, my,
          sprint: !!msg.sprint,
          pass: !!msg.pass,
          shoot: !!msg.shoot,
          lob: !!msg.lob,
        };
        break;
      }
      case 'start':
        if (id === this.hostId && this.phase === 'lobby') this.startMatch();
        break;
      case 'rematch': {
        if (this.phase !== 'ended') return;
        this.rematchVotes.add(id);
        const humans = [...this.entities.values()].filter((p) => !p.bot).length;
        if (this.rematchVotes.size * 2 > humans) this.resetMatch();
        break;
      }
    }
  }

  // ---------- match lifecycle ----------

  private startMatch() {
    if (C.BOT_FILL) this.fillBots();
    this.resetMatch();
  }

  private fillBots() {
    for (const team of ['A', 'B'] as Team[]) {
      let count = [...this.entities.values()].filter((e) => e.team === team).length;
      let n = 1;
      while (count < C.TEAM_SIZE) {
        const id = `p${nextId++}`;
        this.entities.set(id, {
          id, name: `Bot ${team}${n++}`, team, bot: true, ws: null,
          dir: team === 'A' ? 0 : Math.PI,
          ...makeEntityDefaults(),
        });
        count++;
      }
    }
  }

  private resetMatch() {
    this.score = [0, 0];
    this.timeLeft = C.MATCH_SECONDS;
    this.rematchVotes.clear();
    this.kickoffReset();
    this.phase = 'playing';
    this.broadcastEvent({ type: 'event', kind: 'kickoff' });
  }

  /** Everyone back to formation spots, ball to center, all motion zeroed. */
  private kickoffReset() {
    this.ball = { x: C.PITCH_W / 2, y: C.PITCH_H / 2, z: 0, vx: 0, vy: 0, vz: 0 };
    this.ownerId = null;
    for (const e of this.entities.values()) {
      this.placeAtFormation(e);
      e.vx = 0;
      e.vy = 0;
      e.passHeldMs = e.shootHeldMs = e.lobHeldMs = 0;
      e.lungeTicks = e.recoverTicks = 0;
      e.kickCooldownUntil = e.tackleCooldownUntil = 0;
      if (e.bot) e.input = idleInput();
    }
  }

  private placeAtFormation(e: Entity) {
    const mates = [...this.entities.values()].filter((p) => p.team === e.team);
    const idx = Math.max(0, mates.indexOf(e));
    const n = Math.max(mates.length, C.TEAM_SIZE);
    const fx = 0.25; // own-half column
    const fy = (idx + 1) / (n + 1);
    e.x = C.PITCH_W * (e.team === 'A' ? fx : 1 - fx);
    e.y = C.PITCH_H * fy;
    e.dir = e.team === 'A' ? 0 : Math.PI;
  }

  private goal(team: Team) {
    this.score[team === 'A' ? 0 : 1]++;
    this.phase = 'goal';
    this.pauseUntilTick = this.tick + Math.round(C.GOAL_PAUSE_MS / TICK_MS);
    this.kickoffReset();
    this.broadcastEvent({ type: 'event', kind: 'goal', team, score: [...this.score] as [number, number] });
  }

  private endMatch() {
    this.phase = 'ended';
    const [a, b] = this.score;
    const winner = a > b ? 'A' : b > a ? 'B' : 'draw';
    this.broadcastEvent({ type: 'event', kind: 'matchEnd', winner, score: [a, b] });
  }

  // ---------- simulation ----------

  private step() {
    this.tick++;

    if (this.phase === 'playing') {
      for (const e of this.entities.values()) if (e.bot) botThink(this, e);
      this.physics();
      this.timeLeft -= DT;
      if (this.timeLeft <= 0 && this.phase === 'playing') this.endMatch();
    } else if (this.phase === 'goal' && this.tick >= this.pauseUntilTick) {
      this.phase = 'playing';
      this.broadcastEvent({ type: 'event', kind: 'kickoff' });
    }

    // Broadcast every tick in every phase — 6 players of JSON at 30Hz is
    // trivially cheap and lets the client drive all UI off `state.phase`.
    this.broadcastState();
  }

  private physics() {
    const list = [...this.entities.values()];

    // players: accelerate toward held input, damp when idle, clamp speed.
    // Sprint raises the cap, a missed tackle (recover) lowers it, and a lunge
    // overrides velocity entirely for a few ticks.
    for (const e of list) {
      const { mx, my } = e.input;
      if (e.lungeTicks > 0) {
        e.lungeTicks--;
        e.vx = e.lungeVx;
        e.vy = e.lungeVy;
        if (e.lungeTicks === 0) e.recoverTicks = C.TACKLE_RECOVER_TICKS; // lunge spent
      } else {
        let accel = C.PLAYER_ACCEL;
        let maxSp = C.PLAYER_SPEED;
        if (e.input.sprint && (mx || my)) {
          accel *= C.SPRINT_ACCEL_MULT;
          maxSp *= C.SPRINT_MULT;
        }
        if (e.recoverTicks > 0) {
          e.recoverTicks--;
          accel *= 0.5;
          maxSp *= 0.55;
        }
        e.vx += mx * accel * DT;
        e.vy += my * accel * DT;
        if (!mx && !my) {
          const damp = Math.max(0, 1 - C.PLAYER_FRICTION * DT);
          e.vx *= damp;
          e.vy *= damp;
        }
        const sp = Math.hypot(e.vx, e.vy);
        if (sp > maxSp) {
          e.vx *= maxSp / sp;
          e.vy *= maxSp / sp;
        }
      }
      e.x = clamp(e.x + e.vx * DT, C.PLAYER_RADIUS, C.PITCH_W - C.PLAYER_RADIUS);
      e.y = clamp(e.y + e.vy * DT, C.PLAYER_RADIUS, C.PITCH_H - C.PLAYER_RADIUS);
      if ((mx || my) && e.lungeTicks === 0) e.dir = Math.atan2(my, mx);
    }

    // players shove each other apart (no overlap)
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const min = C.PLAYER_RADIUS * 2;
        if (d > 0 && d < min) {
          const push = (min - d) / 2;
          a.x -= (dx / d) * push;
          a.y -= (dy / d) * push;
          b.x += (dx / d) * push;
          b.y += (dy / d) * push;
        }
      }
    }

    // ball: 2D roll + vertical flight (z up, simple projectile + bounce)
    const ball = this.ball;
    ball.x += ball.vx * DT;
    ball.y += ball.vy * DT;
    ball.z += ball.vz * DT;
    ball.vz -= C.BALL_GRAVITY * DT;
    if (ball.z <= 0) {
      ball.z = 0;
      if (ball.vz < 0) {
        ball.vz = -ball.vz * C.BALL_BOUNCE;
        if (ball.vz < 60) ball.vz = 0; // stop micro-bouncing
        // grass grabs the ball a little on every landing
        ball.vx *= 0.85;
        ball.vy *= 0.85;
      }
    }
    // grass friction only while rolling; light air drag while flying
    const f = Math.exp(-(ball.z > 1 ? C.BALL_AIR_DRAG : C.BALL_FRICTION) * DT);
    ball.vx *= f;
    ball.vy *= f;

    // walls — but the end walls have goal-mouth openings the ball passes through
    if (ball.y < C.BALL_RADIUS) {
      ball.y = C.BALL_RADIUS;
      ball.vy = Math.abs(ball.vy) * C.WALL_BOUNCE;
    }
    if (ball.y > C.PITCH_H - C.BALL_RADIUS) {
      ball.y = C.PITCH_H - C.BALL_RADIUS;
      ball.vy = -Math.abs(ball.vy) * C.WALL_BOUNCE;
    }
    // goal line: only counts under the crossbar; above it the ball bounces
    // back off the (invisible) frame like a wall
    const inMouth =
      Math.abs(ball.y - C.PITCH_H / 2) < C.GOAL_WIDTH / 2 && ball.z < C.GOAL_HEIGHT;
    if (!inMouth) {
      if (ball.x < C.BALL_RADIUS) {
        ball.x = C.BALL_RADIUS;
        ball.vx = Math.abs(ball.vx) * C.WALL_BOUNCE;
      }
      if (ball.x > C.PITCH_W - C.BALL_RADIUS) {
        ball.x = C.PITCH_W - C.BALL_RADIUS;
        ball.vx = -Math.abs(ball.vx) * C.WALL_BOUNCE;
      }
    } else {
      // ball fully across an end line inside the mouth = goal.
      // Team A attacks the RIGHT goal, team B the LEFT.
      if (ball.x < -C.BALL_RADIUS) return this.goal('B');
      if (ball.x > C.PITCH_W + C.BALL_RADIUS) return this.goal('A');
    }

    // ---- possession + ball control ----
    this.updatePossession(list);
    const owner = this.ownerId ? this.entities.get(this.ownerId) : undefined;

    if (ball.z < C.KICKABLE_HEIGHT) {
      if (owner) {
        // DRIBBLING: the ball is carried at the feet. A critically-damped
        // spring (not teleport) keeps it there so motion still looks physical
        // through the interpolation. Sprinting pushes the ball further ahead
        // — real knock-on dribbling — walking keeps it glued tight.
        const speed = Math.hypot(owner.vx, owner.vy);
        const leadMult = owner.input.sprint ? C.SPRINT_LEAD_MULT : 1;
        const lead = C.PLAYER_RADIUS + C.BALL_RADIUS + 2 + speed * C.DRIBBLE_LEAD * leadMult;
        const tx = owner.x + Math.cos(owner.dir) * lead;
        const ty = owner.y + Math.sin(owner.dir) * lead;
        const k = 1 - Math.exp(-C.CARRY_SPRING * DT);
        ball.x += (tx - ball.x) * k;
        ball.y += (ty - ball.y) * k;
        ball.vx = owner.vx;
        ball.vy = owner.vy;
        ball.z *= 0.5;
        ball.vz = 0;
      }

      // body blocks for everyone else: standing in the ball's path deflects
      // it — a stationary defender cushions it dead (that's a block/trap),
      // a moving one knocks it onward
      for (const e of list) {
        if (e === owner) continue;
        const dx = ball.x - e.x, dy = ball.y - e.y;
        const d = Math.hypot(dx, dy);
        const min = C.PLAYER_RADIUS + C.BALL_RADIUS;
        if (d > 0.0001 && d < min) {
          const nx = dx / d, ny = dy / d;
          ball.x = e.x + nx * min;
          ball.y = e.y + ny * min;
          const rel = Math.hypot(ball.vx - e.vx, ball.vy - e.vy);
          ball.vx = e.vx + nx * Math.max(C.DRIBBLE_PUSH, rel * 0.3);
          ball.vy = e.vy + ny * Math.max(C.DRIBBLE_PUSH, rel * 0.3);
        }
      }
    }

    // ---- PES-style actions ----
    for (const e of list) this.processActions(e, owner);
  }

  /**
   * PES action model. Buttons are held state; charge accumulates while held
   * and the action fires on RELEASE (shoot/lob power = hold time; pass power
   * is automatic from target distance). The PASS button is context-sensitive:
   * when you're NOT on the ball its rising edge is a pressure/tackle lunge.
   */
  private processActions(e: Entity, owner: Entity | undefined) {
    const ball = this.ball;
    const dist = Math.hypot(ball.x - e.x, ball.y - e.y);
    const canPlay = (owner === e || dist <= C.KICK_RADIUS) && ball.z < C.KICKABLE_HEIGHT;

    // pressure/tackle on pass rising edge while defending
    if (e.input.pass && !e.prevPass && !canPlay) this.tryTackle(e);
    e.prevPass = e.input.pass;

    const fire = (kind: 'pass' | 'shoot' | 'lob', heldMs: number) => {
      if (!canPlay) return;
      const t = Math.min(1, heldMs / C.KICK_CHARGE_MS);
      if (kind === 'pass') this.doPass(e);
      else if (kind === 'shoot') this.doShoot(e, t);
      else this.doLob(e);
      if (this.ownerId === e.id) this.ownerId = null;
      e.kickCooldownUntil = this.tick + C.KICK_COOLDOWN_TICKS;
    };

    if (e.input.pass) e.passHeldMs += DT * 1000;
    else if (e.passHeldMs > 0) {
      const ms = e.passHeldMs;
      e.passHeldMs = 0;
      fire('pass', ms);
    }
    if (e.input.shoot) e.shootHeldMs += DT * 1000;
    else if (e.shootHeldMs > 0) {
      const ms = e.shootHeldMs;
      e.shootHeldMs = 0;
      fire('shoot', ms);
    }
    if (e.input.lob) e.lobHeldMs += DT * 1000;
    else if (e.lobHeldMs > 0) {
      const ms = e.lobHeldMs;
      e.lobHeldMs = 0;
      fire('lob', ms);
    }
  }

  /** Best pass target: teammate inside the facing cone, near beats far,
   *  straight-ahead beats wide. Aimed with velocity lead (PES-style). */
  private doPass(e: Entity) {
    const ball = this.ball;
    const cone = (C.PASS_CONE_DEG * Math.PI) / 180;
    let best: Entity | undefined;
    let bestScore = Infinity;
    for (const m of this.entities.values()) {
      if (m.team !== e.team || m === e) continue;
      const d = Math.hypot(m.x - e.x, m.y - e.y);
      let ang = Math.atan2(m.y - e.y, m.x - e.x) - e.dir;
      while (ang > Math.PI) ang -= Math.PI * 2;
      while (ang < -Math.PI) ang += Math.PI * 2;
      if (Math.abs(ang) > cone / 2) continue;
      const score = d + Math.abs(ang) * 220; // wide targets pay a distance penalty
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    let aimX: number, aimY: number, d: number;
    if (best) {
      d = Math.hypot(best.x - e.x, best.y - e.y);
      const power = clamp(340 + d * 0.9, C.PASS_MIN, C.PASS_MAX);
      const flight = d / power; // rough travel time for the lead
      aimX = best.x + best.vx * flight * 0.9;
      aimY = best.y + best.vy * flight * 0.9;
    } else {
      aimX = e.x + Math.cos(e.dir) * 200; // nobody open: play it into space ahead
      aimY = e.y + Math.sin(e.dir) * 200;
    }
    d = Math.hypot(aimX - e.x, aimY - e.y);
    const power = clamp(340 + d * 0.9, C.PASS_MIN, C.PASS_MAX);
    const ang = Math.atan2(aimY - e.y, aimX - e.x);
    ball.vx = Math.cos(ang) * power;
    ball.vy = Math.sin(ang) * power;
    ball.vz = power * C.PASS_LIFT;
  }

  /** Lofted through ball to the most advanced teammate ahead, else into space. */
  private doLob(e: Entity) {
    const ball = this.ball;
    const attackX = e.team === 'A' ? C.PITCH_W : 0;
    let best: Entity | undefined;
    let bestAdv = -Infinity;
    for (const m of this.entities.values()) {
      if (m.team !== e.team || m === e) continue;
      let ang = Math.atan2(m.y - e.y, m.x - e.x) - e.dir;
      while (ang > Math.PI) ang -= Math.PI * 2;
      while (ang < -Math.PI) ang += Math.PI * 2;
      if (Math.abs(ang) > Math.PI * 0.75) continue; // not behind me
      const adv = -Math.abs(attackX - m.x); // closer to opponent goal = better
      if (adv > bestAdv) {
        bestAdv = adv;
        best = m;
      }
    }
    let aimX: number, aimY: number;
    if (best) {
      const d0 = Math.hypot(best.x - e.x, best.y - e.y);
      const flight = d0 / 600;
      aimX = best.x + best.vx * flight;
      aimY = best.y + best.vy * flight;
    } else {
      aimX = e.x + Math.cos(e.dir) * 320;
      aimY = e.y + Math.sin(e.dir) * 320;
    }
    const d = Math.hypot(aimX - e.x, aimY - e.y);
    const power = clamp(420 + d * 0.85, C.LOB_MIN, C.LOB_MAX);
    const ang = Math.atan2(aimY - e.y, aimX - e.x);
    ball.vx = Math.cos(ang) * power;
    ball.vy = Math.sin(ang) * power;
    ball.vz = power * C.LOB_LIFT;
  }

  /** Shot: locked to the goal you attack; placement comes from your facing's
   *  vertical component, power and loft from the charge. */
  private doShoot(e: Entity, t: number) {
    const ball = this.ball;
    const goalX = e.team === 'A' ? C.PITCH_W : 0;
    const place = clamp(Math.sin(e.dir) * 1.4, -1, 1) * C.SHOT_PLACE_MAX;
    const aimY = C.PITCH_H / 2 + place * C.GOAL_WIDTH;
    const power = C.SHOT_MIN + (C.SHOT_MAX - C.SHOT_MIN) * t;
    const ang = Math.atan2(aimY - e.y, goalX - e.x);
    ball.vx = Math.cos(ang) * power;
    ball.vy = Math.sin(ang) * power;
    ball.vz = power * (C.SHOT_LIFT_BASE + C.SHOT_LIFT_RANGE * t);
  }

  /** Pressure lunge: commit toward where the ball is going. Win it clean via
   *  updatePossession's lunge priority, or stumble (recover) if you miss. */
  private tryTackle(e: Entity) {
    if (this.tick < e.tackleCooldownUntil || e.recoverTicks > 0 || e.lungeTicks > 0) return;
    const ball = this.ball;
    const dx = ball.x + ball.vx * 0.15 - e.x;
    const dy = ball.y + ball.vy * 0.15 - e.y;
    const d = Math.hypot(dx, dy);
    if (d > 160 || d < 0.001) return; // too far to bother
    e.lungeVx = (dx / d) * C.TACKLE_SPEED;
    e.lungeVy = (dy / d) * C.TACKLE_SPEED;
    e.lungeTicks = C.TACKLE_TICKS;
    e.tackleCooldownUntil = this.tick + C.TACKLE_COOLDOWN_TICKS;
  }

  /**
   * Decides who (if anyone) controls the ball this tick.
   *  - possession needs the ball low, close, and not flying past (a fast
   *    arriving ball gets CUSHIONED — a first touch — and is controllable
   *    next tick once slowed)
   *  - the current owner keeps it unless a challenger is clearly closer
   *    (STEAL_RATIO hysteresis stops two players flickering ownership)
   *  - players who just kicked are ineligible until their cooldown expires
   */
  private updatePossession(list: Entity[]) {
    const ball = this.ball;
    if (ball.z >= C.KICKABLE_HEIGHT) {
      this.ownerId = null;
      return;
    }
    const eligible = (e: Entity) => this.tick >= e.kickCooldownUntil && e.recoverTicks === 0;
    const distTo = (e: Entity) => Math.hypot(ball.x - e.x, ball.y - e.y);

    // a mid-lunge tackler who reaches the ball WINS it outright — that's the
    // payoff of committing to the tackle. The dispossessed player stumbles.
    for (const e of this.entities.values()) {
      if (e.lungeTicks > 0 && distTo(e) < C.CONTROL_RADIUS * 1.1) {
        const prev = this.ownerId ? this.entities.get(this.ownerId) : undefined;
        if (prev && prev !== e) prev.recoverTicks = C.TACKLE_RECOVER_TICKS;
        if (this.ownerId !== e.id) this.ownerSince = this.tick;
        this.ownerId = e.id;
        e.lungeTicks = 0; // lunge consumed by the win — no stumble
        return;
      }
    }

    let owner = this.ownerId ? this.entities.get(this.ownerId) : undefined;
    if (owner && (!eligible(owner) || distTo(owner) > C.CONTROL_RADIUS * 1.2)) owner = undefined;

    let nearest: Entity | undefined;
    let nearestD = Infinity;
    for (const e of list) {
      if (!eligible(e)) continue;
      const d = distTo(e);
      if (d < C.CONTROL_RADIUS && d < nearestD) {
        nearest = e;
        nearestD = d;
      }
    }

    if (!owner) {
      if (nearest) {
        const rel = Math.hypot(ball.vx - nearest.vx, ball.vy - nearest.vy);
        if (rel > C.CONTROL_MAX_REL_SPEED) {
          // first touch: kill most of the ball's speed, control it next tick
          ball.vx = nearest.vx + (ball.vx - nearest.vx) * C.TRAP_DAMP;
          ball.vy = nearest.vy + (ball.vy - nearest.vy) * C.TRAP_DAMP;
          this.ownerId = null;
        } else {
          this.ownerId = nearest.id;
          this.ownerSince = this.tick;
        }
      } else {
        this.ownerId = null;
      }
    } else if (
      nearest &&
      nearest !== owner &&
      nearestD < distTo(owner) * C.STEAL_RATIO &&
      // minimum hold: shoulder-to-shoulder contact can't flip possession
      // every tick (that deadlocks both players) — stealing without a proper
      // tackle lunge needs the owner to have HAD the ball for a beat
      this.tick - this.ownerSince > 8
    ) {
      this.ownerId = nearest.id;
      this.ownerSince = this.tick;
    } else {
      this.ownerId = owner.id;
    }
  }

  // ---------- outbound ----------

  private snapshot(): ServerMsg {
    return {
      type: 'state',
      tick: this.tick,
      phase: this.phase,
      players: [...this.entities.values()].map((e) => ({
        id: e.id,
        team: e.team,
        name: e.name,
        bot: e.bot,
        x: round1(e.x),
        y: round1(e.y),
        vx: round1(e.vx),
        vy: round1(e.vy),
        dir: Math.round(e.dir * 100) / 100,
        charge: Math.min(1, Math.max(e.passHeldMs, e.shootHeldMs, e.lobHeldMs) / C.KICK_CHARGE_MS),
      })),
      ball: {
        x: round1(this.ball.x),
        y: round1(this.ball.y),
        z: round1(this.ball.z),
        vx: round1(this.ball.vx),
        vy: round1(this.ball.vy),
        vz: round1(this.ball.vz),
      },
      score: [this.score[0], this.score[1]],
      timeLeft: Math.max(0, Math.ceil(this.timeLeft)),
    };
  }

  private broadcastState() {
    const json = JSON.stringify(this.snapshot());
    for (const e of this.entities.values()) {
      if (e.ws && e.ws.readyState === 1) e.ws.send(json);
    }
  }

  private broadcastEvent(msg: ServerMsg) {
    const json = JSON.stringify(msg);
    for (const e of this.entities.values()) {
      if (e.ws && e.ws.readyState === 1) e.ws.send(json);
    }
  }

  /** Full avatar map to everyone. Sent on membership change only — photos are
   *  a few KB each, far too big to ride along in the 30Hz state snapshots. */
  broadcastAvatars() {
    const avatars: Record<string, string> = {};
    for (const e of this.entities.values()) {
      if (e.avatar) avatars[e.id] = e.avatar;
    }
    this.broadcastEvent({ type: 'avatars', avatars });
  }

  broadcastLobby() {
    const players = [...this.entities.values()].map((e) => ({
      id: e.id,
      name: e.name,
      team: e.team,
      host: e.id === this.hostId,
    }));
    for (const e of this.entities.values()) {
      this.sendTo(e, { type: 'lobby', players, youAreHost: e.id === this.hostId });
    }
  }

  sendTo(e: Entity, msg: ServerMsg) {
    if (e.ws && e.ws.readyState === 1) e.ws.send(JSON.stringify(msg));
  }
}
