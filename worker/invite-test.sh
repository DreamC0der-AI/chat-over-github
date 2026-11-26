#!/usr/bin/env bash
# Live end-to-end test of the invite inbox through the deployed Worker.
# Bob = the account with the app installed (selected repos). Alice = another account.
# Usage: WORKER=https://chat-over-github.sunzy.app ./invite-test.sh
set -uo pipefail
: "${WORKER:?set WORKER to the Worker URL}"
API=https://api.github.com
B=$(mktemp)

login() { # sign in through the Worker's device-flow proxy; echoes token
  local r dc code interval tok
  r=$(curl -sS -X POST "$WORKER/oauth/device/code")
  dc=$(jq -r .device_code <<<"$r"); code=$(jq -r .user_code <<<"$r"); interval=$(jq -r '.interval // 5' <<<"$r")
  [ "$dc" = null ] && { echo "device code failed: $r" >&2; exit 1; }
  echo ">> Sign in as $1 at https://github.com/login/device and enter code: $code" >&2
  while :; do
    sleep "$interval"
    r=$(curl -sS -X POST "$WORKER/oauth/device/token" -H 'Content-Type: application/json' -d "{\"device_code\":\"$dc\"}")
    tok=$(jq -r '.access_token // empty' <<<"$r"); [ -n "$tok" ] && { echo "$tok"; return; }
    case $(jq -r .error <<<"$r") in authorization_pending) ;; slow_down) interval=$((interval+5));; *) echo "token error: $r" >&2; exit 1;; esac
  done
}
gh() { curl -sS -o "$B" -w '%{http_code}' -X "$2" "$API$3" -H "Authorization: Bearer $1" \
  -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' ${4:+-d "$4"}; }
wk() { curl -sS -o "$B" -w '%{http_code}' -X "$2" "$WORKER$3" -H "Authorization: Bearer $1" \
  -H 'Content-Type: application/json' ${4:+-d "$4"}; }
step() { echo; echo "=== $* ==="; }
show() { echo "HTTP $1"; jq -c . "$B" 2>/dev/null || cat "$B"; }

BOB=$(login Bob); ALICE=$(login Alice)
gh "$BOB" GET /user >/dev/null; BOB_LOGIN=$(jq -r .login "$B")
gh "$ALICE" GET /user >/dev/null; ALICE_LOGIN=$(jq -r .login "$B")
echo "Bob=$BOB_LOGIN Alice=$ALICE_LOGIN"
REPO="dm-$(openssl rand -hex 4)"

step "1. Bob creates private repo $REPO";  c=$(gh "$BOB" POST /user/repos "{\"name\":\"$REPO\",\"private\":true,\"auto_init\":true}"); echo "HTTP $c"
step "2. Bob invites $ALICE_LOGIN";        c=$(gh "$BOB" PUT "/repos/$BOB_LOGIN/$REPO/collaborators/$ALICE_LOGIN" '{}'); INV=$(jq -r .id "$B"); echo "HTTP $c invite=$INV"
step "3. Bob registers invite with Worker"; show "$(wk "$BOB" POST /invites "{\"invite_id\":$INV,\"repo\":\"$REPO\"}")"
step "4. Negative: Alice tries to register Bob's invite (expect 404)"; show "$(wk "$ALICE" POST /invites "{\"invite_id\":$INV,\"repo\":\"$REPO\"}")"
step "5. Negative: forged invite id (expect 404)"; show "$(wk "$BOB" POST /invites "{\"invite_id\":1,\"repo\":\"$REPO\"}")"
step "6. Negative: Bob lists his own inbox (expect no entry for $INV)"; show "$(wk "$BOB" GET /invites)"
step "7. Alice lists her inbox (expect invite $INV from $BOB_LOGIN)"; show "$(wk "$ALICE" GET /invites)"
step "8. Alice accepts on GitHub (expect 204)"; echo "HTTP $(gh "$ALICE" PATCH "/user/repository_invitations/$INV")"
step "9. Alice removes inbox entry (expect 200)"; show "$(wk "$ALICE" DELETE "/invites/$INV")"
step "10. Alice inbox now empty"; show "$(wk "$ALICE" GET /invites)"
step "11. Alice finds the repo via installations"
gh "$ALICE" GET /user/installations >/dev/null
for id in $(jq -r '.installations[].id' "$B"); do
  gh "$ALICE" GET "/user/installations/$id/repositories?per_page=100" >/dev/null
  jq -r '.repositories[].full_name' "$B"
done | grep -x "$BOB_LOGIN/$REPO" && echo "FOUND" || echo "NOT FOUND"
step "12. Alice writes a message"; echo "HTTP $(gh "$ALICE" PUT "/repos/$BOB_LOGIN/$REPO/contents/msgs/a1.txt" "{\"message\":\"m\",\"content\":\"$(printf hi | base64)\"}")"
echo; echo "Done. Test repo: https://github.com/$BOB_LOGIN/$REPO (delete by hand)."
rm -f "$B"
