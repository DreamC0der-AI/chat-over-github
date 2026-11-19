import { defineConfig } from 'vitest/config';

// Behavior scenarios: the app's own logic (src/lib/session.ts) for several people and browsers,
// against the in-memory GitHub + Worker, with no browser. See tests/harness.ts.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    env: { VITE_MOCK: '1', VITE_API: 'http://mock.test/gh', VITE_WORKER: 'http://mock.test/worker' },
  },
});
