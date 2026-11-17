// Chat over GitHub: the only backend.
//
//   POST   /oauth/token          exchange an OAuth code or refresh token (needs the client secret)
//   POST   /oauth/device/code    device-flow proxy (browsers can't call github.com directly: no CORS)
//   POST   /oauth/device/token   device-flow polling proxy
//   POST   /invites              inviter registers a GitHub repo invitation for the invitee
//   GET    /invites              invitee lists pending invitations addressed to them
//   DELETE /invites/:id          invitee (or inviter) removes an entry after accept/decline
//   POST   /closures             a chat's owner tells a member the chat was closed
//   GET    /closures             a member lists closure notices addressed to them
//   DELETE /closures/:id         the member removes a notice once their app has seen it
//
// Every /invites call carries the caller's GitHub user access token
// (Authorization: Bearer ...). The Worker checks identity with GitHub on each call
// and checks that the invitation really exists before storing it, so nobody can
// plant or read someone else's entries. KV holds only
//   inv:<invitee user id>:<invitation id> -> {id, from, from_id, created_at, expires_at}
// with a TTL that matches GitHub's 7-day invitation expiry. No repo names, no messages.
// Closure notices are
//   cls:<member user id>:<sender user id>:<tag> -> {id, from, from_id, tag, at}
// where tag is an opaque hash the members' apps derive from the chat; the Worker can't link
// it to a repo. They also live 7 days. The sender is whoever's token made the call; the
// members' apps check the sender owns the chat before believing a notice.
// Nothing is logged.

const GH_API = "https://api.github.com";
const GH_WEB = "https://github.com";
const INVITE_LIFETIME_S = 7 * 24 * 3600; // GitHub repository invitations expire after 7 days
const MIN_TTL_S = 60; // KV minimum expirationTtl

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
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

async function createInvite(request, env) {
  const token = bearer(request);
  const body = await readJson(request);
  const inviteId = Number(body.invite_id);
  const repo = typeof body.repo === "string" ? body.repo : "";
  if (!Number.isSafeInteger(inviteId) || inviteId <= 0) throw new HttpError(400, "invite_id required");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) throw new HttpError(400, "repo required");

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
  const ttl = Math.floor((expiresAt - Date.now()) / 1000);
  if (ttl < MIN_TTL_S) throw new HttpError(410, "invitation about to expire; re-invite");

  const entry = {
    id: inviteId,
    from: me.login,
    from_id: me.id,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
  await env.INVITES.put(key(inv.invitee.id, inviteId), JSON.stringify(entry), {
    expirationTtl: ttl,
    metadata: entry,
  });
  return json({ ok: true, invitee_id: inv.invitee.id, expires_at: entry.expires_at }, 201);
}

async function listInvites(request, env) {
  const me = await ghUser(bearer(request));
  const out = [];
  let cursor;
  do {
    const page = await env.INVITES.list({ prefix: `inv:${me.id}:`, cursor });
    for (const k of page.keys) {
      if (k.metadata) out.push(k.metadata);
      else {
        const v = await env.INVITES.get(k.name);
        if (v) out.push(JSON.parse(v));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  const now = Date.now();
  return json({ invites: out.filter((e) => Date.parse(e.expires_at) > now) });
}

async function deleteInvite(request, env, idStr) {
  const me = await ghUser(bearer(request));
  const inviteId = Number(idStr);
  // Invitee removes their own entry.
  const own = key(me.id, inviteId);
  if (await env.INVITES.get(own)) {
    await env.INVITES.delete(own);
    return json({ ok: true });
  }
  // Inviter may withdraw: the invitee id must be given and the entry must be from the caller.
  const url = new URL(request.url);
  const inviteeId = Number(url.searchParams.get("invitee_id"));
  if (Number.isSafeInteger(inviteeId) && inviteeId > 0) {
    const k = key(inviteeId, inviteId);
    const v = await env.INVITES.get(k);
    if (v && JSON.parse(v).from_id === me.id) {
      await env.INVITES.delete(k);
      return json({ ok: true });
    }
  }
  throw new HttpError(404, "not found");
}

const key = (inviteeId, inviteId) => `inv:${inviteeId}:${inviteId}`;

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
  const entry = { id: `${me.id}:${tag}`, from: me.login, from_id: me.id, tag, at };
  // One notice per sender and chat: posting again just refreshes it.
  await env.INVITES.put(`cls:${target.id}:${me.id}:${tag}`, JSON.stringify(entry), {
    expirationTtl: INVITE_LIFETIME_S,
    metadata: entry,
  });
  return json({ ok: true }, 201);
}

async function listClosures(request, env) {
  const me = await ghUser(bearer(request));
  const out = [];
  let cursor;
  do {
    const page = await env.INVITES.list({ prefix: `cls:${me.id}:`, cursor });
    for (const k of page.keys) {
      if (k.metadata) out.push(k.metadata);
      else {
        const v = await env.INVITES.get(k.name);
        if (v) out.push(JSON.parse(v));
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ closures: out });
}

async function deleteClosure(request, env, id) {
  const me = await ghUser(bearer(request));
  await env.INVITES.delete(`cls:${me.id}:${id}`);
  return json({ ok: true });
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

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return { Vary: "Origin" };
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
