import { getSessionUser } from "../lib/auth";

type Env = {
  DB?: D1Database;
};

export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const user = env.DB ? await getSessionUser(request, env.DB) : null;
  return new Response(JSON.stringify({
    authenticated: Boolean(user),
    user,
    username: user?.username || null,
    displayName: user?.displayName || null,
    authProvider: user ? "solara-account" : null,
  }), {
    status: user ? 200 : 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
