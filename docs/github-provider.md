# GitHub provider

`provider/` implements keyhold's storage kinds with GitHub repos. Keyhold defines the kinds and the provider interface (`keyhold/storage`); this package only stores bytes and carries out channel side effects. It never sees plaintext and makes no security decision.

## Where each kind lives

| Kind | Where |
| --- | --- |
| 3 | public repo `{login}/keyhold-id`, `dir/{index}` (create-only files) |
| 9, 12 | private repo `{login}/keyhold-home`, `vault/{name}` and `items/{opaque id}` |
| 5 | chat repo `log/{shard}/{index}`, create-only, 1,000 per shard |
| 6 | chat repo `mail/{day}/{id}`; a burst of sends (`postMany`) is one commit via the Git Data API, one file per message |
| 7 | chat repo `blob/{id}` (over 1 MB read through the git blob API) |
| 8 | chat repo `drop/{recipient tag}/{id}` |
| 11 | the Worker in `worker/` (`POST/GET/DELETE /invites`) |
| 4 | not provided |

Compare-and-swap comes from the Contents API: creating a path that exists fails, and an update needs the current blob sha. Channel side effects use the collaborator API. Chat repos are named `ghchat-<random>` with one neutral description and the topic `keyhold-chat`.

The web app sets the home repo to `chat-home` (accounts made before 2026-11-13 keep `keyhold-home`).

## Tests

`provider/tests` runs keyhold's chat, storage, attack and robustness suites against the in-memory GitHub mock (`tests/github-mock.ts`), next to keyhold's memory provider for comparison. It also has the GitHub-only checks: force-pushed logs, ciphertext-only repo files, log sharding past 1,000 entries, and the claim-once store being unavailable.

## Live run against real GitHub

On 2026-11-05, `provider/scripts/live-github.ts` passed all 16 steps with two real accounts. Each account had the GitHub App installed with "Only select repositories". The run checked:

- publishing directories and looking them up across accounts;
- a DM (repo, ticket, collaborator invite, Worker inbox, accept, external join, messages both ways);
- a 1.5 MB attachment through the git blob API;
- compare-and-swap with two writers racing on the same log index five times (exactly one won each time);
- a group invite, join and talk;
- a member leaving, which removed them as a collaborator;
- a removal, after which the removed member sees `access-lost` and can't read the log.

An idle sync costs 5 requests for both owner and member, the same as against the mock.

Still not covered live:

- 409s caused by unrelated commits racing on the branch under heavy load;
- files near the size limit;
- the request budget over hours of polling (at 5,000 requests an hour, polling every minute covers about 16 chats, so a real app should poll quiet chats less often);
- the offline add path (box 4), which the GitHub provider doesn't offer.

Run it again from `provider/` with `npm run build:live && node scripts/live-github.mjs <loginA> <loginB>`. The script uses its own repo names (`keyhold-live-*`, `ghchat-live-*`), deletes them at the end, and never writes tokens or keys to its report.
