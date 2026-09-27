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

export function setSessionCookie(c: AppContext, sessionId: string): void {
  const ttlDays = Number(c.env.SESSION_TTL_DAYS || "30");
  const secure = new URL(c.req.url).protocol === "https:";
  setCookie(c, COOKIE, sessionId, {
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
  const sid = getCookie(c, COOKIE);
  if (!sid) return c.json({ error: "Unauthorized" }, 401);
  const user = await getSessionUser(c.env.DB, sid);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  await next();
}

export async function logout(env: Env, c: AppContext): Promise<void> {
  const sid = getCookie(c, COOKIE);
  if (sid) await deleteSession(env.DB, sid);
  clearSessionCookie(c);
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export { COOKIE, nowIso };
