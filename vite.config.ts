import { defineConfig } from 'vite';

// Vite serves the 3D lab + (later) the 3D game client. The legacy 2.5D game
// keeps its esbuild pipeline untouched (public/ + build.mjs) until the Rapier
// sim reaches feel parity (A/B flag plan).
export default defineConfig({
  server: { port: 5173 },
  build: {
    rollupOptions: {
      input: { lab: 'lab.html', play3d: 'play3d.html' },
    },
    outDir: 'dist-web',
    // Do NOT copy public/ into dist-web: public/ is the LEGACY game, and a
    // frozen copy inside dist-web would shadow the live one at serve time
    // (the node server checks dist-web first). Shared assets (chars GLB)
    // come from public/ via the server's fallback chain; vite's dev server
    // still exposes public/ as usual.
    copyPublicDir: false,
  },
});
