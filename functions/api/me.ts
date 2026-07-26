type Env = {
  ALLOW_LOCAL_GUEST?: string;
};

export async function onRequest({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const email = request.headers.get("cf-access-authenticated-user-email")
    || (env.ALLOW_LOCAL_GUEST === "true" ? "local-preview@solara.invalid" : "");

  return new Response(JSON.stringify({
    authenticated: Boolean(email),
    email: email || null,
    authProvider: request.headers.has("cf-access-authenticated-user-email")
      ? "cloudflare-access"
      : email
        ? "local-preview"
        : null,
  }), {
    status: email ? 200 : 401,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
