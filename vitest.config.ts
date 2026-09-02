import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: that file sets `root: 'dashboard'`
// so the dev server serves the viewer, which would otherwise send vitest
// looking for the engine's tests inside the dashboard folder.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
