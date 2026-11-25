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
  "tok-mallory": { id: 5, login: "mallory" },
  "tok-dora": { id: 6, login: "dora" },
  "tok-rl": { id: 7, login: "rl" },
  "tok-erin": { id: 8, login: "erin" },
};
// Others who can each post into dora's inbox (for its total cap).
for (let i = 0; i < 10; i++) users[`tok-s${i}`] = { id: 200 + i, login: `s${i}` };
const invitations = {
  "bob/dm-1": [{ id: 100, invitee: { id: 2, login: "alice" }, expired: false, created_at: new Date().toISOString() }],
  "bob/dm-2": [{ id: 102, invitee: { id: 2, login: "alice" }, expired: false, created_at: new Date().toISOString() }],
  // mallory's many invitations to dora (for the per-sender cap).
  "mallory/bulk": Array.from({ length: 52 }, (_, i) => ({ id: 1000 + i, invitee: { id: 6, login: "dora" }, expired: false, created_at: new Date().toISOString() })),
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

test("token exchange adds the secret; device flow is gone", async () => {
  await call("POST", "/oauth/token", null, { code: "abc" });
  assert.deepEqual(lastLogin, { path: "/login/oauth/access_token", body: { client_id: "cid", client_secret: "sec", code: "abc" } });
  await call("POST", "/oauth/token", null, { refresh_token: "r1" });
  assert.equal(lastLogin.body.grant_type, "refresh_token");
  // Device flow is off (phishing risk): no proxy for it.
  assert.equal((await call("POST", "/oauth/device/code", null, {})).status, 404);
  assert.equal((await call("POST", "/oauth/device/token", null, { device_code: "d" })).status, 404);
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

// ---- abuse limits ----

const hex32 = (n) => n.toString(16).padStart(32, "0");
/** Runs fns a few at a time and returns their results in order. */
async function inBatches(fns, size = 25) {
  const out = [];
  for (let i = 0; i < fns.length; i += size) out.push(...(await Promise.all(fns.slice(i, i + size).map((f) => f()))));
  return out;
}

test("one sender can leave at most 50 closure notices in an inbox; an inbox holds at most 500", async () => {
  const post = (tok, n) => () => call("POST", "/closures", tok, { to: "dora", tag: hex32(n) }).then(async (r) => ({ status: r.status, error: (await r.json()).error }));
  let res = await inBatches(Array.from({ length: 50 }, (_, i) => post("tok-mallory", i)));
  assert.deepEqual(new Set(res.map((r) => r.status)), new Set([201]));
  const over = await post("tok-mallory", 50)();
  assert.equal(over.status, 429);
  assert.match(over.error, /inbox is full/);
  // Posting a notice that is already there just refreshes it, even at the cap.
  assert.equal((await post("tok-mallory", 7)()).status, 201);
  // Others still have room, up to 500 in all.
  for (let s = 0; s < 9; s++) {
    res = await inBatches(Array.from({ length: 50 }, (_, i) => post(`tok-s${s}`, 1000 * (s + 1) + i)));
    assert.deepEqual(new Set(res.map((r) => r.status)), new Set([201]), `s${s}`);
  }
  assert.equal((await post("tok-s9", 1)()).status, 429, "the inbox is full");
  const { closures } = await (await call("GET", "/closures", "tok-dora")).json();
  assert.equal(closures.length, 500);
  // Once dora removes one, there is room again.
  assert.equal((await call("DELETE", `/closures/${closures[0].id}`, "tok-dora")).status, 200);
  assert.equal((await post("tok-s9", 1)()).status, 201);
});

test("one sender can leave at most 50 invites in an inbox", async () => {
  const res = await inBatches(Array.from({ length: 51 }, (_, i) => () => call("POST", "/invites", "tok-mallory", { invite_id: 1000 + i, repo: "bulk" })));
  assert.equal(res.filter((r) => r.status === 201).length, 50);
  assert.equal(res.filter((r) => r.status === 429).length, 1);
  // Re-registering one that is there is fine.
  assert.equal((await call("POST", "/invites", "tok-mallory", { invite_id: 1003, repo: "bulk" })).status, 201);
  assert.equal((await (await call("GET", "/invites", "tok-dora")).json()).invites.length, 50);
});

test("bodies over 16 KB are refused, by Content-Length or while reading", async () => {
  const big = { invite_id: 100, repo: "dm-1", pad: "x".repeat(17 * 1024) };
  assert.equal((await call("POST", "/invites", "tok-bob", big)).status, 413);
  assert.equal((await call("POST", "/oauth/token", null, { refresh_token: "x".repeat(17 * 1024) })).status, 413);
  // A chunked body (no Content-Length) is counted as it arrives.
  const status = await new Promise((resolve, reject) => {
    const u = new URL(base + "/closures");
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { Authorization: "Bearer tok-bob", "Content-Type": "application/json", "Transfer-Encoding": "chunked" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.write('{"to":"alice","tag":"' + "0".repeat(32) + '","pad":"');
    for (let i = 0; i < 20; i++) req.write("y".repeat(1024));
    req.end('"}');
  });
  assert.equal(status, 413);
  // An ordinary body still works.
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1", note: "A".repeat(8192) })).status, 201);
  await call("DELETE", "/invites/100", "tok-alice");
});

test("a refresh replayed with the spent refresh token but without the app's retry key gets nothing", async () => {
  const key = "k".repeat(22);
  const first = await (await call("POST", "/oauth/token", null, { refresh_token: "r-keyed", retry_key: key })).json();
  assert.ok(first.access_token);
  const n = refreshes;
  // The app that lost the answer asks again with the same retry key: same answer, GitHub not asked.
  assert.deepEqual(await (await call("POST", "/oauth/token", null, { refresh_token: "r-keyed", retry_key: key })).json(), first);
  assert.equal(refreshes, n);
  // Anyone else with the old refresh token: no cached answer, and GitHub says it is spent.
  assert.equal((await (await call("POST", "/oauth/token", null, { refresh_token: "r-keyed" })).json()).error, "bad_refresh_token");
  assert.equal((await (await call("POST", "/oauth/token", null, { refresh_token: "r-keyed", retry_key: "z".repeat(22) })).json()).error, "bad_refresh_token");
  assert.equal(refreshes, n);
  assert.equal((await call("POST", "/oauth/token", null, { refresh_token: "r-keyed", retry_key: "short" })).status, 400);
});

test("a refresh from an app without a retry key is kept 60 seconds, a keyed one 10 minutes", async () => {
  await call("POST", "/oauth/token", null, { refresh_token: "r-ttl-old" });
  await call("POST", "/oauth/token", null, { refresh_token: "r-ttl-new", retry_key: "q".repeat(22) });
  const id = async (rt, retryKey) => {
    const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(rt), "HKDF", false, ["deriveBits"]);
    const salt = retryKey ? new TextEncoder().encode(`retry-key:${retryKey}`) : new Uint8Array(0);
    const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode("chat-over-github refresh retry id") }, raw, 256);
    return "rt:" + Buffer.from(bits).toString("hex");
  };
  const proxy = await getPlatformProxy({ persist: { path: join(persist, "v3") } });
  try {
    const { keys } = await proxy.env.INVITES.list({ prefix: "rt:" });
    const ttl = async (rt, k) => {
      const name = await id(rt, k);
      const e = keys.find((x) => x.name === name);
      assert.ok(e, `${rt} cached`);
      return e.expiration - Date.now() / 1000;
    };
    const old = await ttl("r-ttl-old");
    assert.ok(old > 30 && old <= 61, `legacy ttl ${old}`);
    const keyed = await ttl("r-ttl-new", "q".repeat(22));
    assert.ok(keyed > 540 && keyed <= 601, `keyed ttl ${keyed}`);
  } finally {
    await proxy.dispose();
  }
});

test("posting invites and closures is rate limited per user", async () => {
  const res = await inBatches(
    Array.from({ length: 115 }, (_, i) => () => call("POST", "/closures", "tok-rl", { to: "erin", tag: hex32(i) }).then(async (r) => (await r.json()).error ?? r.status)),
    5,
  );
  assert.deepEqual(res.slice(0, 50), Array(50).fill(201));
  assert.ok(res.includes("too many requests; try again in a minute"), "rate limited");
  // Another user is not affected.
  assert.equal((await call("POST", "/closures", "tok-bob", { to: "erin", tag: hex32(1) })).status, 201);
});

test("OAuth calls are rate limited per IP", async () => {
  const from = (ip) => ({ "CF-Connecting-IP": ip });
  const res = await inBatches(Array.from({ length: 70 }, () => () => call("POST", "/oauth/token", null, {}, from("198.51.100.7")).then((r) => r.status)), 10);
  assert.ok(res.includes(429), "rate limited");
  assert.ok(res.slice(0, 50).every((s) => s === 400));
  assert.equal((await call("POST", "/oauth/token", null, {}, from("198.51.100.8"))).status, 400, "another IP is not affected");
});

test("production trusts only the real origin; local dev adds localhost", async () => {
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const origins = toml.match(/^ALLOWED_ORIGINS\s*=\s*"([^"]*)"/m)[1].split(",");
  assert.deepEqual(origins, ["https://chat-over-github.akagishigerutokyo.workers.dev"]);
  const dev = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.dev;
  assert.match(dev, /--var ALLOWED_ORIGINS:https:\/\/chat-over-github\.akagishigerutokyo\.workers\.dev,http:\/\/localhost:5173/);
});
