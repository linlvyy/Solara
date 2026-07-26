import {
  attemptKey,
  createPasswordRecord,
  createSession,
  ensureAuthTables,
  isLoginBlocked,
  isSameOriginRequest,
  normalizeUsername,
  recordLoginFailure,
  sessionCookie,
  validateCredentials,
} from "../lib/auth";

type Env = {
  DB?: D1Database;
};

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
}

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!isSameOriginRequest(request)) return json({ error: "请求来源无效" }, 403);
  if (!env.DB) return json({ error: "账号数据库尚未配置" }, 503);

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const username = normalizeUsername(body.username);
  const password = typeof body.password === "string" ? body.password : "";
  const validationError = validateCredentials(username, password);
  if (validationError) return json({ error: validationError }, 400);

  await ensureAuthTables(env.DB);
  const registrationKey = await attemptKey(request, "__registration__");
  if (await isLoginBlocked(env.DB, registrationKey)) {
    return json({ error: "该网络注册过于频繁，请稍后再试" }, 429);
  }
  const existing = await env.DB.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first();
  if (existing) return json({ error: "该用户名已被注册" }, 409);

  const id = crypto.randomUUID();
  const passwordRecord = await createPasswordRecord(password);
  try {
    await env.DB.prepare(
      `INSERT INTO users
       (id, username, display_name, password_hash, password_salt, password_iterations)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      username,
      username,
      passwordRecord.hash,
      passwordRecord.salt,
      passwordRecord.iterations,
    ).run();
  } catch {
    return json({ error: "该用户名已被注册" }, 409);
  }

  const token = await createSession(env.DB, id);
  await recordLoginFailure(env.DB, registrationKey);
  return json({
    authenticated: true,
    user: { id, username, displayName: username },
  }, 201, { "Set-Cookie": sessionCookie(token, request) });
}
