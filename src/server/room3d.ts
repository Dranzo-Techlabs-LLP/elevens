// ============================================================
// 3D AUTHORITATIVE ROOM — wraps the isomorphic Match sim at a fixed 30Hz.
// Owns ball + player state; clients send inputs (seq'd), receive snapshots
// (with per-client input ack for prediction reconciliation) + events.
// Legacy 2.5D rooms coexist (A/B); this registry is separate.
// ============================================================
import type { WebSocket } from 'ws';
import RAPIER from '@dimforge/rapier3d-compat';
import { MATCH } from '../shared/config3d';
import { Match, idleFullInput, type PlayerFullInput } from '../shared/sim3d/match';
import { botThink } from '../shared/sim3d/bots';

let rapierReady: Promise<void> | null = null;
function ensureRapier() {
  return (rapierReady ??= RAPIER.init() as unknown as Promise<void>);
}

export const rooms3d = new Map<string, Room3D>();

interface Client {
  ws: WebSocket;
  playerIdx: number;
  lastSeq: number;
}

function code4(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c = '';
  do {
    c = Array.from({ length: 4 }, () => chars[(Math.random() * chars.length) | 0]).join('');
  } while (rooms3d.has(c));
  return c;
}

export class Room3D {
  code: string;
  match!: Match;
  clients = new Map<string, Client>(); // playerId -> client
  hostId: string | null = null;
  started = false;
  private loop: NodeJS.Timeout | null = null;
  private nextId = 1;

  static async create(): Promise<Room3D> {
    await ensureRapier();
    const r = new Room3D(code4());
    rooms3d.set(r.code, r);
    return r;
  }

  constructor(code: string) {
    this.code = code;
  }

  private send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
  private broadcast(msg: unknown) {
    const s = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws.readyState === 1) c.ws.send(s);
  }

  async addHuman(ws: WebSocket, name: string): Promise<string | null> {
    await ensureRapier();
    if (!this.match) {
      this.match = new Match(RAPIER, MATCH.tickRate);
      this.match.phase = 'lobby';
      this.match.timeLeft = 180;
    }
    const id = `p${this.nextId++}`;

    if (!this.started) {
      const humans = [...this.clients.values()].length;
      if (humans >= MATCH.teamSize * 2) return null;
      const teamCounts = [0, 0];
      for (const c of this.clients.values()) teamCounts[this.match.meta[c.playerIdx].team]++;
      const team = (teamCounts[0] <= teamCounts[1] ? 0 : 1) as 0 | 1;
      const idx = this.match.addPlayer(id, name, team, false);
      this.clients.set(id, { ws, playerIdx: idx, lastSeq: 0 });
    } else {
      // mid-match: take over a bot (prefer the team with fewer humans)
      const humansOn = [0, 0];
      for (const c of this.clients.values()) humansOn[this.match.meta[c.playerIdx].team]++;
      const bots = this.match.meta
        .map((m, idx) => ({ m, idx }))
        .filter((e) => e.m.bot)
        .sort((a, b) => humansOn[a.m.team] - humansOn[b.m.team]);
      if (!bots.length) return null;
      const slot = bots[0];
      slot.m.bot = false;
      slot.m.name = name;
      slot.m.id = id;
      this.clients.set(id, { ws, playerIdx: slot.idx, lastSeq: 0 });
    }
    if (!this.hostId) this.hostId = id;
    this.send(ws, {
      type: 'joined',
      room: this.code,
      playerId: id,
      team: this.match.meta[this.clients.get(id)!.playerIdx].team === 0 ? 'A' : 'B',
    });
    this.broadcastLobby();
    return id;
  }

  removePlayer(id: string) {
    const c = this.clients.get(id);
    if (!c) return;
    this.clients.delete(id);
    if (this.started) {
      const m = this.match.meta[c.playerIdx];
      m.bot = true;
      m.name = `Bot (${m.name})`;
      this.match.setInput(c.playerIdx, idleFullInput());
    }
    if (!this.clients.size) return this.destroy();
    if (this.hostId === id) this.hostId = [...this.clients.keys()][0];
    if (!this.started) this.broadcastLobby();
  }

  destroy() {
    if (this.loop) clearInterval(this.loop);
    rooms3d.delete(this.code);
  }

  broadcastLobby() {
    const players = this.match.meta.map((m) => ({
      id: m.id,
      name: m.name,
      team: m.team === 0 ? 'A' : 'B',
      host: m.id === this.hostId,
    }));
    for (const [pid, c] of this.clients) {
      this.send(c.ws, { type: 'lobby', players, youAreHost: pid === this.hostId });
    }
  }

  onMessage(id: string, msg: any) {
    const c = this.clients.get(id);
    if (!c) return;
    if (msg.type === 'i3') {
      const inp: PlayerFullInput = {
        mx: num(msg.mx),
        mz: num(msg.mz),
        sprint: !!msg.sprint,
        shield: !!msg.shield,
        pass: !!msg.pass,
        through: !!msg.through,
        shoot: !!msg.shoot,
        lob: !!msg.lob,
        tackle: !!msg.tackle,
        slide: !!msg.slide,
      };
      const len = Math.hypot(inp.mx, inp.mz);
      if (len > 1) {
        inp.mx /= len;
        inp.mz /= len;
      }
      this.match.setInput(c.playerIdx, inp);
      c.lastSeq = msg.seq | 0;
    } else if (msg.type === 'start' && id === this.hostId && !this.started) {
      this.start();
    } else if (msg.type === 'rematch' && this.match.phase === 'ended') {
      this.match.restart(180);
      this.broadcast({ type: 'e3', kind: 'kickoff' });
    }
  }

  start() {
    // fill both teams to size with bots
    const count: [number, number] = [0, 0];
    for (const m of this.match.meta) count[m.team]++;
    for (const team of [0, 1] as const) {
      let n = 1;
      while (count[team] < MATCH.teamSize) {
        this.match.addPlayer(`bot-${team}-${n}`, `Bot ${team === 0 ? 'A' : 'B'}${n}`, team, true);
        count[team]++;
        n++;
      }
    }
    this.started = true;
    this.match.restart(180);
    this.broadcast({ type: 'e3', kind: 'kickoff' });

    // fixed 30Hz authority loop with drift correction
    const TICK_MS = 1000 / MATCH.tickRate;
    let last = Date.now();
    let owed = 0;
    this.loop = setInterval(() => {
      const now = Date.now();
      owed += now - last;
      last = now;
      if (owed > 250) owed = 250;
      while (owed >= TICK_MS) {
        owed -= TICK_MS;
        this.stepOnce();
      }
    }, TICK_MS / 2);
  }

  private stepOnce() {
    // bots think at full rate (same input API as humans)
    for (let i = 0; i < this.match.meta.length; i++) {
      if (this.match.meta[i].bot) this.match.setInput(i, botThink(this.match, i));
    }
    const events = this.match.step();
    const snap = this.match.snapshot();
    for (const ev of events) {
      if (ev.detail === 'goal') {
        this.broadcast({ type: 'e3', kind: 'goal', team: ev.playerIndex === 0 ? 'A' : 'B', score: snap.score });
      } else if (ev.detail === 'fulltime') {
        const [a, b] = snap.score;
        this.broadcast({ type: 'e3', kind: 'end', winner: a > b ? 'A' : b > a ? 'B' : 'draw', score: snap.score });
      } else if (ev.detail === 'kickoff') {
        this.broadcast({ type: 'e3', kind: 'kickoff' });
      } else if (ev.detail === 'throwin' || ev.detail === 'goalkick' || ev.detail === 'corner' || ev.detail === 'penalty') {
        this.broadcast({ type: 'e3', kind: 'restart', what: ev.detail, id: this.match.meta[ev.playerIndex]?.id });
      } else if (ev.kind === 'save') {
        this.broadcast({ type: 'e3', kind: 'save', id: this.match.meta[ev.playerIndex]?.id, how: ev.detail, side: ev.side ?? 0 });
      } else if (ev.detail === 'throw') {
        this.broadcast({ type: 'e3', kind: 'throw', id: this.match.meta[ev.playerIndex]?.id });
      } else if (ev.detail === 'freekick' || ev.detail === 'advantage') {
        this.broadcast({
          type: 'e3',
          kind: ev.detail,
          id: this.match.meta[ev.playerIndex]?.id,
          name: this.match.meta[ev.playerIndex]?.name,
        });
      } else if (ev.detail === 'yellow' || ev.detail === 'red') {
        this.broadcast({
          type: 'e3',
          kind: 'card',
          color: ev.detail,
          id: this.match.meta[ev.playerIndex]?.id,
          name: this.match.meta[ev.playerIndex]?.name,
        });
      } else if (ev.detail === 'play-on') {
        // silent resume after a free kick pause — no banner
      } else if (ev.kind === 'foul') {
        this.broadcast({ type: 'e3', kind: 'foul', id: this.match.meta[ev.playerIndex]?.id });
      } else if (ev.kind === 'kick') {
        this.broadcast({ type: 'e3', kind: 'kick', id: this.match.meta[ev.playerIndex]?.id, tech: ev.tech });
      }
    }
    // per-client snapshot with their input ack (prediction reconciliation)
    const base = { type: 's3', ...snap, events: undefined };
    for (const c of this.clients.values()) {
      if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ ...base, ack: c.lastSeq }));
    }
  }
}

const num = (v: unknown) => (Number.isFinite(v as number) ? (v as number) : 0);
