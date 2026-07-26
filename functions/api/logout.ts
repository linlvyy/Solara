import {
  deleteCurrentSession,
  ensureAuthTables,
  expiredSessionCookie,
  isSameOriginRequest,
} from "../lib/auth";

type Env = {
  DB?: D1Database;
};

export async function onRequestPost({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return new Response(JSON.stringify({ error: "请求来源无效" }), {
      status: 403,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  if (env.DB) {
    await ensureAuthTables(env.DB);
    await deleteCurrentSession(request, env.DB);
  }
  return new Response(JSON.stringify({ authenticated: false }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": expiredSessionCookie(request),
    },
  });
}
