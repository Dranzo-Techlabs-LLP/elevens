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
  },
});
