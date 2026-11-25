import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by Express under /admin (see src/admin.js). In dev, Vite serves the page and proxies the API, so the
// browser's Basic-auth prompt and EventSource credentials work against the real server.
const API_TARGET = process.env.ADMIN_API_TARGET ?? 'http://localhost:8080';

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/admin/api': { target: API_TARGET, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0, // keep everything as 'self' files (CSP has no data: for fonts/scripts)
    chunkSizeWarningLimit: 1500, // antd + React is ~900 kB min / ~280 kB gzip; expected for this app
  },
});
