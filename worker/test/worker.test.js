// Runs the real Worker and its inbox Durable Objects in workerd (wrangler's local runtime),
// against a fake GitHub on localhost.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstable_dev, getPlatformProxy } from "wrangler";

const users = {
  "tok-bob": { id: 1, login: "bob" },
  "tok-alice": { id: 2, login: "alice" },
  "tok-eve": { id: 3, login: "eve" },
  "tok-carol": { id: 4, login: "carol" },
};
const invitations = {
  "bob/dm-1": [{ id: 100, invitee: { id: 2, login: "alice" }, expired: false, created_at: new Date().toISOString() }],
  "bob/dm-2": [{ id: 102, invitee: { id: 2, login: "alice" }, expired: false, created_at: new Date().toISOString() }],
  "bob/dm-old": [{ id: 101, invitee: { id: 2, login: "alice" }, expired: false, created_at: new Date(Date.now() - 8 * 864e5).toISOString() }],
};
let lastLogin;
const spent = new Set();
let refreshes = 0;

// ---- fake GitHub (API and login endpoints on one server) ----
const gh = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname.startsWith("/login/")) {
      lastLogin = { path: u.pathname, body: JSON.parse(body) };
      const b = lastLogin.body;
      if (b.grant_type === "refresh_token") {
        // GitHub spends a refresh token on first use.
        if (spent.has(b.refresh_token)) return send(200, { error: "bad_refresh_token" });
        spent.add(b.refresh_token);
        refreshes++;
        return send(200, { access_token: `at-${refreshes}`, refresh_token: `rt-${refreshes}`, expires_in: 28800 });
      }
      return send(200, { access_token: "x" });
    }
    const me = users[(req.headers.authorization || "").replace("Bearer ", "")];
    if (!me) return send(401, {});
    if (u.pathname === "/user") return send(200, me);
    const um = u.pathname.match(/^\/users\/([^/]+)$/);
    if (um) {
      const found = Object.values(users).find((x) => x.login === um[1].toLowerCase());
      return found ? send(200, found) : send(404, {});
    }
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/invitations$/);
    if (m) return m[1] === me.login ? send(200, invitations[`${m[1]}/${m[2]}`] ?? []) : send(404, {});
    send(404, {});
  });
});

let worker;
let base;
let persist;

before(async () => {
  mkdirSync(new URL("../public", import.meta.url), { recursive: true }); // wrangler wants the assets folder to exist
  await new Promise((r) => gh.listen(0, "127.0.0.1", r));
  const ghUrl = `http://127.0.0.1:${gh.address().port}`;
  // Entries left in the old KV inbox (from before the move to Durable Objects) for carol.
  persist = mkdtempSync(join(tmpdir(), "inbox-test-"));
  const proxy = await getPlatformProxy({ persist: { path: join(persist, "v3") } }) // the folder wrangler dev uses under persistTo;
  const soon = new Date(Date.now() + 3 * 864e5).toISOString();
  const old = { id: 555, from: "bob", from_id: 1, created_at: new Date().toISOString(), expires_at: soon };
  await proxy.env.INVITES.put("inv:4:555", JSON.stringify(old), { expirationTtl: 3 * 86400, metadata: old });
  const gone = { ...old, id: 556, expires_at: new Date(Date.now() - 1000).toISOString() };
  await proxy.env.INVITES.put("inv:4:556", JSON.stringify(gone), { metadata: gone });
  const tag = "ab".repeat(16);
  const cls = { id: `1:${tag}`, from: "bob", from_id: 1, tag, at: new Date().toISOString() };
  await proxy.env.INVITES.put(`cls:4:1:${tag}`, JSON.stringify(cls), { expirationTtl: 86400, metadata: cls });
  await proxy.dispose();

  worker = await unstable_dev("src/index.js", {
    vars: { GH_API: ghUrl, GH_WEB: ghUrl, GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "sec", ALLOWED_ORIGINS: "https://app.example" },
    persistTo: persist,
    experimental: { disableExperimentalWarning: true },
    logLevel: "error",
  });
  base = `http://${worker.address}:${worker.port}`;
});

after(async () => {
  await worker?.stop();
  gh.close();
  rmSync(persist, { recursive: true, force: true });
});

const call = (method, path, tok, body, headers = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

/** Opens the inbox socket the way the web app does and collects what it pushes. */
function socket(tok, origin = "https://app.example") {
  const ws = new WebSocket(base.replace("http", "ws") + "/inbox", { protocols: ["inbox.v1", `bearer.${tok}`], headers: { Origin: origin } });
  const got = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    const msg = ev.data === "pong" ? { type: "pong" } : JSON.parse(ev.data);
    const w = waiters.find((x) => x.type === msg.type);
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(msg);
    } else got.push(msg);
  });
  const next = (type) =>
    new Promise((resolve, reject) => {
      const i = got.findIndex((m) => m.type === type);
      if (i >= 0) return resolve(got.splice(i, 1)[0]);
      const t = setTimeout(() => reject(new Error(`no ${type} message`)), 5000);
      waiters.push({ type, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket failed")));
  });
  opened.catch(() => {});
  return { ws, got, next, opened };
}

test("bob registers a real invite, alice sees it, deletes it", async () => {
  let r = await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1" });
  assert.equal(r.status, 201);
  r = await call("GET", "/invites", "tok-alice");
  const { invites } = await r.json();
  assert.equal(invites.length, 1);
  assert.deepEqual(Object.keys(invites[0]).sort(), ["created_at", "expires_at", "from", "from_id", "id"]);
  assert.equal(invites[0].id, 100);
  assert.equal(invites[0].from, "bob");
  assert.ok(Date.parse(invites[0].expires_at) > Date.now() + 7 * 864e5 - 120e3);

  r = await call("GET", "/invites", "tok-eve");
  assert.equal((await r.json()).invites.length, 0, "eve sees nothing");
  assert.equal((await call("DELETE", "/invites/100", "tok-eve")).status, 404, "eve can't delete");
  assert.equal((await call("DELETE", "/invites/100", "tok-alice")).status, 200);
  assert.equal((await (await call("GET", "/invites", "tok-alice")).json()).invites.length, 0);
});

test("an invite can carry an opaque note for the invitee; bad notes are refused", async () => {
  let r = await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1", note: "c2VhbGVk" });
  assert.equal(r.status, 201);
  const { invites } = await (await call("GET", "/invites", "tok-alice")).json();
  assert.equal(invites[0].note, "c2VhbGVk");
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1", note: "not base64!" })).status, 400);
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1", note: "A".repeat(8193) })).status, 400);
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1", note: 5 })).status, 400);
  await call("DELETE", "/invites/100", "tok-alice");
});

test("inviter can withdraw, others cannot", async () => {
  await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1" });
  assert.equal((await call("DELETE", "/invites/100?invitee_id=2", "tok-eve")).status, 404);
  assert.equal((await call("DELETE", "/invites/100?invitee_id=2", "tok-bob")).status, 200);
  assert.equal((await (await call("GET", "/invites", "tok-alice")).json()).invites.length, 0);
});

test("forged or foreign invites are rejected", async () => {
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 999, repo: "dm-1" })).status, 404);
  assert.equal((await call("POST", "/invites", "tok-eve", { invite_id: 100, repo: "dm-1" })).status, 404);
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 101, repo: "dm-old" })).status, 410);
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "../x" })).status, 400);
  assert.equal((await call("POST", "/invites", null, { invite_id: 100, repo: "dm-1" })).status, 401);
  assert.equal((await call("POST", "/invites", "bad", { invite_id: 100, repo: "dm-1" })).status, 401);
  assert.equal((await (await call("GET", "/invites", "tok-alice")).json()).invites.length, 0);
});

test("the socket sends a snapshot, then pushes new and removed entries", async () => {
  const s = socket("tok-alice");
  await s.opened;
  assert.equal(s.ws.protocol, "inbox.v1");
  assert.deepEqual((await s.next("snapshot")).invites, []);
  await call("POST", "/invites", "tok-bob", { invite_id: 102, repo: "dm-2" });
  const pushed = await s.next("invite");
  assert.equal(pushed.invite.id, 102);
  assert.equal(pushed.invite.from, "bob");
  await call("DELETE", "/invites/102", "tok-alice");
  assert.equal((await s.next("invite-removed")).id, 102);
  const tag = "cd".repeat(16);
  await call("POST", "/closures", "tok-bob", { to: "alice", tag });
  assert.equal((await s.next("closure")).closure.tag, tag);
  await call("DELETE", `/closures/1:${tag}`, "tok-alice");
  assert.equal((await s.next("closure-removed")).id, `1:${tag}`);
  // The heartbeat is answered without running the inbox's code.
  s.ws.send("ping");
  await s.next("pong");
  // A second tab gets the same pushes; eve's socket gets nothing of alice's.
  const s2 = socket("tok-alice");
  const e = socket("tok-eve");
  await Promise.all([s2.opened, e.opened]);
  await s2.next("snapshot");
  await e.next("snapshot");
  await call("POST", "/invites", "tok-bob", { invite_id: 102, repo: "dm-2" });
  await s.next("invite");
  await s2.next("invite");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(e.got.filter((m) => m.type === "invite").length, 0);
  await call("DELETE", "/invites/102", "tok-alice");
  for (const x of [s, s2, e]) x.ws.close();
});

test("the socket needs a valid token and an allowed origin", async () => {
  await assert.rejects(socket("nope").opened);
  await assert.rejects(socket("tok-alice", "https://evil.example").opened);
  assert.equal((await call("GET", "/inbox", "tok-alice")).status, 426);
});

test("pending entries from the old KV inbox are copied once, expired ones are not", async () => {
  let r = await call("GET", "/invites", "tok-carol");
  assert.deepEqual((await r.json()).invites.map((i) => i.id), [555]);
  r = await call("GET", "/closures", "tok-carol");
  assert.equal((await r.json()).closures.length, 1);
  // Deleted entries stay deleted (no second copy from KV).
  assert.equal((await call("DELETE", "/invites/555", "tok-carol")).status, 200);
  const s = socket("tok-carol");
  await s.opened;
  const snap = await s.next("snapshot");
  assert.deepEqual(snap.invites, []);
  assert.equal(snap.closures.length, 1);
  s.ws.close();
});

test("token exchange adds the secret; device flow doesn't", async () => {
  await call("POST", "/oauth/token", null, { code: "abc" });
  assert.deepEqual(lastLogin, { path: "/login/oauth/access_token", body: { client_id: "cid", client_secret: "sec", code: "abc" } });
  await call("POST", "/oauth/token", null, { refresh_token: "r1" });
  assert.equal(lastLogin.body.grant_type, "refresh_token");
  await call("POST", "/oauth/device/code", null, {});
  assert.deepEqual(lastLogin.body, { client_id: "cid" });
  await call("POST", "/oauth/device/token", null, { device_code: "d" });
  assert.equal(lastLogin.body.client_secret, undefined);
  assert.equal((await call("POST", "/oauth/token", null, {})).status, 400);
});

test("a refresh asked again (answer lost while asleep) gets the same answer, once GitHub spent the token", async () => {
  const first = await (await call("POST", "/oauth/token", null, { refresh_token: "r-lost" })).json();
  assert.ok(first.access_token);
  const n = refreshes;
  const again = await (await call("POST", "/oauth/token", null, { refresh_token: "r-lost" })).json();
  assert.deepEqual(again, first);
  assert.equal(refreshes, n, "GitHub was not asked again");
  // Another refresh token gets its own answer, never this one.
  const other = await (await call("POST", "/oauth/token", null, { refresh_token: "r-other" })).json();
  assert.notEqual(other.access_token, first.access_token);
  // A dead refresh token GitHub turns down is passed through, not stored.
  spent.add("r-dead");
  assert.equal((await (await call("POST", "/oauth/token", null, { refresh_token: "r-dead" })).json()).error, "bad_refresh_token");
});

test("CORS only for allowed origins", async () => {
  let r = await call("OPTIONS", "/invites", null, null, { Origin: "https://app.example" });
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://app.example");
  r = await call("GET", "/invites", "tok-alice", null, { Origin: "https://evil.example" });
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), null);
});

test("closure notices: bob tells alice, alice lists and removes; eve can't see them", async () => {
  const tag = "0123456789abcdef0123456789abcdef";
  let r = await call("POST", "/closures", "tok-bob", { to: "alice", tag });
  assert.equal(r.status, 201);
  r = await call("POST", "/closures", "tok-bob", { to: "alice", tag });
  assert.equal(r.status, 201);
  r = await call("GET", "/closures", "tok-alice");
  const { closures } = await r.json();
  assert.equal(closures.length, 1);
  assert.equal(closures[0].from, "bob");
  assert.equal(closures[0].tag, tag);
  r = await call("GET", "/closures", "tok-eve");
  assert.equal((await r.json()).closures.length, 0);
  r = await call("DELETE", `/closures/${closures[0].id}`, "tok-alice");
  assert.equal(r.status, 200);
  r = await call("GET", "/closures", "tok-alice");
  assert.equal((await r.json()).closures.length, 0);
  assert.equal((await call("POST", "/closures", "tok-bob", { to: "nobody", tag })).status, 404);
  assert.equal((await call("POST", "/closures", "tok-bob", { to: "alice", tag: "xyz" })).status, 400);
  assert.equal((await call("POST", "/closures", "tok-bob", { to: "bob", tag })).status, 400);
});
