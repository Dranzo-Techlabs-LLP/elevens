import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CONFIG } from '../shared/config';
import type { ClientMsg } from '../shared/protocol';
import { Room, rooms } from './room';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Passenger (cPanel/WHM) and most PaaS assign the listen port via $PORT.
// Fall back to the configured dev port when it's absent.
const PORT = Number(process.env.PORT) || CONFIG.PORT;

// Resolve the static dir for both layouts: running from source
// (src/server -> ../../public) and from a bundled app.js at the app root
// (./public). Pick whichever actually exists.
const PUBLIC = [
  path.resolve(__dirname, 'public'),
  path.resolve(__dirname, '../../public'),
].find((p) => fs.existsSync(p)) ?? path.resolve(__dirname, '../../public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  const file = path.join(PUBLIC, url === '/' ? 'index.html' : url);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

type AliveWS = WebSocket & { isAlive?: boolean };

wss.on('connection', (ws: AliveWS) => {
  let room: Room | null = null;
  let playerId: string | null = null;

  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'ping') {
      send(ws, { type: 'pong', t: msg.t });
    } else if (msg.type === 'join') {
      if (room) return;
      const name = String(msg.name || 'Player').slice(0, 12);
      // avatar: only accept a small base64 image data URL (client sends ~4KB)
      const avatar =
        typeof msg.avatar === 'string' &&
        /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(msg.avatar) &&
        msg.avatar.length <= 64_000
          ? msg.avatar
          : undefined;
      const target = msg.room ? rooms.get(String(msg.room).toUpperCase().trim()) : Room.create();
      if (!target) return send(ws, { type: 'error', msg: 'Room not found' });
      const id = target.addHuman(ws, name, avatar);
      if (!id) return send(ws, { type: 'error', msg: 'Room is full' });
      room = target;
      playerId = id;
    } else if (room && playerId) {
      room.onMessage(playerId, msg);
    }
  });

  ws.on('close', () => {
    if (room && playerId) room.removePlayer(playerId);
    room = null;
    playerId = null;
  });
});

// Reap dead connections: browsers on flaky mobile networks can vanish without
// a TCP close. Protocol-level ping every 10s; no pong by the next sweep ->
// terminate, which fires 'close' and hands the player to a bot.
setInterval(() => {
  for (const client of wss.clients as Set<AliveWS>) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
}, 10_000);

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lan = Object.values(nets)
    .flat()
    .find((n) => n && n.family === 'IPv4' && !n.internal)?.address;
  console.log(`ELEVENS server up:`);
  console.log(`  local:    http://localhost:${PORT}`);
  if (lan) console.log(`  phone:    http://${lan}:${PORT}   (same wifi)`);
  console.log(`  emulator: http://10.0.2.2:${PORT}`);
});
