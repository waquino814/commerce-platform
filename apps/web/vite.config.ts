import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * The incident dashboard client (M7): React, TypeScript and Tailwind CSS, built by Vite into
 * apps/web/dist/client, which the dashboard server serves. In development, `pnpm web:dev` serves
 * the client on 127.0.0.1:5173 and proxies /api to the dashboard server on 127.0.0.1:3100.
 */
export default defineConfig({
  root: fileURLToPath(new URL('./client', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
    // No inline polyfill script, so the server's Content-Security-Policy can stay script-src 'self'.
    modulePreload: { polyfill: false },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:3100' },
  },
});
