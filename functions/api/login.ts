import {
  attemptKey,
  clearLoginFailures,
  createSession,
  ensureAuthTables,
  isLoginBlocked,
  isSameOriginRequest,
  normalizeUsername,
  recordLoginFailure,
  sessionCookie,
  validateCredentials,
  verifyPassword,
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
  if (validationError) return json({ error: "用户名或密码错误" }, 401);

  try {
    await ensureAuthTables(env.DB);
  } catch (error) {
    console.error("Failed to initialize auth tables", error);
    return json({ error: "账号数据库初始化失败，请稍后再试" }, 500);
  }
  const limiterKey = await attemptKey(request, username);
  if (await isLoginBlocked(env.DB, limiterKey)) {
    return json({ error: "尝试次数过多，请 10 分钟后再试" }, 429);
  }

  const user = await env.DB.prepare(
    `SELECT id, username, display_name AS displayName, password_hash AS passwordHash,
            password_salt AS passwordSalt, password_iterations AS passwordIterations
     FROM users WHERE username = ?`,
  ).bind(username).first<{
    id: string;
    username: string;
    displayName: string;
    passwordHash: string;
    passwordSalt: string;
    passwordIterations: number;
  }>();

  const validPassword = await verifyPassword(
    password,
    user?.passwordHash || "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    user?.passwordSalt || "AAAAAAAAAAAAAAAAAAAAAA",
    user?.passwordIterations || 210_000,
  );
  if (!user || !validPassword) {
    await recordLoginFailure(env.DB, limiterKey);
    return json({ error: "用户名或密码错误" }, 401);
  }

  await clearLoginFailures(env.DB, limiterKey);
  const token = await createSession(env.DB, user.id);
  return json({
    authenticated: true,
    user: { id: user.id, username: user.username, displayName: user.displayName },
  }, 200, { "Set-Cookie": sessionCookie(token, request) });
}
