import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context, Next } from "hono";
import type { Env, UserRow } from "../lib/types";
import { addDays, nowIso, toSqliteUtc } from "../lib/util";
import { createSession, deleteSession, getSessionUser } from "../db/queries";
import { hashPassword, verifyPassword } from "../lib/crypto";
import { createUser, findUserByEmail } from "../db/queries";

const COOKIE = "atajo_session";

export type AppVariables = {
  user: UserRow;
};

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Cookie value: signed when SESSION_SECRET is set, else raw session UUID. */
export async function encodeSessionCookie(
  sessionId: string,
  secret?: string,
): Promise<string> {
  if (!secret) return sessionId;
  const sig = await hmacHex(secret, sessionId);
  return `${sessionId}.${sig}`;
}

/** Returns session id if cookie is valid (and signature matches when required). */
export async function decodeSessionCookie(
  cookieValue: string,
  secret?: string,
): Promise<string | null> {
  if (!secret) {
    // Unsigned mode: cookie is the session UUID alone.
    if (cookieValue.includes(".")) return null;
    return cookieValue || null;
  }
  const dot = cookieValue.lastIndexOf(".");
  if (dot <= 0) return null;
  const sessionId = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  if (!sessionId || !sig) return null;
  const expected = await hmacHex(secret, sessionId);
  if (sig.length !== expected.length) return null;
  let ok = 0;
  for (let i = 0; i < expected.length; i++) {
    ok |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return ok === 0 ? sessionId : null;
}

export async function register(
  env: Env,
  email: string,
  password: string,
  displayName?: string,
): Promise<{ user: UserRow; sessionId: string }> {
  const existing = await findUserByEmail(env.DB, email);
  if (existing) throw new AuthError("Email already registered");
  if (password.length < 8) throw new AuthError("Password must be at least 8 characters");
  const hash = await hashPassword(password);
  const user = await createUser(env.DB, email, hash, displayName);
  const ttl = Number(env.SESSION_TTL_DAYS || "30");
  const sessionId = await createSession(env.DB, user.id, toSqliteUtc(addDays(ttl)));
  return { user, sessionId };
}

export async function login(
  env: Env,
  email: string,
  password: string,
): Promise<{ user: UserRow; sessionId: string }> {
  const user = await findUserByEmail(env.DB, email);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new AuthError("Invalid email or password");
  }
  const ttl = Number(env.SESSION_TTL_DAYS || "30");
  const sessionId = await createSession(env.DB, user.id, toSqliteUtc(addDays(ttl)));
  return { user, sessionId };
}

type AppContext = Context<{ Bindings: Env; Variables: AppVariables }>;

export async function setSessionCookie(c: AppContext, sessionId: string): Promise<void> {
  const ttlDays = Number(c.env.SESSION_TTL_DAYS || "30");
  const secure = new URL(c.req.url).protocol === "https:";
  const value = await encodeSessionCookie(sessionId, c.env.SESSION_SECRET);
  setCookie(c, COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: "Lax",
    path: "/",
    maxAge: ttlDays * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: AppContext): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function requireUser(
  c: Context<{ Bindings: Env; Variables: AppVariables }>,
  next: Next,
): Promise<Response | void> {
  const raw = getCookie(c, COOKIE);
  if (!raw) return c.json({ error: "Unauthorized" }, 401);
  const sid = await decodeSessionCookie(raw, c.env.SESSION_SECRET);
  if (!sid) return c.json({ error: "Unauthorized" }, 401);
  const user = await getSessionUser(c.env.DB, sid);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
}

export async function logout(env: Env, c: AppContext): Promise<void> {
  const raw = getCookie(c, COOKIE);
  if (raw) {
    const sid = await decodeSessionCookie(raw, env.SESSION_SECRET);
    if (sid) await deleteSession(env.DB, sid);
  }
  clearSessionCookie(c);
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export { COOKIE, nowIso };
