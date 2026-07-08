import type { WebSocket } from 'ws';
import { CONFIG as C } from '../shared/config';
import type { ClientMsg, Phase, ServerMsg, Team } from '../shared/protocol';
import { botThink } from './bot';

const DT = 1 / C.TICK_RATE;      // fixed timestep, seconds
const TICK_MS = 1000 / C.TICK_RATE;

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
  input: { mx: number; my: number; kick: boolean };
  kickHeldMs: number; // >0 while charging a kick; fires on release
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
  ball = { x: C.PITCH_W / 2, y: C.PITCH_H / 2, vx: 0, vy: 0 };
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
  addHuman(ws: WebSocket, name: string): string | null {
    const humans = [...this.entities.values()].filter((e) => !e.bot);

    if (this.phase === 'lobby') {
      if (humans.length >= C.TEAM_SIZE * 2) return null;
      const a = humans.filter((e) => e.team === 'A').length;
      const b = humans.filter((e) => e.team === 'B').length;
      const team: Team = a <= b ? 'A' : 'B';
      const id = `p${nextId++}`;
      const e: Entity = {
        id, name, team, bot: false, ws,
        x: 0, y: 0, vx: 0, vy: 0, dir: team === 'A' ? 0 : Math.PI,
        input: { mx: 0, my: 0, kick: false },
        kickHeldMs: 0,
      };
      this.entities.set(id, e);
      this.placeAtFormation(e);
      if (!this.hostId) this.hostId = id;
      this.sendTo(e, { type: 'joined', room: this.code, playerId: id, team });
      this.broadcastLobby();
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
    slot.input = { mx: 0, my: 0, kick: false };
    if (!this.hostId) this.hostId = slot.id;
    this.sendTo(slot, { type: 'joined', room: this.code, playerId: slot.id, team: slot.team });
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
      e.input = { mx: 0, my: 0, kick: false };
    }

    const humans = [...this.entities.values()].filter((p) => !p.bot);
    if (!humans.length) return this.destroy();
    if (this.hostId === id) this.hostId = humans[0].id;
    if (this.phase === 'lobby') this.broadcastLobby();
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
        e.input = { mx, my, kick: !!msg.kick };
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
          x: 0, y: 0, vx: 0, vy: 0, dir: team === 'A' ? 0 : Math.PI,
          input: { mx: 0, my: 0, kick: false },
          kickHeldMs: 0,
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
    this.ball = { x: C.PITCH_W / 2, y: C.PITCH_H / 2, vx: 0, vy: 0 };
    for (const e of this.entities.values()) {
      this.placeAtFormation(e);
      e.vx = 0;
      e.vy = 0;
      e.kickHeldMs = 0;
      if (e.bot) e.input = { mx: 0, my: 0, kick: false };
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

    // players: accelerate toward held input, damp when idle, clamp speed
    for (const e of list) {
      const { mx, my } = e.input;
      e.vx += mx * C.PLAYER_ACCEL * DT;
      e.vy += my * C.PLAYER_ACCEL * DT;
      if (!mx && !my) {
        const damp = Math.max(0, 1 - C.PLAYER_FRICTION * DT);
        e.vx *= damp;
        e.vy *= damp;
      }
      const sp = Math.hypot(e.vx, e.vy);
      if (sp > C.PLAYER_SPEED) {
        e.vx *= C.PLAYER_SPEED / sp;
        e.vy *= C.PLAYER_SPEED / sp;
      }
      e.x = clamp(e.x + e.vx * DT, C.PLAYER_RADIUS, C.PITCH_W - C.PLAYER_RADIUS);
      e.y = clamp(e.y + e.vy * DT, C.PLAYER_RADIUS, C.PITCH_H - C.PLAYER_RADIUS);
      if (mx || my) e.dir = Math.atan2(my, mx);
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

    // ball: roll + friction
    const ball = this.ball;
    ball.x += ball.vx * DT;
    ball.y += ball.vy * DT;
    const f = Math.exp(-C.BALL_FRICTION * DT);
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
    const inMouth = Math.abs(ball.y - C.PITCH_H / 2) < C.GOAL_WIDTH / 2;
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

    // player-ball contact: push the ball out and give it the player's motion
    // plus a small nudge — dribbling emerges from this, no possession system
    for (const e of list) {
      const dx = ball.x - e.x, dy = ball.y - e.y;
      const d = Math.hypot(dx, dy);
      const min = C.PLAYER_RADIUS + C.BALL_RADIUS;
      if (d > 0.0001 && d < min) {
        const nx = dx / d, ny = dy / d;
        ball.x = e.x + nx * min;
        ball.y = e.y + ny * min;
        ball.vx = e.vx + nx * C.DRIBBLE_PUSH;
        ball.vy = e.vy + ny * C.DRIBBLE_PUSH;
      }
    }

    // kicks: charge while the button is held, fire on release
    for (const e of list) {
      if (e.input.kick) {
        e.kickHeldMs += DT * 1000;
        continue;
      }
      if (e.kickHeldMs > 0) {
        const t = Math.min(1, e.kickHeldMs / C.KICK_CHARGE_MS);
        e.kickHeldMs = 0;
        const d = Math.hypot(ball.x - e.x, ball.y - e.y);
        if (d <= C.KICK_RADIUS) {
          const power = C.KICK_MIN + (C.KICK_MAX - C.KICK_MIN) * t;
          ball.vx = Math.cos(e.dir) * power;
          ball.vy = Math.sin(e.dir) * power;
        }
      }
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
        charge: Math.min(1, e.kickHeldMs / C.KICK_CHARGE_MS),
      })),
      ball: {
        x: round1(this.ball.x),
        y: round1(this.ball.y),
        vx: round1(this.ball.vx),
        vy: round1(this.ball.vy),
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
