# Chat over GitHub

End-to-end encrypted DMs and group chats that use GitHub as the only backend. Each chat is a private repo, GitHub decides who may write, and the app keeps everything encrypted.

Live at https://chat-over-github.sunzy.app (old address https://chat-over-github.akagishigerutokyo.workers.dev still works)

This is an app built on [keyhold](https://github.com/DreamC0der-AI/keyhold), the encryption framework. Keyhold has the protocol: storage kinds, MLS groups, group policy, identity and keys. It knows nothing about GitHub. Everything GitHub-specific is here.

| Folder | What |
| --- | --- |
| `web/` | The web app (React + Vite). |
| `provider/` | The GitHub storage provider: keyhold's storage kinds as GitHub repos, collaborator access as the channel fence. Includes the GitHub mock, the tests and the live GitHub check. See [docs/github-provider.md](docs/github-provider.md). |
| `worker/` | The Cloudflare Worker: OAuth token exchange, invite inbox, closure notices, and it serves the built web app. |
| `docs/` | App design: the GitHub provider and the chat deletion design. Protocol design lives in keyhold's `docs/`. |

## Keyhold version

`provider/package.json` and `web/package.json` pin keyhold to one commit (`github:DreamC0der-AI/keyhold#<sha>`). To move to a newer keyhold, change both to the new commit and run `npm install`.

## Commands

```
npm install        # builds keyhold from GitHub on install
npm run typecheck
npm test           # provider tests, app scenarios (vitest) and Worker tests (node --test)
npm run build      # web app -> worker/public
npm run e2e        # browser checks against an in-memory GitHub and Worker (needs Playwright)
npm run test:changed   # only the tests your changes need (see below)
npm run test:all       # everything
cd worker && npx wrangler deploy
```

## Testing

`npm run test:changed` looks at the files changed since `origin/main` and runs what they need. The rules are at the top of `scripts/test.mjs`: a screen-only change (`web/src/screens/`, `ui.tsx`, `styles.css`, `web/public/`, `index.html`) runs the type check, the build and the three screen checks (menu, layout, pending), not the multi-person flow; a Worker change runs the Worker tests; docs run nothing; app logic, the provider, packages and anything unrecognised run everything. Pull requests on GitHub run the same selection; pushes to `main` run everything.

There are three kinds of tests:

- **Provider tests** (`provider/tests`): the GitHub storage provider and keyhold against a fake GitHub.
- **App scenarios** (`web/tests`, a few seconds): the chat rules, such as invitations, joining, sending, reactions, Delete/Close/Quit/Block, groups, and a second browser catching up. They run the app's own logic (`web/src/lib/session.ts`) for several people and browsers in one process, against the in-memory GitHub and Worker (`web/tools/mock-backend.ts`), with no browser. No timer runs: each browser's sync step runs only when the scenario says (`w.until(...)`, `w.rounds()`), so a scenario gives the same result on any machine. New chat behaviour gets a scenario here first.
- **Browser checks** (`web/tools/e2e*.mjs`, about 25 s): that the screens are wired to that logic, such as buttons, dialogs, menus and what shows where.

The browser checks run at the same time, each on its own port with its own mock backend; `npm run e2e -- flow menu` runs a subset. They never wait on the app's real timers: the mock build runs the same sync schedule ten times faster, and `window.__chat.syncNow()` runs a full sync step at once. A check that something does *not* happen runs a few sync rounds, then looks. Wait for results (`waitFor`), not for time.

On the Mac, use node@24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`).

## Things that must not change

Existing accounts depend on these, so renaming any of them breaks people's chats or keys:

- the Worker name `chat-over-github` and its URL (the app's origin, where IndexedDB data lives);
- repo names `keyhold-id`, `chat-home` (and legacy `keyhold-home`), and the `ghchat-` prefix;
- HKDF labels such as `keyhold-chat-web/v1/root-backup`.
