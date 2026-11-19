# Notes for Claude

- Before pushing, run `npm run test:changed` (picks tests from the changed files; rules in `scripts/test.mjs`). Don't also run the full suite: the PR check runs the same selection, and `main` runs everything after merge.
- Browser checks must not sleep for fixed times. Wait for the result, or call `window.__chat.syncNow()` (mock build) to run the app's sync step now. See "Testing" in README.md.
- A browser check that fails once: re-run only that check (`npm run e2e -- <name>`), and if it passes on rerun, treat it as a flaky test to fix, not as noise.
