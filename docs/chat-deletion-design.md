# Chat deletion and re-creation: design

Status: proposal, 2026-11-13, revised the same day for the three actions (Delete, Close, Quit). Nothing is built. Implementation waits for the user's "build it".
Related: group-encryption-design.md, chat-storage.md.

## 1. What the code does today

Checked on branch `claude/chat-web-app` (commit c94d719).

- **A chat has no identity beyond its repo.** Each chat is a fresh repo `ghchat-<random>` with a random MLS group id. Nothing says "this is the DM between A and B". The web app only infers the peer from the members.
- **Duplicate DMs are possible.** `startDm` reuses a DM only if *this device* already has one with that person. If B starts a DM while A's invite to B is still pending, or A's second device hasn't joined yet, a second DM repo is created.
- **History lives only on each device.** The web app runs with `historyBackup: false`, and the chat list and decrypted messages are in IndexedDB per browser. Nothing is in the home repo yet. (The repo holds only ciphertext, and a new device can't read messages from before it joined.) So deleting the repo leaves exactly one copy of the history: whatever each device has cached.
- **Detection on refresh works, on send it doesn't.** Sync turns a 404 into an `access-lost` event ("GitHub no longer gives you access to this chat"). Sending to a deleted repo is different: the provider reads a 404 on file create as a "conflict", retries 5 times, then fails with a generic "could not post".
- **Stale invites fail silently.** If the repo is deleted before B accepts, the GitHub invitation is gone, but B's inbox notice stays for up to 7 days. Accept treats the 404 as "already accepted", then the notice disappears after 5 minutes without explanation.
- **Notices are matched to repos by inviter.** An accepted notice from A is matched to the next repo from A that shows up. If A deletes and invites again, the old and new notices can be mixed up.
- **Leave doesn't leave GitHub.** `leave()` proposes the MLS self-remove and hides the chat. The repo access is removed later by the owner's app (`reconcileChannel`).
- **A 404 can mean several things.** The repo was deleted, you were removed, the owner took this repo out of their app installation or uninstalled the app, or the owner's account is gone. GitHub gives the same answer for all of them.

## 2. Core idea: a conversation outlives its repos

- A **conversation** is what the user sees in the chat list. For a DM it is simply *the pair of people*, identified by their two GitHub user ids (ids survive login renames). No new id is needed: it follows from the members.
- A **room** is one repo plus its MLS group. A conversation has a sequence of rooms over time. **At most one room is live at a time.**
- Each room is **live**, **unavailable** (soft: a 404 with no explanation, can come back), or **closed** (hard: someone ended it on purpose, never reopens).
- Groups get an explicit random **conversation id** in the encrypted group policy at creation. A successor room copies it, so a group can move to a new repo later (section 7).

Everything below follows from four rules.

**Rule 1: one live room per conversation.** Before creating a room, the app looks for a live one: its own chats, pending invites from that person, and repos it can see. If one exists, it opens or accepts that instead of creating another.

**Rule 2: deterministic tie-break.** If two live rooms exist anyway (two people pressed "new chat" at the same moment), both apps keep **the room owned by the person with the lower GitHub user id**. Both sides know both ids before opening anything (the inbox notice carries the inviter's id), so they agree without talking. The other room is retired: its owner's app re-sends any messages still waiting in its outbox to the winning room, then deletes the losing repo.

**Rule 3: rooms never copy history.** A new room starts empty on GitHub. Old messages are never re-uploaded: that would undo the deletion, and only someone who kept a copy could do it. Each device shows, in one timeline, whatever it still has from earlier rooms, above a divider such as "A closed this chat on 13 Nov · new chat started". Anything the person removed with Delete chat stays gone.

**Rule 4: ending is explicit and announced; a 404 alone is only "unavailable".** An app that ends a room (Close or Quit) says so with a signed notice. A 404 without a notice shows "This chat is no longer available" and keeps everything, in case access comes back (for example the owner re-adds the repo to their installation).

## 3. The three actions

Decided by the user on 2026-11-13: history and the room are handled separately.

| Action | Who | What it does | What it doesn't do |
| --- | --- | --- | --- |
| **Delete chat** | Everyone | Deletes *my* copy of the history (decrypted messages and attachments on my devices) | Doesn't touch the repo, the other person's copy, or whether the chat is live |
| **Close chat** | Repo owner only | Ends the room for everyone and deletes the repo | Doesn't delete anyone's local history |
| **Quit chat** | Non-owners only | Removes me from the room (MLS self-remove, then off the repo) | Doesn't delete the repo or anyone's history, including mine |

Because the actions are separate, they combine freely. "Close and delete my history" is Close then Delete, and the same goes for Quit. The menu can offer the combined button as a shortcut.

**Assumption, to confirm:** after Delete chat, the chat stays live and in the chat list, empty, and new messages keep arriving. (The alternative is that it also drops out of the list until the next message.)

**Delete chat** (A or B):

1. Confirm: "This deletes the messages on your devices. [Peer] keeps their copy."
2. Delete the cached messages and attachments for this conversation, from every earlier room too. Record a "cleared up to here" mark, so a later sync never decrypts and shows the old ciphertext again. This matters because the device still holds keys for the last 4 epochs.
3. Sync the mark to my other devices through the home repo, once the chat list lives there (6.4). Until then, Delete applies to this browser only.
4. If the room is already closed or quit, also delete its leftover MLS state, so nothing of the room is left on this device.

**Close chat** (owner A):

1. Confirm: "This ends the chat for everyone and deletes it from GitHub. Everyone keeps the history their app has, unless they delete it."
2. Post a signed `close` message in the room (helps peers who are online right now).
3. Leave a **closure notice** in each member's invite inbox (decision 3), and withdraw any invite notices still pending (the Worker already supports that).
4. Delete the repo (`DELETE /repos/...`, covered by the existing Administration permission). If that fails, the chat stays open and the error is shown.
5. Locally: delete the room's MLS secrets right away and mark the room closed. The history stays, read-only, with "You closed this chat" and a Delete button. Tell A's other devices through the home repo.

**Quit chat** (non-owner B):

1. MLS self-remove proposal plus a `left` message (what `leave()` already does), then try to leave the repo on GitHub. The owner's app removes the access anyway when it sees the self-remove.
2. Locally: delete the MLS secrets and mark the room quit. The history stays, read-only, with "You left this chat" and a Delete button.
3. In a group, the group carries on. In a DM, the owner is left alone in the room: A sees "B left", sending is turned off, and a banner offers **Close chat** (decision 2).

Closing directly on github.com (deleting the repo there) skips steps 2 and 3 of Close. Peers then see "no longer available" instead of "A closed this chat". A's own devices treat a 404 on *their own* repo as closed.

The owner of a DM can't quit, only close. In a group the owner can't quit either, until groups can move to a new repo (section 7).

## 4. Every case, and how the rules resolve it

### Ending the room

| # | Case | Resolution |
| --- | --- | --- |
| 1 | B is online when A closes | The `close` message or closure notice arrives within a poll. B sees "A closed this chat". The room becomes read-only and B's history stays until B deletes it. |
| 2 | B is offline when A closes | On next sign-in or refresh, the inbox has the closure notice. If more than 7 days passed (notice expired), the 404 shows "no longer available". Same outcome, less detail. |
| 3 | B sends after the close | The send must catch the 404 and mark the room ended, not retry as a "conflict" (today's bug). The message stays as an unsent draft. The banner offers **Start a new chat with A**. |
| 4 | B's send is in flight while A closes | Same as 3: that message shows "not delivered". |
| 5 | Messages A never read before closing | A never gets them. B still has them locally. |
| 6 | A deleted the repo on github.com | Peers get "no longer available". A's other devices get a 404 on their own repo and mark it closed. |
| 7 | A took the repo out of the app installation, or uninstalled the app | Looks like 6 to everyone. The room is only *unavailable*, so if access returns it simply resumes. |
| 8 | A removed B without closing (groups) | B sees "You were removed" if B was online for the MLS remove, otherwise "no longer available". A's app may also leave a closure notice with reason "removed". |
| 9 | A closes while B quits | Each step is idempotent. Both end up with the room ended. |
| 10 | B quits a DM while A is offline | B's self-remove waits in the log. When A's app next syncs, it commits it, removes B's repo access and shows "B left". |
| 11 | B quits on GitHub only (leaves the repo there) | B's app sees a 404 on someone else's repo and shows "no longer available". A's app notices B is no longer a collaborator, removes B from the MLS group and shows "B left". |

### Deleting history

| # | Case | Resolution |
| --- | --- | --- |
| 12 | A deletes history while the chat is live | A's devices clear it and keep receiving new messages. B notices nothing. |
| 13 | A deletes on one device | Today it applies to that browser only. With the chat list in the home repo, all A's devices apply the same mark. |
| 14 | A deletes, then a sync brings old ciphertext again | The "cleared up to here" mark makes the app skip it, even though its keys may still be there. |
| 15 | A adds a new device later | A new device can never read older messages anyway, so there is nothing to clear on it. |
| 16 | A deletes history in a closed or quit room | The room is removed from A's list completely, including its leftover MLS state. |

### Invites around an ending

| # | Case | Resolution |
| --- | --- | --- |
| 17 | A closes while B hasn't accepted yet | A's app withdraws the inbox notice. If B saw it anyway, Accept gets a 404 and shows "A withdrew this invitation" (today it vanishes silently). |
| 18 | B accepts at the moment A closes | The join fails with 404 and shows the same "withdrawn" message. |
| 19 | Old and new invites from A both in B's inbox | Match each notice to its repo by the GitHub invitation id, not by inviter. The old one resolves as withdrawn, the new one as a normal invite. |
| 20 | B had declined an earlier room | Declines are per room, so they don't block a new invite. To stop someone completely, B uses Block (decision 5). |

### Re-creation

| # | Case | Resolution |
| --- | --- | --- |
| 21 | A closes, later A starts a chat with B again | Rule 1 finds no live room, so A creates a new one. Same conversation in the list. Each side sees whatever it kept from the old room (nothing, if they used Delete), a divider, then the new room. Nothing merges on GitHub (rule 3). |
| 22 | A closes, then B starts a chat with A | Same, with B as owner of the new room. Ownership isn't tied to who started the conversation first. A gets a normal invite and can decline or block. |
| 23 | B quit a DM, later A or B starts a chat again | The old room has one person left, so it doesn't count as live. A new room is created as in 21 and 22. If A hadn't closed the old room, A's app closes it now, because a new room has taken its place. |
| 24 | B's app hasn't noticed the close yet, and B taps Send | Case 3: B is told the chat ended and chooses to start a new one. It is never re-created automatically, because silently re-inviting someone who just closed the chat would feel like harassment. |
| 25 | After an ending, A and B both start a new chat before seeing the other's invite | Each app sees an incoming invite from the person it is inviting. Rule 2 picks the lower user id's room. The loser's app withdraws its invite, **accepts the winner's invite without asking** (the user just asked to chat with this person), moves its queued messages there, and deletes its empty repo. Both see one chat. |
| 26 | Same, but both already accepted each other's rooms | Two live rooms. Rule 2 still picks one. The loser posts a signed "moved" message and its owner deletes the repo after moving queued messages. Messages already exchanged in the losing room stay in both local timelines, merged by time. |
| 27 | B starts a DM while A's invite to B is still pending (no ending at all) | Rule 1: B's app sees the pending invite from A and offers to accept it instead of creating a second chat. |
| 28 | A's second device hasn't joined a DM yet, and A starts a DM with B there | Rule 1 also scans A's own repos, so device 2 self-joins the existing room. |
| 29 | Duplicate DMs that already exist today | Rule 2 applies to them too: the newest app version retires the extra room. |
| 30 | B's root key changed between rooms (lost key, new identity) | Same conversation, since it is keyed by people, not keys. The new room shows "B's security key changed" and verification starts over. If the key is the same, the earlier verification carries over. |

### Devices and stored data

| # | Case | Resolution |
| --- | --- | --- |
| 31 | A has several devices and closes or quits on one | The device writes a tombstone for the room in the home repo, and the other devices end the room too. Until the chat list is in the home repo, each device learns from the 404 or the MLS remove. |
| 32 | MLS state of an ended room | Epoch and ratchet secrets are deleted as soon as the room is closed or quit (they must never outlive their use). For an *unavailable* room they are kept until it ends or a new room replaces it. |
| 33 | History backup turned on later | Delete chat also clears the backup copy. GitHub keeps deleted files in git history, so there it means the encrypted file is unreachable, not physically gone. |
| 34 | GitHub restores a deleted repo (allowed within 90 days) | A closed room never reopens, and its keys are gone anyway. Only an *unavailable* room can come back. |

## 5. Decisions for you

Settled on 2026-11-13: the three actions in section 3 (Delete chat for everyone, Close chat for the owner, Quit chat for the non-owner).

1. **Delete chat keeps the chat live.** Assumed yes: the history is cleared, the chat stays in the list and new messages arrive. The alternative also drops it from the list until the next message.
2. **A DM after the non-owner quits.** Recommended: the owner's app shows "B left", turns off sending and offers Close chat, without deleting automatically. It closes the room by itself only when a new room with B replaces it (case 23).
3. **Closure notice through the Worker.** Recommended: add it. It is the only reliable way for an offline peer to learn "A closed this chat" instead of the vague "no longer available". The Worker would learn that A ended a chat with B at a given time, which it largely knows already from the invite. The notice carries only an opaque tag that the Worker can't link to a repo. Without it, everything still works, only the wording is vaguer.
4. **Old and new rooms in one entry.** Recommended: one chat-list entry per person, with dividers between rooms. The alternative is listing ended rooms as separate archived chats.
5. **Block.** Recommended: a Block action next to Close and Quit. A block (already a data type in the personal store) makes the app decline that person's invites automatically.

## 6. Notes for implementation (later)

1. Send: map a 404 on create to "access lost" when the repo itself is gone, instead of retrying as a conflict.
2. Accept: report 404/410 as "withdrawn" unless the repo shows up in the next repo scan (the inbox lags, so a repeat accept is still harmless).
3. Match notices by GitHub invitation id.
4. Move the chat list (rooms per conversation, tombstones, blocks) into the home repo, so all devices agree on what ended.
5. Rule 1 and rule 2 belong in Keyhold's chat layer, so every app gets them. The GitHub specifics (user id order, repo delete) stay in the provider.

## 7. Groups

- **Closing**: only the repo owner can close. It ends the room for everyone, with the same steps as section 3. Delete chat works the same as in a DM.
- **Members quitting** never ends a group, unlike a DM.
- **Owner wants to leave but keep the group**: the repo belongs to them, so the group has to **move**. Another admin's app creates a new room with the same conversation id, issues tickets to the members, and posts an admin-signed "moved to" message in the old room. Members' apps follow automatically, because they already belong to the conversation. Then the old owner deletes the old repo. This uses the same "moved" step as rule 2, so it can be built later on top of this design. Until then, the owner leaving a group means closing it or staying on as host.
- **Duplicates** aren't a problem for groups: two groups with the same people are allowed, so rule 2 applies only to DMs. Rule 3 (no history copying) and rule 4 (announced end, 404 only "unavailable") apply to groups unchanged.

## 8. Where MLS data lives today (from the code, 2026-11-13)

Web app on `claude/chat-web-app` (c94d719). "Browser" means IndexedDB, one database per GitHub account. Nothing in it is encrypted at rest: it relies on the browser profile and the OS.

| Data | Where | Protected by | After refresh | On a new device | When the chat repo is deleted |
| --- | --- | --- | --- | --- | --- |
| Root identity key | Not kept on any device. Only in the home repo vault | Sealed with a key from the recovery code (no passkey yet) | n/a | Unlocked with the recovery code just long enough to certify the new device, then wiped from memory | Unaffected |
| Device signing key (MLS credential key) | Browser, `keystore` | Nothing extra (plaintext in IndexedDB) | Kept | A new one is made. The old device's key never leaves it | Unaffected (used by all chats) |
| Public identity, device certificates, revocations | Public `keyhold-id` repo | Root-signed, hash-chained (public by design) | n/a | Read from there | Unaffected |
| Trust pins (who has which key) | Browser, `kv` | Nothing extra | Kept | Start empty (design puts them in the home repo, not done yet) | Unaffected |
| KeyPackages | Made fresh on this device for each join and used at once. Last-resort and one-time KeyPackages are off in the web app | n/a | n/a | n/a | Nothing left to delete |
| Group state: epoch secrets, ratchet tree, own leaf key, keys of the last 4 epochs for late messages | Browser, `ephemeral`, one entry per chat | Nothing extra | Kept | Not copied. The device joins each chat by itself and starts at the current epoch | **Stays in the browser today.** Only Leave deletes it. The design says delete it when the room closes |
| Chat bookkeeping (repo name, log position, hashes, used ticket nonces) | Browser, `keystore` | Nothing extra | Kept | Rebuilt on join | Stays, marked "access lost" |
| Commits (adds, removes, key updates) | Chat repo `log/` | Encrypted MLS messages, except external joins, which are signed but public to repo readers | n/a | Read from the current position only | Gone from GitHub |
| GroupInfo (one copy per log entry, for external joins) | Chat repo `log/` | Signed, **not encrypted**: anyone who can read the repo sees the member devices, their addresses and root fingerprints, and the policy (admins, bans) | n/a | Used to join | Gone from GitHub |
| Invite tickets, join requests (Welcome only with offline add, which is off) | Chat repo `drop/` | Signed by the inviter. Deleted after use | n/a | n/a | Gone from GitHub |
| Message and attachment ciphertexts | Chat repo `mail/` and `blob/` | MLS encryption (attachments: own key sent inside a message) | n/a | Old ones can't be read: the device only has keys from its join onward | Gone from GitHub (GitHub's own backups aside) |
| Decrypted messages, chat list, read marks | Browser, `messages` and `kv` | Nothing extra | Kept | Start empty (history backup is off) | **Stay in the browser**, the chat shows "no longer available" |
| Invite notices | Worker KV | Invitation id and inviter only, no keys or repo names | n/a | n/a | Stay until accepted or 7 days |

Differences from the design:
- Group secrets of a dead chat aren't deleted (should be on close).
- Pins, chat list and history are per browser. The design has them in the home repo (box 12), so a new device starts with no contacts' pins, no chat list and no history.
- Browser data isn't encrypted at rest. Clearing site data equals losing the device: the device key, all group secrets and all decrypted history are gone, and the recovery code is needed to come back as a new device.
- GroupInfo in plaintext exposes the member list and policy to anyone with repo read access, including a pending invitee and GitHub. The design said group info lives in the encrypted state. Message content and the group name (sent as an encrypted message) are not exposed.
