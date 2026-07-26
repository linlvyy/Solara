import { getSessionUser } from "./lib/auth";

const PUBLIC_PATH_PATTERNS = [
  /^\/login(?:\.html)?(?:\/|$)/,
  /^\/api\/(?:login|register)(?:\/|$)/,
  /^\/api\/me(?:\/|$)/,
];

const PUBLIC_FILE_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".png",
  ".svg",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
  ".map",
  ".json",
  ".woff",
  ".woff2",
  ".webmanifest",
]);

function hasPublicExtension(pathname: string): boolean {
  const lastDotIndex = pathname.lastIndexOf(".");
  if (lastDotIndex === -1) return false;
  return PUBLIC_FILE_EXTENSIONS.has(pathname.slice(lastDotIndex).toLowerCase());
}

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PATTERNS.some((pattern) => pattern.test(pathname)) || hasPublicExtension(pathname);
}

async function authMiddleware(context: any) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (isPublicPath(pathname)) return context.next();
  if (!env.DB) {
    if (pathname.startsWith("/api/") || pathname === "/proxy") {
      return new Response(JSON.stringify({ error: "账号数据库尚未配置" }), {
        status: 503,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return Response.redirect(new URL("/login", url).toString(), 302);
  }

  const user = await getSessionUser(request, env.DB);
  if (user) {
    context.data.user = user;
    return context.next();
  }

  if (pathname.startsWith("/api/") || pathname === "/proxy") {
    return new Response(JSON.stringify({ authenticated: false, error: "请先登录" }), {
      status: 401,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const loginUrl = new URL("/login", url);
  if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${url.search}`);
  return Response.redirect(loginUrl.toString(), 302);
}

async function i18nMiddleware(context: any) {
  const { env, next } = context;
  const response = await next();
  const language = env.language || env.LANGUAGE;

  if (language === "ENG" && response.headers.get("content-type")?.includes("text/html")) {
    return new HTMLRewriter().on("head", {
      element(element: any) {
        element.prepend(`<script>window.SITE_LANGUAGE = "ENG";</script>`, { html: true });
      },
    }).transform(response);
  }

  return response;
}

export const onRequest = [authMiddleware, i18nMiddleware];
