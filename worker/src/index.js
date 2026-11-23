// Chat over GitHub: the only backend.
//
//   POST   /oauth/token          exchange an OAuth code or refresh token (needs the client secret)
//   POST   /oauth/device/code    device-flow proxy (browsers can't call github.com directly: no CORS)
//   POST   /oauth/device/token   device-flow polling proxy
//   GET    /inbox                WebSocket: the caller's inbox pushes invitations and closure notices
//   POST   /invites              inviter registers a GitHub repo invitation for the invitee
//   GET    /invites              invitee lists pending invitations addressed to them
//   DELETE /invites/:id          invitee (or inviter) removes an entry after accept/decline
//   POST   /closures             a chat's owner tells a member the chat was closed
//   GET    /closures             a member lists closure notices addressed to them
//   DELETE /closures/:id         the member removes a notice once their app has seen it
//
// Every inbox call carries the caller's GitHub user access token (Authorization: Bearer ...,
// or for the WebSocket, which browsers can't give headers, the subprotocol "bearer.<token>").
// The Worker checks identity with GitHub on each call and checks that an invitation really
// exists before storing it, so nobody can plant or read someone else's entries.
//
// Each user's inbox is one Durable Object (named by their GitHub user id) with its own SQLite
// tables:
//   invites:  {id, from, from_id, created_at, expires_at, note?}   expires with GitHub's 7-day invitation;
//             note is an opaque blob the inviter's app sealed for the invitee's devices
//   closures: {id, from, from_id, tag, at}                    lives 7 days
// No repo names, no messages. The tag of a closure is an opaque hash the members' apps derive
// from the chat; the Worker can't link it to a repo. The sender is whoever's token made the
// call; the members' apps check the sender owns the chat before believing a notice.
// Open app tabs hold a hibernating WebSocket to their inbox, so an idle tab costs nothing and
// new entries arrive at once instead of by polling.
//
// Until 2026-11-17 the inbox lived in Workers KV (binding INVITES). Each inbox copies its old
// KV entries once, the first time it is used. KV entries expire within 7 days, after which the
// INVITES binding can be removed.
// Nothing is logged.

import { DurableObject } from "cloudflare:workers";

const GH_API_DEFAULT = "https://api.github.com";
const GH_WEB_DEFAULT = "https://github.com";
const INVITE_LIFETIME_S = 7 * 24 * 3600; // GitHub repository invitations expire after 7 days
const MIN_TTL_S = 60; // don't file an invitation that is about to expire
const WS_PROTOCOL = "inbox.v1";
let GH_API = GH_API_DEFAULT;
let GH_WEB = GH_WEB_DEFAULT;

export default {
  async fetch(request, env) {
    // Tests point these at a fake GitHub.
    GH_API = env.GH_API || GH_API_DEFAULT;
    GH_WEB = env.GH_WEB || GH_WEB_DEFAULT;
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      const path = new URL(request.url).pathname.replace(/\/+$/, "");
      // A WebSocket upgrade's response can't take extra headers, so it skips the CORS step.
      if (path === "/inbox" && request.method === "GET") return await openInbox(request, env);
      const res = await route(request, env);
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : "internal error";
      return json({ error: message }, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const m = request.method;

  if (m === "POST" && path === "/oauth/token") return oauthToken(request, env);
  if (m === "POST" && path === "/oauth/device/code") return deviceCode(request, env);
  if (m === "POST" && path === "/oauth/device/token") return deviceToken(request, env);
  if (m === "POST" && path === "/invites") return createInvite(request, env);
  if (m === "GET" && path === "/invites") return listInvites(request, env);
  const del = path.match(/^\/invites\/(\d+)$/);
  if (m === "DELETE" && del) return deleteInvite(request, env, del[1]);
  if (m === "POST" && path === "/closures") return createClosure(request, env);
  if (m === "GET" && path === "/closures") return listClosures(request, env);
  const delc = path.match(/^\/closures\/(\d+:[0-9a-f]{32})$/);
  if (m === "DELETE" && delc) return deleteClosure(request, env, delc[1]);
  throw new HttpError(404, "not found");
}

// ---------- OAuth ----------

async function oauthToken(request, env) {
  const body = await readJson(request);
  const params = { client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET };
  if (typeof body.code === "string") {
    params.code = body.code;
    if (typeof body.redirect_uri === "string") params.redirect_uri = body.redirect_uri;
    if (typeof body.code_verifier === "string") params.code_verifier = body.code_verifier;
  } else if (typeof body.refresh_token === "string") {
    params.grant_type = "refresh_token";
    params.refresh_token = body.refresh_token;
  } else {
    throw new HttpError(400, "code or refresh_token required");
  }
  return ghLogin("/login/oauth/access_token", params);
}

async function deviceCode(request, env) {
  return ghLogin("/login/device/code", { client_id: env.GITHUB_CLIENT_ID });
}

async function deviceToken(request, env) {
  const body = await readJson(request);
  if (typeof body.device_code !== "string") throw new HttpError(400, "device_code required");
  return ghLogin("/login/oauth/access_token", {
    client_id: env.GITHUB_CLIENT_ID,
    device_code: body.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
}

async function ghLogin(path, params) {
  const res = await fetch(GH_WEB + path, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  return new Response(text, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---------- Invite inbox ----------

/** The inbox Durable Object of one GitHub user. */
const inbox = (env, userId) => env.INBOX.get(env.INBOX.idFromName(String(userId)));

async function openInbox(request, env) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") throw new HttpError(426, "WebSocket required");
  // Only our own pages may open a socket (a socket isn't covered by CORS).
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins(env).includes(origin)) throw new HttpError(403, "origin not allowed");
  const offered = (request.headers.get("Sec-WebSocket-Protocol") || "").split(",").map((s) => s.trim());
  const fromProtocol = offered.find((p) => p.startsWith("bearer."));
  const token = fromProtocol ? fromProtocol.slice(7) : bearer(request);
  const me = await ghUser(token);
  const forward = new Request(request);
  forward.headers.set("X-Inbox-User", String(me.id));
  if (offered.includes(WS_PROTOCOL)) forward.headers.set("X-Inbox-Protocol", WS_PROTOCOL);
  else forward.headers.delete("X-Inbox-Protocol");
  return inbox(env, me.id).fetch(forward);
}

async function createInvite(request, env) {
  const token = bearer(request);
  const body = await readJson(request);
  const inviteId = Number(body.invite_id);
  const repo = typeof body.repo === "string" ? body.repo : "";
  if (!Number.isSafeInteger(inviteId) || inviteId <= 0) throw new HttpError(400, "invite_id required");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new HttpError(400, "repo required");
  // Optional note sealed to the invitee's devices by the inviter's app. Opaque here: only its size is checked.
  const note = body.note === undefined ? undefined : body.note;
  if (note !== undefined && (typeof note !== "string" || !/^[A-Za-z0-9+/=]{1,8192}$/.test(note))) throw new HttpError(400, "note must be base64, at most 8192 characters");

  const me = await ghUser(token);
  // The repo must belong to the caller, and the invitation must exist on it.
  const invites = await ghGet(
    token,
    `/repos/${encodeURIComponent(me.login)}/${encodeURIComponent(repo)}/invitations?per_page=100`,
  );
  const inv = Array.isArray(invites) ? invites.find((i) => i.id === inviteId) : undefined;
  if (!inv) throw new HttpError(404, "invitation not found on your repository");
  if (inv.expired) throw new HttpError(410, "invitation expired; re-invite");
  if (!inv.invitee || typeof inv.invitee.id !== "number") throw new HttpError(422, "invitation has no invitee");

  const created = Date.parse(inv.created_at) || Date.now();
  const expiresAt = created + INVITE_LIFETIME_S * 1000;
  if (expiresAt - Date.now() < MIN_TTL_S * 1000) throw new HttpError(410, "invitation about to expire; re-invite");

  const entry = {
    id: inviteId,
    from: me.login,
    from_id: me.id,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
    ...(note ? { note } : {}),
  };
  await inbox(env, inv.invitee.id).addInvite(inv.invitee.id, entry);
  return json({ ok: true, invitee_id: inv.invitee.id, expires_at: entry.expires_at }, 201);
}

async function listInvites(request, env) {
  const me = await ghUser(bearer(request));
  return json({ invites: await inbox(env, me.id).listInvites(me.id) });
}

async function deleteInvite(request, env, idStr) {
  const me = await ghUser(bearer(request));
  const inviteId = Number(idStr);
  // Invitee removes their own entry.
  if (await inbox(env, me.id).removeInvite(me.id, inviteId)) return json({ ok: true });
  // Inviter may withdraw: the invitee id must be given and the entry must be from the caller.
  const url = new URL(request.url);
  const inviteeId = Number(url.searchParams.get("invitee_id"));
  if (Number.isSafeInteger(inviteeId) && inviteeId > 0 && inviteeId !== me.id) {
    if (await inbox(env, inviteeId).removeInvite(inviteeId, inviteId, me.id)) return json({ ok: true });
  }
  throw new HttpError(404, "not found");
}

// ---------- Closure notices ----------

async function createClosure(request, env) {
  const token = bearer(request);
  const body = await readJson(request);
  const to = typeof body.to === "string" ? body.to : "";
  const tag = typeof body.tag === "string" ? body.tag : "";
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(to)) throw new HttpError(400, "to required");
  if (!/^[0-9a-f]{32}$/.test(tag)) throw new HttpError(400, "tag required");
  const me = await ghUser(token);
  const target = await ghGetUser(token, to);
  if (target.id === me.id) throw new HttpError(400, "cannot notify yourself");
  const at = new Date().toISOString();
  // One notice per sender and chat: posting again just refreshes it.
  const entry = { id: `${me.id}:${tag}`, from: me.login, from_id: me.id, tag, at };
  await inbox(env, target.id).addClosure(target.id, entry);
  return json({ ok: true }, 201);
}

async function listClosures(request, env) {
  const me = await ghUser(bearer(request));
  return json({ closures: await inbox(env, me.id).listClosures(me.id) });
}

async function deleteClosure(request, env, id) {
  const me = await ghUser(bearer(request));
  await inbox(env, me.id).removeClosure(me.id, id);
  return json({ ok: true });
}

// ---------- The inbox Durable Object ----------

/**
 * One user's inbox. Every method takes the owner's user id (the object is named by it), which
 * the first call stores and uses to copy the user's old KV entries once.
 *
 * Pushed to open sockets, as JSON text:
 *   {type:"snapshot", invites:[...], closures:[...]}   right after connecting
 *   {type:"invite", invite} / {type:"invite-removed", id}
 *   {type:"closure", closure} / {type:"closure-removed", id}
 * The socket answers the text "ping" with "pong" without waking the object.
 */
export class Inbox extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS invites (id INTEGER PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS closures (id TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.ready = false;
  }

  // ---- RPC from the Worker ----

  async addInvite(userId, entry) {
    await this.open(userId);
    const expires = Date.parse(entry.expires_at);
    this.sql.exec("INSERT OR REPLACE INTO invites (id, body, expires) VALUES (?, ?, ?)", entry.id, JSON.stringify(entry), expires);
    await this.wakeAt(expires);
    this.push({ type: "invite", invite: entry });
  }

  async listInvites(userId) {
    await this.open(userId);
    return this.rows("invites");
  }

  /** Removes an invite; with fromId, only one that caller sent. True if one was removed. */
  async removeInvite(userId, id, fromId) {
    await this.open(userId);
    const row = this.sql.exec("SELECT body FROM invites WHERE id = ?", id).toArray()[0];
    if (!row) return false;
    if (fromId !== undefined && JSON.parse(row.body).from_id !== fromId) return false;
    this.sql.exec("DELETE FROM invites WHERE id = ?", id);
    this.push({ type: "invite-removed", id });
    return true;
  }

  async addClosure(userId, entry) {
    await this.open(userId);
    const expires = Date.now() + INVITE_LIFETIME_S * 1000;
    this.sql.exec("INSERT OR REPLACE INTO closures (id, body, expires) VALUES (?, ?, ?)", entry.id, JSON.stringify(entry), expires);
    await this.wakeAt(expires);
    this.push({ type: "closure", closure: entry });
  }

  async listClosures(userId) {
    await this.open(userId);
    return this.rows("closures");
  }

  async removeClosure(userId, id) {
    await this.open(userId);
    const n = this.sql.exec("DELETE FROM closures WHERE id = ?", id).rowsWritten;
    if (n) this.push({ type: "closure-removed", id });
  }

  // ---- WebSocket ----

  async fetch(request) {
    const userId = Number(request.headers.get("X-Inbox-User"));
    if (!Number.isSafeInteger(userId) || userId <= 0) return new Response("bad request", { status: 400 });
    await this.open(userId);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ type: "snapshot", invites: this.rows("invites"), closures: this.rows("closures") }));
    const protocol = request.headers.get("X-Inbox-Protocol");
    return new Response(null, { status: 101, webSocket: client, headers: protocol ? { "Sec-WebSocket-Protocol": protocol } : {} });
  }

  async webSocketMessage(ws, message) {
    // Anything but the automatic ping: send a fresh snapshot.
    if (message === "sync") ws.send(JSON.stringify({ type: "snapshot", invites: this.rows("invites"), closures: this.rows("closures") }));
  }

  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  async webSocketError() {}

  // ---- expiry ----

  async alarm() {
    const now = Date.now();
    for (const table of ["invites", "closures"]) {
      const gone = this.sql.exec(`SELECT id FROM ${table} WHERE expires <= ?`, now).toArray();
      if (!gone.length) continue;
      this.sql.exec(`DELETE FROM ${table} WHERE expires <= ?`, now);
      for (const { id } of gone) this.push({ type: table === "invites" ? "invite-removed" : "closure-removed", id });
    }
    const next = this.sql
      .exec("SELECT MIN(e) AS e FROM (SELECT MIN(expires) AS e FROM invites UNION ALL SELECT MIN(expires) AS e FROM closures)")
      .toArray()[0]?.e;
    if (next) await this.ctx.storage.setAlarm(next);
  }

  // ---- helpers ----

  /** Unexpired entries of a table, oldest first. */
  rows(table) {
    return this.sql
      .exec(`SELECT body FROM ${table} WHERE expires > ? ORDER BY expires`, Date.now())
      .toArray()
      .map((r) => JSON.parse(r.body));
  }

  push(msg) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        // closing
      }
    }
  }

  /** Make sure the alarm fires by the given time, to drop expired entries. */
  async wakeAt(t) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > t) await this.ctx.storage.setAlarm(t);
  }

  /** First use: remember whose inbox this is, and copy their entries from the old KV inbox. */
  async open(userId) {
    if (this.ready) return;
    const owner = this.sql.exec("SELECT v FROM meta WHERE k = 'owner'").toArray()[0]?.v;
    if (owner !== undefined && owner !== String(userId)) throw new Error("inbox owner mismatch");
    if (owner === undefined) {
      await this.importKv(userId);
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('owner', ?)", String(userId));
    }
    this.ready = true;
  }

  async importKv(userId) {
    const kv = this.env.INVITES;
    if (!kv) return;
    const now = Date.now();
    let earliest = Infinity;
    for (const [prefix, table] of [[`inv:${userId}:`, "invites"], [`cls:${userId}:`, "closures"]]) {
      let cursor;
      do {
        const page = await kv.list({ prefix, cursor });
        for (const k of page.keys) {
          let e = k.metadata;
          if (!e) {
            const v = await kv.get(k.name);
            e = v ? JSON.parse(v) : undefined;
          }
          if (!e || e.id === undefined) continue;
          // KV gives the key's own expiry; invites also carry theirs.
          const expires = table === "invites" ? Date.parse(e.expires_at) : (k.expiration ? k.expiration * 1000 : Date.parse(e.at) + INVITE_LIFETIME_S * 1000);
          if (!(expires > now)) continue;
          this.sql.exec(`INSERT OR IGNORE INTO ${table} (id, body, expires) VALUES (?, ?, ?)`, e.id, JSON.stringify(e), expires);
          earliest = Math.min(earliest, expires);
        }
        cursor = page.list_complete ? undefined : page.cursor;
      } while (cursor);
    }
    if (earliest !== Infinity) await this.wakeAt(earliest);
  }
}

async function ghGetUser(token, login) {
  const res = await fetch(`${GH_API}/users/${encodeURIComponent(login)}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "chat-over-github-worker",
    },
  });
  if (res.status === 404) throw new HttpError(404, "no such user");
  if (!res.ok) throw new HttpError(502, `github error ${res.status}`);
  const u = await res.json();
  if (!u || typeof u.id !== "number") throw new HttpError(404, "no such user");
  return { id: u.id, login: u.login };
}

// ---------- GitHub helpers ----------

async function ghUser(token) {
  const u = await ghGet(token, "/user");
  if (!u || typeof u.id !== "number") throw new HttpError(401, "invalid token");
  return { id: u.id, login: u.login };
}

async function ghGet(token, path) {
  const res = await fetch(GH_API + path, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "chat-over-github-worker",
    },
  });
  if (res.status === 401) throw new HttpError(401, "invalid token");
  if (res.status === 403 || res.status === 404) throw new HttpError(404, "invitation not found on your repository");
  if (!res.ok) throw new HttpError(502, `github error ${res.status}`);
  return res.json();
}

// ---------- utils ----------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bearer(request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(\S+)$/i);
  if (!m) throw new HttpError(401, "missing bearer token");
  return m[1];
}

async function readJson(request) {
  try {
    const v = await request.json();
    return v && typeof v === "object" ? v : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

const allowedOrigins = (env) => (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(env).includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
