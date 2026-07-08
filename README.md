# ELEVENS — 3v3 real-time football MVP

Every human controls exactly ONE player. Browser-based, phone-friendly,
server-authoritative over WebSockets. Throwaway prototype to answer one
question: is one-human-one-player online football fun?

## Run

```bash
npm install
npm run dev
```

The server prints three URLs:

| URL | Use |
|---|---|
| `http://localhost:3011` | this machine |
| `http://<your-LAN-IP>:3011` | phones on the same wifi |
| `http://10.0.2.2:3011` | Android emulator (alias for the host machine) |

## Play

1. Enter a name → **Create room**. Share the 4-letter code.
2. Friends open the same URL → enter code → **Join**. Auto-assigned to the
   smaller team.
3. Host presses **Start match** — empty slots are filled with bots, so you can
   start solo and still get a 3v3.
4. Joining mid-match takes over a bot. Leaving mid-match hands your player to
   a bot.

### Controls

- **Desktop:** WASD / arrows to move. **Space** to kick — tap = pass,
  hold = charged shot (release to fire).
- **Phone:** touch anywhere on the left half for a virtual joystick.
  **KICK** button bottom-right — hold to charge, release to fire.

Match is 3 minutes. Full time → win/draw screen → **Rematch** (restarts when a
majority of humans vote).

## Tweak the game

Everything lives in [src/shared/config.ts](src/shared/config.ts) — team size,
tick rate, match length, speeds, ball friction, kick power, pitch size.
Save the file; server and client both hot-reload.

## Android emulator

```bash
~/Library/Android/sdk/emulator/emulator -avd <AVD_NAME> &
~/Library/Android/sdk/platform-tools/adb shell am start \
  -a android.intent.action.VIEW -d "http://10.0.2.2:3011" com.android.chrome
```

## How the netcode works (30 seconds)

- Server runs a fixed 30Hz tick: applies each player's held input, integrates
  physics, detects goals, broadcasts a full JSON snapshot to everyone.
- Clients send held input (joystick vector + kick button) on change plus a
  100ms heartbeat.
- The client renders **100ms in the past**, interpolating between the two
  snapshots that straddle that moment (`INTERP_DELAY_MS`). That jitter buffer
  is why movement looks smooth with zero prediction code.
- If it ever feels laggy on real networks: add client-side prediction for your
  own player only. The input protocol already carries a `seq` number for
  reconciliation, so no protocol change needed.

## Deploy to a cheap VPS (play over the internet)

Any $4–6/mo box (Hetzner CX22, DigitalOcean basic droplet) works — the whole
game is one Node process, rooms live in memory.

```bash
# on the VPS (Ubuntu)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
git clone <your-repo> elevens && cd elevens
npm ci
npm run build          # minified client bundle
npm start              # serves everything on :3011
# or pick a port: PORT=8080 npm start
```

Put Caddy in front for free HTTPS (phone browsers behave much better on
`wss://` than plain `ws://`):

```bash
sudo apt install -y caddy
# /etc/caddy/Caddyfile
#   yourdomain.com {
#       reverse_proxy localhost:3011
#   }
sudo systemctl reload caddy
```

Caddy proxies WebSockets automatically — no extra config. No domain? Use a
free DuckDNS subdomain, or run plain HTTP on the IP (works, but some mobile
browsers throttle non-secure WebSockets).

Keep it alive with `npm i -g pm2 && pm2 start "npm start" --name elevens`.

## Layout

```
src/
  shared/config.ts    all tunables (one file)
  shared/protocol.ts  client<->server message types
  server/index.ts     http + websocket entry
  server/room.ts      rooms, lobby, tick loop, physics, goals, score
  server/bot.ts       fill-in bot AI
  client/main.ts      canvas rendering + snapshot interpolation + UI
  client/net.ts       websocket + snapshot buffer
  client/input.ts     keyboard + virtual joystick + kick button
public/index.html     page shell, menus, styles
```
