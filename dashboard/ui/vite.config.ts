import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The panel API server. Both the dev server and `vite preview` proxy `/api/*` here so the
// bundle only ever talks to the same origin it was served from — no CDN, no third-party host.
const API = 'http://127.0.0.1:4317';
const apiProxy: Record<string, ProxyOptions> = {
  '/api': {
    target: API,
    changeOrigin: false,
    // /api/stream is SSE: never buffer, never time it out.
    configure: (proxy) => {
      proxy.on('error', () => { /* server restarting — the client's EventSource retries */ });
    },
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    // Contract §5 — the React app builds to dashboard/panel-dist/ (gitignored), which
    // server.mjs serves with an SPA fallback.
    outDir: '../panel-dist',
    emptyOutDir: true,
    sourcemap: false,
    // Everything is inlined/self-hosted; no dynamic CDN chunks.
    assetsInlineLimit: 4096,
  },
  server: { port: 5317, strictPort: false, proxy: apiProxy },
  preview: { port: 4318, strictPort: false, proxy: apiProxy },
});
