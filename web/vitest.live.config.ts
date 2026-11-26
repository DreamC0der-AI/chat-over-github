import { defineConfig } from 'vitest/config';

// The membership walkthrough against real GitHub and the real Worker (live/walk.live.ts). Run on a
// computer that has the test accounts' sign-ins: npm run live:walk -w web -- see live/walk.live.ts.
// Repo names are the walkthrough's own, so real chats of those accounts are never touched.
export default defineConfig({
  test: {
    include: ['live/**/*.live.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30 * 60_000,
    hookTimeout: 5 * 60_000,
    fileParallelism: false,
    env: {
      VITE_API: 'https://api.github.com',
      VITE_WORKER: process.env.KEYHOLD_WORKER ?? 'https://chat-over-github.akagishigerutokyo.workers.dev',
      VITE_DIRECTORY_REPO: 'keyhold-walk-id',
      VITE_HOME_REPO: 'chat-walk-home',
      VITE_CHAT_PREFIX: 'ghchat-walk-',
    },
  },
});
