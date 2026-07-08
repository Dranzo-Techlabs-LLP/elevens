// Client <-> server message protocol. JSON over a single WebSocket.
export type Team = 'A' | 'B';
export type Phase = 'lobby' | 'playing' | 'goal' | 'ended';

export interface PlayerSnap {
  id: string;
  team: Team;
  name: string;
  bot: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  dir: number;    // facing angle, radians
  charge: number; // 0..1 kick charge, for rendering the charge ring
}

export interface BallSnap {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export type ClientMsg =
  // room: null = create a new room; otherwise a 4-letter code
  | { type: 'join'; room: string | null; name: string }
  // held input state, last-write-wins on the server. seq is unused for now —
  // it exists so client-side prediction/reconciliation can be added later
  // without a protocol change.
  | { type: 'input'; seq: number; mx: number; my: number; kick: boolean }
  | { type: 'start' }    // host only, from the lobby
  | { type: 'rematch' }  // vote; majority of humans restarts the match
  | { type: 'ping'; t: number }; // latency probe, t = client timestamp

export type ServerMsg =
  | { type: 'joined'; room: string; playerId: string; team: Team }
  | {
      type: 'lobby';
      players: { id: string; name: string; team: Team; host: boolean }[];
      youAreHost: boolean;
    }
  | {
      type: 'state';
      tick: number;
      phase: Phase;
      players: PlayerSnap[];
      ball: BallSnap;
      score: [number, number]; // [teamA, teamB]
      timeLeft: number;        // whole seconds
    }
  | {
      type: 'event';
      kind: 'goal' | 'kickoff' | 'matchEnd';
      team?: Team;                  // who scored (goal)
      score?: [number, number];
      winner?: Team | 'draw';       // matchEnd
    }
  | { type: 'pong'; t: number } // echo of ping.t
  | { type: 'error'; msg: string };
