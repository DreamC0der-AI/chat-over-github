import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// ---- fake KV ----
function fakeKV() {
  const m = new Map();
  return {
    m,
    async put(k, v, o = {}) { m.set(k, { v, meta: o.metadata, ttl: o.expirationTtl }); },
    async get(k) { return m.get(k)?.v ?? null; },
    async delete(k) { m.delete(k); },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name, metadata: m.get(name).meta })), list_complete: true };
    },
  };
}

// ---- fake GitHub ----
const users = { "tok-bob": { id: 1, login: "bob" }, "tok-alice": { id: 2, login: "alice" }, "tok-eve": { id: 3, login: "eve" } };
let invitations; // repo full name -> [invitation]
let lastLogin;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.hostname === "github.com") {
    lastLogin = { path: u.pathname, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ access_token: "x" }), { status: 200 });
  }
  const tok = (init.headers?.Authorization || "").replace("Bearer ", "");
  const me = users[tok];
  if (!me) return new Response("{}", { status: 401 });
  if (u.pathname === "/user") return Response.json(me);
  const um = u.pathname.match(/^\/users\/([^/]+)$/);
  if (um) {
    const found = Object.values(users).find((x) => x.login === um[1].toLowerCase());
    return found ? Response.json(found) : new Response("{}", { status: 404 });
  }
  const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/invitations$/);
  if (m) {
    if (m[1] !== me.login) return new Response("{}", { status: 404 });
    return Response.json(invitations[`${m[1]}/${m[2]}`] ?? []);
  }
  return new Response("{}", { status: 404 });
};

let env;
beforeEach(() => {
  env = { INVITES: fakeKV(), GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "sec", ALLOWED_ORIGINS: "https://app.example" };
  invitations = {
    "bob/dm-1": [{ id: 100, invitee: { id: 2, login: "alice" }, expired: false, created_at: new Date().toISOString() }],
    "bob/dm-old": [{ id: 101, invitee: { id: 2, login: "alice" }, expired: false, created_at: new Date(Date.now() - 8 * 864e5).toISOString() }],
  };
});

const call = (method, path, tok, body, headers = {}) =>
  worker.fetch(new Request("https://w.example" + path, {
    method,
    headers: { ...(tok ? { Authorization: `Bearer ${tok}` } : {}), "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

test("bob registers a real invite, alice sees it, deletes it", async () => {
  let r = await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1" });
  assert.equal(r.status, 201);
  const [entry] = env.INVITES.m.values();
  assert.ok(entry.ttl > 7 * 86400 - 60 && entry.ttl <= 7 * 86400);
  assert.deepEqual(Object.keys(JSON.parse(entry.v)).sort(), ["created_at", "expires_at", "from", "from_id", "id"]);

  r = await call("GET", "/invites", "tok-alice");
  const { invites } = await r.json();
  assert.equal(invites.length, 1);
  assert.equal(invites[0].id, 100);
  assert.equal(invites[0].from, "bob");

  r = await call("GET", "/invites", "tok-eve");
  assert.equal((await r.json()).invites.length, 0, "eve sees nothing");

  r = await call("DELETE", "/invites/100", "tok-eve");
  assert.equal(r.status, 404, "eve can't delete");
  r = await call("DELETE", "/invites/100", "tok-alice");
  assert.equal(r.status, 200);
  assert.equal(env.INVITES.m.size, 0);
});

test("inviter can withdraw, others cannot", async () => {
  await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "dm-1" });
  assert.equal((await call("DELETE", "/invites/100?invitee_id=2", "tok-eve")).status, 404);
  assert.equal((await call("DELETE", "/invites/100?invitee_id=2", "tok-bob")).status, 200);
});

test("forged or foreign invites are rejected", async () => {
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 999, repo: "dm-1" })).status, 404);
  assert.equal((await call("POST", "/invites", "tok-eve", { invite_id: 100, repo: "dm-1" })).status, 404);
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 101, repo: "dm-old" })).status, 410);
  assert.equal((await call("POST", "/invites", "tok-bob", { invite_id: 100, repo: "../x" })).status, 400);
  assert.equal((await call("POST", "/invites", null, { invite_id: 100, repo: "dm-1" })).status, 401);
  assert.equal((await call("POST", "/invites", "bad", { invite_id: 100, repo: "dm-1" })).status, 401);
  assert.equal(env.INVITES.m.size, 0);
});

test("expired entries are hidden even if KV hasn't evicted them yet", async () => {
  const past = new Date(Date.now() - 1000).toISOString();
  await env.INVITES.put("inv:2:5", "{}", { metadata: { id: 5, from: "bob", expires_at: past } });
  assert.equal((await (await call("GET", "/invites", "tok-alice")).json()).invites.length, 0);
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
