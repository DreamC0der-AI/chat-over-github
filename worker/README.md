# chat-over-github Worker

The app's only backend. It does two jobs:

- **Token exchange.** It adds the GitHub App client secret to OAuth code and refresh-token exchanges.
- **Invite inbox.** Bob's app registers a GitHub repo invitation here, and Alice's app picks it up and accepts it through the GitHub API. Entries expire after 7 days, the same as GitHub invitations. Each user's inbox is one SQLite-backed Durable Object (class `Inbox`, named by GitHub user id). Open app tabs keep a hibernating WebSocket to it and get new entries pushed, so an idle tab costs nothing and nobody polls.

## API

All inbox calls send the user's GitHub user access token as `Authorization: Bearer <token>`. The WebSocket, which browsers can't give headers, offers the subprotocols `inbox.v1` and `bearer.<token>`; the Worker answers with `inbox.v1`.

| Call | Body / query | Result |
| --- | --- | --- |
| `POST /oauth/token` | `{code, redirect_uri?, code_verifier?}` or `{refresh_token, retry_key?}` | GitHub's token response. A refresh asked again with the same `refresh_token` and `retry_key` (16-128 base64url chars the app keeps until it has saved the new tokens) within 10 minutes gets the same answer; without `retry_key` (old apps) only within 60 seconds. |
| `GET /inbox` (WebSocket) | subprotocols above; Origin must be in `ALLOWED_ORIGINS` | first `{type:"snapshot", invites, closures}`, then `{type:"invite", invite}`, `{type:"invite-removed", id}`, `{type:"closure", closure}`, `{type:"closure-removed", id}`. Send `ping` to get `pong` (answered without waking the object). |
| `POST /invites` | `{invite_id, repo}` (repo = name of the caller's own repo) | `201 {invitee_id, expires_at}`; `404` if no such invitation on the caller's repo; `410` if expired |
| `GET /invites` | none | `{invites: [{id, from, from_id, created_at, expires_at}]}` for the caller |
| `DELETE /invites/:id` | invitee: none. Inviter withdrawing: `?invitee_id=` | `200` / `404` |
| `POST /closures` | `{to, tag}` (to = GitHub login, tag = 32 hex chars the members' apps derive from the chat) | `201`; `404` if no such user |
| `GET /closures` | none | `{closures: [{id, from, from_id, tag, at}]}` for the caller (kept 7 days) |
| `DELETE /closures/:id` | none | `200` |

### Client flow

1. Bob: `POST /user/repos` (private, `auto_init`), then `PUT /repos/{bob}/{repo}/collaborators/{alice}`, which returns the invitation `id`.
2. Bob: `POST /invites {invite_id, repo}`.
3. Alice's app gets the entry pushed on its inbox socket (or, if the socket is down, from `GET /invites`). For each entry she calls `PATCH https://api.github.com/user/repository_invitations/{id}` (returns 204), then `DELETE /invites/{id}`. The new repo then appears under Bob's installation in `GET /user/installations/{id}/repositories`.
4. If GitHub says an invitation expired, Bob re-invites and registers it again.

## What the Worker can see

It stores only invitation ID, inviter login and id, and timestamps, under the invitee's GitHub user ID. It stores no repo names, messages or tokens. Each request checks the caller's identity with GitHub (`GET /user`). Before storing an invite, it checks that the invitation really exists on the caller's own repo and records who it's for. Observability (request logs) is disabled in `wrangler.toml`. The operator can still see who invited whom while an invite is pending.

## Web app

The Worker also serves the chat web app from `public/` (Workers static assets). Files there are served first; every other path reaches the Worker code above. Build it with `npm run build` in the repo root, which writes `web/` straight into `public/` (not committed). Because the app and the API share an origin, the browser needs no CORS for the Worker. `public/_headers` sets a strict Content-Security-Policy.

The GitHub App's callback URL must be `https://chat-over-github.akagishigerutokyo.workers.dev/` for the "Sign in with GitHub" button.

## Deploy

```
npm install
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_SECRET # from the GitHub App settings page ("Generate a new client secret")
# set ALLOWED_ORIGINS in wrangler.toml (and in the dev script in package.json) to your app's web origin(s)
npx wrangler deploy
```

Limits: bodies over 16 KB get `413`. An inbox takes at most 50 invites and 50 closure notices from one sender and 500 of each in all (`429` beyond; replacing an entry that is there is always fine). The `[[ratelimits]]` bindings in `wrangler.toml` allow 60 OAuth calls a minute per IP and 100 invite/closure posts a minute per user (`429`); without them the code applies no rate limit. `npm run dev` adds `http://localhost:5173` to `ALLOWED_ORIGINS`; the deployed Worker trusts only its own origin.

Tests: `npm test` runs the Worker and its Durable Objects in wrangler's local runtime against a fake GitHub.

## Client notes

- If accepting an invite fails because it was already accepted or no longer exists (another tab got there first), treat that as done and delete the inbox entry.

## Moving off Workers KV (2026-11-17)

The inbox used to be Workers KV keys (`inv:<user>:<id>`, `cls:<user>:...`). Polling tabs used up KV's free 1,000 lists a day. Each inbox object now copies its owner's old KV entries the first time it is used, and never again. Everything in KV expires by 2026-11-24; after that the `INVITES` binding in `wrangler.toml` and the copy code (`importKv`) can be removed.

Free-plan limits that matter now (Durable Objects, SQLite backend, reset 00:00 UTC): 100,000 requests a day (a socket open, an RPC from the Worker, or incoming socket messages at 20 per request; auto-answered pings cost nothing), 13,000 GB-s of duration a day (hibernated sockets don't count), 5 million rows read and 100,000 rows written a day, 5 GB stored. Workers requests are 100,000 a day too.
