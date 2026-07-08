import type { ClientMsg, ServerMsg } from '../shared/protocol';

export type StateMsg = Extract<ServerMsg, { type: 'state' }>;

export class Net {
  private ws: WebSocket | null = null;
  onMsg: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};

  // Snapshot ring buffer for interpolation. Each snapshot is stamped with
  // LOCAL receive time — no server/client clock sync needed; the renderer
  // only ever compares local timestamps with each other.
  buffer: { at: number; s: StateMsg }[] = [];

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('connection failed'));
      ws.onclose = () => this.onClose();
      ws.onmessage = (ev) => {
        const m: ServerMsg = JSON.parse(ev.data);
        if (m.type === 'state') {
          this.buffer.push({ at: performance.now(), s: m });
          if (this.buffer.length > 90) this.buffer.shift(); // keep ~3s
        }
        this.onMsg(m);
      };
    });
  }

  send(m: ClientMsg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1;
  }
}
