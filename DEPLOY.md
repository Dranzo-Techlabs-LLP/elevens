# Deploying ELEVENS

ELEVENS is a single Node.js process (HTTP + WebSockets, rooms in memory), not a
static site. `npm run build` produces a **self-contained `app.js`** that bundles
the server and the `ws` library, so a deploy needs only `app.js` + `public/` —
no `node_modules` on the target.

```bash
npm install
npm run build      # -> app.js  +  public/main.js
npm start          # node app.js   (PORT=8080 npm start to override the port)
```

The server listens on `process.env.PORT` when set (Passenger, most PaaS),
otherwise `CONFIG.PORT` (3011). The browser client connects with `wss://` on
HTTPS pages and `ws://` otherwise — no host/port is hardcoded, so it works
unchanged behind any reverse proxy.

## cPanel / WHM (Passenger)

This must run under cPanel's **Setup Node.js App**, not dropped into
`public_html`.

1. **cPanel → Software → Setup Node.js App → Create Application**
   - Node.js version: **18 or newer**
   - Application mode: **Production**
   - Application root: e.g. `elevens` (creates `/home/<user>/elevens`)
   - Application URL: the domain/subdomain to serve from
   - Application startup file: **`app.js`** → **Create**

2. Build locally (`npm run build`) and upload `app.js` + the `public/` folder
   into the Application root, keeping the structure (`app.js` at the root,
   `public/` beside it). A minimal `package.json` with
   `"scripts": { "start": "node app.js" }` is enough; dependencies are bundled,
   so you can skip **Run NPM Install**.

3. Back on the Node.js App page, click **Restart**, then open the URL.

Notes:
- WebSockets are proxied by Passenger automatically — no extra config.
- Use an HTTPS domain (AutoSSL/Let's Encrypt); mobile browsers throttle plain
  `ws://`. The host must allow Passenger WebSocket upgrades.
- Rooms are in-memory: restarting the app clears all active games.

## Cheap VPS (Ubuntu)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
git clone <this-repo> elevens && cd elevens
npm ci
npm run build
npm start                       # serves on :3011 (or $PORT)
```

Put Caddy in front for free HTTPS + automatic WebSocket proxying:

```
# /etc/caddy/Caddyfile
yourdomain.com {
    reverse_proxy localhost:3011
}
```

Keep it alive with `npm i -g pm2 && pm2 start "npm start" --name elevens`.
