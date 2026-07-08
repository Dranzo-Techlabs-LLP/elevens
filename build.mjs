// Production build: bundles the browser client and a self-contained Node
// server (app.js) so deployment needs only app.js + public/ — no node_modules.
import { build } from 'esbuild';

// Client: browser bundle served as public/main.js
await build({
  entryPoints: ['src/client/main.ts'],
  bundle: true,
  minify: true,
  outfile: 'public/main.js',
});

// Server: single ESM file runnable with `node app.js`.
// ws is CommonJS and calls require() for Node built-ins; ESM output has no
// require(), so inject one via createRequire. bufferutil/utf-8-validate are
// ws's optional native speedups — left external, ws falls back to pure JS.
await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  minify: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  outfile: 'app.js',
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);",
  },
});

console.log('build complete: app.js + public/main.js');
