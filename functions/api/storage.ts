type Env = {
  DB?: D1Database;
  ALLOW_LOCAL_GUEST?: string;
};

type JsonBody = {
  data?: Record<string, unknown>;
  keys?: unknown;
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function getOwner(request: Request, env: Env): string | null {
  const owner = request.headers.get("cf-access-authenticated-user-email")
    || request.headers.get("oai-authenticated-user-email");
  if (owner) return owner.trim().toLowerCase().slice(0, 254);
  if (env.ALLOW_LOCAL_GUEST === "true") return "local-preview@solara.invalid";
  return null;
}

function hasD1(env: Env): env is Env & { DB: D1Database } {
  return Boolean(env.DB && typeof env.DB.prepare === "function");
}

async function ensureTable(db: D1Database): Promise<void> {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS user_store (
      owner TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (owner, key)
    )`
  ).run();
}

async function handleGet(request: Request, env: Env, owner: string): Promise<Response> {
  if (!hasD1(env)) return json({ d1Available: false, authenticated: true, data: {} });
  await ensureTable(env.DB);
  const url = new URL(request.url);
  if (url.searchParams.get("status")) {
    return json({ d1Available: true, authenticated: true, owner });
  }

  const keys = (url.searchParams.get("keys") || "").split(",").map((key) => key.trim()).filter(Boolean).slice(0, 100);
  const data: Record<string, string | null> = {};
  if (keys.length === 0) return json({ d1Available: true, authenticated: true, data });
  keys.forEach((key) => { data[key] = null; });
  const placeholders = keys.map(() => "?").join(",");
  const result = await env.DB.prepare(
    `SELECT key, value FROM user_store WHERE owner = ? AND key IN (${placeholders})`
  ).bind(owner, ...keys).all();
  for (const row of (result.results || []) as Array<{ key: string; value: string | null }>) {
    data[row.key] = row.value;
  }
  return json({ d1Available: true, authenticated: true, data });
}

async function handlePost(request: Request, env: Env, owner: string): Promise<Response> {
  if (!hasD1(env)) return json({ d1Available: false, authenticated: true }, 503);
  const body = await request.json().catch(() => ({})) as JsonBody;
  const payload = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : null;
  if (!payload) return json({ error: "Invalid payload" }, 400);
  const entries = Object.entries(payload).filter(([key]) => key && key.length <= 100).slice(0, 100);
  await ensureTable(env.DB);
  if (entries.length) {
    await env.DB.batch(entries.map(([key, value]) => env.DB!.prepare(
      `INSERT INTO user_store (owner, key, value, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(owner, key, value == null ? "" : String(value))));
  }
  return json({ d1Available: true, authenticated: true, updated: entries.length });
}

async function handleDelete(request: Request, env: Env, owner: string): Promise<Response> {
  if (!hasD1(env)) return json({ d1Available: false, authenticated: true }, 503);
  const body = await request.json().catch(() => ({})) as JsonBody;
  const keys = Array.isArray(body.keys)
    ? body.keys.filter((key): key is string => typeof key === "string" && key.length > 0 && key.length <= 100).slice(0, 100)
    : [];
  await ensureTable(env.DB);
  if (keys.length) {
    await env.DB.batch(keys.map((key) => env.DB!.prepare(
      "DELETE FROM user_store WHERE owner = ? AND key = ?"
    ).bind(owner, key)));
  }
  return json({ d1Available: true, authenticated: true, deleted: keys.length });
}

export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  const owner = getOwner(request, env);
  if (!owner) return json({ authenticated: false, error: "Cloudflare Access sign-in required" }, 401);
  if (request.method === "GET") return handleGet(request, env, owner);
  if (request.method === "POST") return handlePost(request, env, owner);
  if (request.method === "DELETE") return handleDelete(request, env, owner);
  return json({ error: "Method not allowed" }, 405);
}
