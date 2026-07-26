export type AuthEnv = {
  DB?: D1Database;
};

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
};

export const SESSION_COOKIE = "solara_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
export const PASSWORD_ITERATIONS = 210_000;

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

export function normalizeUsername(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function validateCredentials(username: string, password: string): string | null {
  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return "用户名需为 3–24 位小写字母、数字或下划线";
  }
  const passwordLength = Array.from(password).length;
  if (passwordLength < 10 || passwordLength > 128) {
    return "密码长度需为 10–128 个字符";
  }
  return null;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function ensureAuthTables(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        password_iterations INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS auth_attempts (
        key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL DEFAULT 0,
        blocked_until INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`,
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id)"),
    db.prepare("CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at)"),
  ]);
}

export async function createPasswordRecord(password: string): Promise<{
  hash: string;
  salt: string;
  iterations: number;
}> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePasswordHash(password, salt, PASSWORD_ITERATIONS);
  return {
    hash: bytesToBase64Url(hash),
    salt: bytesToBase64Url(salt),
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string,
  iterations: number,
): Promise<boolean> {
  try {
    const actual = await derivePasswordHash(password, base64UrlToBytes(storedSalt), iterations);
    return constantTimeEqual(actual, base64UrlToBytes(storedHash));
  } catch {
    return false;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("Cookie") || "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

export function sessionCookie(token: string, request: Request): string {
  const segments = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (new URL(request.url).protocol === "https:") segments.push("Secure");
  return segments.join("; ");
}

export function expiredSessionCookie(request: Request): string {
  const segments = [
    `${SESSION_COOKIE}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (new URL(request.url).protocol === "https:") segments.push("Secure");
  return segments.join("; ");
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const tokenHash = await sha256(token);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  await db.prepare(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
  ).bind(tokenHash, userId, expiresAt).run();
  return token;
}

export async function deleteCurrentSession(request: Request, db: D1Database): Promise<void> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return;
  await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export async function getSessionUser(request: Request, db: D1Database): Promise<SessionUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    `SELECT users.id, users.username, users.display_name AS displayName
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
  ).bind(tokenHash, now).first<SessionUser>();
  if (!row) {
    await db.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
    return null;
  }
  return row;
}

export async function attemptKey(request: Request, username: string): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  return sha256(`${ip}\n${username}`);
}

export async function isLoginBlocked(db: D1Database, key: string): Promise<boolean> {
  const row = await db.prepare(
    "SELECT failures, blocked_until, updated_at FROM auth_attempts WHERE key = ?",
  ).bind(key).first<{ failures: number; blocked_until: number; updated_at: number }>();
  if (!row) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - row.updated_at > 900) {
    await db.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key).run();
    return false;
  }
  return row.blocked_until > now;
}

export async function recordLoginFailure(db: D1Database, key: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db.prepare(
    "SELECT failures, updated_at FROM auth_attempts WHERE key = ?",
  ).bind(key).first<{ failures: number; updated_at: number }>();
  const failures = !row || now - row.updated_at > 900 ? 1 : row.failures + 1;
  const blockedUntil = failures >= 5 ? now + 600 : 0;
  await db.prepare(
    `INSERT INTO auth_attempts (key, failures, blocked_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       failures = excluded.failures,
       blocked_until = excluded.blocked_until,
       updated_at = excluded.updated_at`,
  ).bind(key, failures, blockedUntil, now).run();
}

export async function clearLoginFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM auth_attempts WHERE key = ?").bind(key).run();
}
