# Chat over GitHub

End-to-end encrypted DMs and group chats that use GitHub as the only backend. Each chat is a private repo, GitHub decides who may write, and the app keeps everything encrypted.

Live at https://chat-over-github.akagishigerutokyo.workers.dev

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
npm test           # provider tests (vitest) and Worker tests (node --test)
npm run build      # web app -> worker/public
npm run e2e        # browser check against an in-memory GitHub and Worker (needs Playwright)
cd worker && npx wrangler deploy
```

On the Mac, use node@24 (`PATH=/opt/homebrew/opt/node@24/bin:$PATH`).

## Things that must not change

Existing accounts depend on these, so renaming any of them breaks people's chats or keys:

- the Worker name `chat-over-github` and its URL (the app's origin, where IndexedDB data lives);
- repo names `keyhold-id`, `chat-home` (and legacy `keyhold-home`), and the `ghchat-` prefix;
- HKDF labels such as `keyhold-chat-web/v1/root-backup`.
