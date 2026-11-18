# Chat over GitHub: web app

End-to-end encrypted 1:1 and group chat in the browser, with GitHub as the only backend. Built on `keyhold/chat` (MLS) and the GitHub provider in `../provider`. Live at https://chat-over-github.akagishigerutokyo.workers.dev, served by the chat-over-github Worker (static assets), which also does the OAuth exchange and the invite inbox.

## What it does

- Sign in with the GitHub App (web flow with PKCE, or device flow with a one-time code). Tokens refresh through the Worker.
- Checks the app is installed on the account ("Only select repositories").
- Identity setup: a root key made in the browser, a device key certified by it, public keys in `<login>/keyhold-id`, the root key backed up to `<login>/keyhold-home` sealed with a recovery code. Another browser joins with the recovery code.
- Chats list, DMs and groups (`ghchat-<random>` private repos), invites through the Worker inbox, accept and join automatically.
- Text, files up to 10 MB (sealed per file), reactions, delete, group rename, members panel, invite and remove (admins), leave.
- Safety numbers and verification, key-change warning.
- Devices list and revoke (needs the recovery code), sign out, forget this browser, reset identity.

Decrypted messages are kept only in this browser (IndexedDB). Keys live in IndexedDB too (box 1 and box 2).

## Polling and rate limit

Each chat's repo is checked with a conditional `GET /repos/{space}/commits?per_page=1` (`If-None-Match`). A 304 doesn't count against GitHub's rate limit, so the full `sync()` only runs when something was written. The open chat is checked every 4 s, recently active ones every 6 s, others every 20 s, everything every 90 s while the tab is hidden. The invite inbox is checked every 15 s and the list of repos once a minute.

## Develop

Run these from the repo root:

```
npm install            # also builds keyhold from GitHub (pinned commit in package.json)
npm run dev -w web     # against real GitHub; sign-in needs the Worker origin, so use the mock for local work
npm run build          # writes the app into worker/public, ready for wrangler deploy
npm run e2e            # mock build + in-memory GitHub and Worker + Playwright, three people
```

`npm run e2e` needs Playwright. It covers a DM, a group, removal, a second device, invitations, Delete/Close/Quit/Block and first-run install, then (`tools/e2e-pending.mjs`, with GitHub writes slowed down or failing) the pending states and the one-tab-per-account rule.
