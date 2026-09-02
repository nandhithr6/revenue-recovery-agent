import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard is a viewer, not a second source of truth: it reads the JSON
// bundle `npm run eval:all` produces and does no simulation of its own.
export default defineConfig({
  root: 'dashboard',
  publicDir: '../out',
  plugins: [react()],
  server: { port: 5180, open: false },
  build: { outDir: '../dist-dashboard', emptyOutDir: true },
});
