import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { CONFIG } from '../shared/config';
import type { ClientMsg } from '../shared/protocol';
import { Room, rooms } from './room';
import { Room3D, rooms3d } from './room3d';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Passenger (cPanel/WHM) and most PaaS assign the listen port via $PORT.
// Fall back to the configured dev port when it's absent.
const PORT = Number(process.env.PORT) || CONFIG.PORT;

// Static roots in priority order, both layouts (running from source under
// src/server/... and from a bundled app.js at the app root). dist-web is the
// vite production build of the 3D client (play3d.html + hashed assets);
// public/ keeps the legacy 2.5D game. First root that has the file wins, so
// a production 3D build shadows the dev copies.
const ROOTS = [
  path.resolve(__dirname, 'dist-web'),
  path.resolve(__dirname, '../../dist-web'),
  path.resolve(__dirname, 'public'),
  path.resolve(__dirname, '../../public'),
].filter((p) => fs.existsSync(p));
if (!ROOTS.length) ROOTS.push(path.resolve(__dirname, '../../public'));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

const server = http.createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0];
  // Decode, then hard-reject traversal BEFORE any path math. Node's HTTP
  // parser passes literal '..' through (curl --path-as-is), and a bare
  // startsWith prefix check can be fooled by a sibling dir sharing the
  // root's name as a prefix — so check segments, and compare with a
  // trailing separator.
  let rel: string;
  try {
    rel = decodeURIComponent(url);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  rel = rel === '/' ? 'index.html' : rel.replace(/^\/+/, '');
  if (rel.split(/[/\\]/).includes('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end();
  }
  const tryRoot = (i: number) => {
    if (i >= ROOTS.length) {
      res.writeHead(404);
      return res.end('not found');
    }
    const file = path.resolve(ROOTS[i], rel);
    if (!file.startsWith(ROOTS[i] + path.sep)) {
      res.writeHead(403);
      return res.end();
    }
    fs.readFile(file, (err, data) => {
      if (err) return tryRoot(i + 1);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  };
  tryRoot(0);
});

const wss = new WebSocketServer({ server });

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

type AliveWS = WebSocket & { isAlive?: boolean };

wss.on('connection', (ws: AliveWS) => {
  let room: Room | null = null;
  let room3d: Room3D | null = null;
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
    } else if (msg.type === 'join' && (msg as any).mode === '3d') {
      // 3D sim rooms (Rapier authority) — separate registry from legacy
      if (room || room3d) return;
      const name = String(msg.name || 'Player').slice(0, 12);
      (async () => {
        const target = (msg as any).room
          ? rooms3d.get(String((msg as any).room).toUpperCase().trim())
          : await Room3D.create();
        if (!target) return send(ws, { type: 'error', msg: 'Room not found' });
        const id = await target.addHuman(ws, name);
        if (!id) return send(ws, { type: 'error', msg: 'Room is full' });
        room3d = target;
        playerId = id;
      })();
    } else if (room3d && playerId) {
      room3d.onMessage(playerId, msg);
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
    if (room3d && playerId) room3d.removePlayer(playerId);
    room = null;
    room3d = null;
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
