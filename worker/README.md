# chat-over-github Worker

The app's only backend. It does two jobs:

- **Token exchange.** It adds the GitHub App client secret to OAuth code and refresh-token exchanges. It also proxies device flow, because browsers can't call github.com's login endpoints directly (they send no CORS headers).
- **Invite inbox.** Bob's app registers a GitHub repo invitation here, and Alice's app picks it up and accepts it through the GitHub API. Entries expire after 7 days, the same as GitHub invitations.

## API

All `/invites` calls send the user's GitHub user access token as `Authorization: Bearer <token>`.

| Call | Body / query | Result |
| --- | --- | --- |
| `POST /oauth/token` | `{code, redirect_uri?, code_verifier?}` or `{refresh_token}` | GitHub's token response |
| `POST /oauth/device/code` | none | GitHub's device-code response |
| `POST /oauth/device/token` | `{device_code}` | GitHub's token response |
| `POST /invites` | `{invite_id, repo}` (repo = name of the caller's own repo) | `201 {invitee_id, expires_at}`; `404` if no such invitation on the caller's repo; `410` if expired |
| `GET /invites` | none | `{invites: [{id, from, from_id, created_at, expires_at}]}` for the caller |
| `DELETE /invites/:id` | invitee: none. Inviter withdrawing: `?invitee_id=` | `200` / `404` |
| `POST /closures` | `{to, tag}` (to = GitHub login, tag = 32 hex chars the members' apps derive from the chat) | `201`; `404` if no such user |
| `GET /closures` | none | `{closures: [{id, from, from_id, tag, at}]}` for the caller (kept 7 days) |
| `DELETE /closures/:id` | none | `200` |

### Client flow

1. Bob: `POST /user/repos` (private, `auto_init`), then `PUT /repos/{bob}/{repo}/collaborators/{alice}`, which returns the invitation `id`.
2. Bob: `POST /invites {invite_id, repo}`.
3. Alice polls `GET /invites`. For each entry she calls `PATCH https://api.github.com/user/repository_invitations/{id}` (returns 204), then `DELETE /invites/{id}`. The new repo then appears under Bob's installation in `GET /user/installations/{id}/repositories`.
4. If GitHub says an invitation expired, Bob re-invites and registers it again.

## What the Worker can see

It stores only invitation ID, inviter login and id, and timestamps, under the invitee's GitHub user ID. It stores no repo names, messages or tokens. Each request checks the caller's identity with GitHub (`GET /user`). Before storing an invite, it checks that the invitation really exists on the caller's own repo and records who it's for. Observability (request logs) is disabled in `wrangler.toml`. The operator can still see who invited whom while an invite is pending.

## Web app

The Worker also serves the chat web app from `public/` (Workers static assets). Files there are served first; every other path reaches the Worker code above. Build it with `npm run build` in the repo root, which writes `web/` straight into `public/` (not committed). Because the app and the API share an origin, the browser needs no CORS for the Worker. `public/_headers` sets a strict Content-Security-Policy.

The GitHub App's callback URL must be `https://chat-over-github.akagishigerutokyo.workers.dev/` for the "Sign in with GitHub" button. Device-flow sign-in works without it.

## Deploy

```
npm install
npx wrangler login
npx wrangler kv namespace create INVITES     # paste the id into wrangler.toml
npx wrangler secret put GITHUB_CLIENT_SECRET # from the GitHub App settings page ("Generate a new client secret")
# set ALLOWED_ORIGINS in wrangler.toml to your app's web origin(s)
npx wrangler deploy
```

Tests (mocked GitHub and KV): `npm test`.

## Client notes

- Workers KV lists are eventually consistent. A deleted entry can keep appearing for about 30 seconds (measured live). If accepting an invite fails because it was already accepted or no longer exists, treat that as done and delete the inbox entry.
