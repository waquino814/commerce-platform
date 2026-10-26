import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

/**
 * The Commerce UI (M7): a static React client for the orders API. The browser calls same-origin
 * `/api/*` (VITE_API_BASE_URL); the dev and preview servers proxy it to ORDERS_API_URL, so the
 * API needs no CORS. Both read the repository's .env, like the other tools.
 */
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, repoRoot, ''), ...process.env };
  const target = env.ORDERS_API_URL?.trim() || 'http://127.0.0.1:3000';
  if (!URL.canParse(target) || !/^https?:$/.test(new URL(target).protocol)) {
    throw new Error(`ORDERS_API_URL must be an http(s) URL, got "${target}"`);
  }
  const proxy = {
    '/api': {
      target,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, ''),
    },
  };
  return {
    root: fileURLToPath(new URL('.', import.meta.url)),
    envDir: repoRoot,
    plugins: [react(), tailwindcss()],
    build: { outDir: 'dist', emptyOutDir: true },
    server: { host: '127.0.0.1', port: 5174, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4174, strictPort: true, proxy },
  };
});
