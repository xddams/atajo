import type { Env, MessageRole, PendingActionRow, ReminderRow, UserRow } from "../lib/types";
import { nowIso, todayKey, toSqliteUtc, uuid } from "../lib/util";

export async function createUser(
  db: D1Database,
  email: string,
  passwordHash: string,
  displayName?: string,
): Promise<UserRow> {
  const id = uuid();
  const created = nowIso();
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, email.toLowerCase(), displayName ?? null, passwordHash, created, created)
    .run();

  // Seed memory shelves
  const shelves = [
    ["USER", `# About you\n\n(Empty — tell Atajo what to remember.)\n`],
    ["PERSONA", `# How Atajo should sound\n\nWarm, concise, action-oriented. Match the user's language.\n`],
    ["MEMORY", `# Long-term notes\n\n`],
    [todayKey(), `# ${todayKey()}\n\n`],
  ] as const;
  for (const [key, content] of shelves) {
    await db
      .prepare(
        `INSERT INTO memory_shelves (user_id, shelf_key, content, updated_at) VALUES (?, ?, ?, ?)`,
      )
      .bind(id, key, content, created)
      .run();
  }

  return {
    id,
    email: email.toLowerCase(),
    display_name: displayName ?? null,
    password_hash: passwordHash,
    created_at: created,
    updated_at: created,
  };
}

export async function findUserByEmail(
  db: D1Database,
  email: string,
): Promise<UserRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM users WHERE email = ?`)
      .bind(email.toLowerCase())
      .first<UserRow>()) ?? null
  );
}

export async function findUserById(
  db: D1Database,
  id: string,
): Promise<UserRow | null> {
  return (
    (await db.prepare(`SELECT * FROM users WHERE id = ?`).bind(id).first<UserRow>()) ??
    null
  );
}

export async function createSession(
  db: D1Database,
  userId: string,
  expiresAt: string,
): Promise<string> {
  const id = uuid();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
    )
    .bind(id, userId, expiresAt, toSqliteUtc(new Date()))
    .run();
  return id;
}

export async function getSessionUser(
  db: D1Database,
  sessionId: string,
): Promise<UserRow | null> {
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(sessionId)
    .first<UserRow>();
  return row ?? null;
}

export async function deleteSession(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

export async function listMessages(
  db: D1Database,
  userId: string,
  limit = 80,
): Promise<
  Array<{
    id: string;
    role: MessageRole;
    content: string;
    meta_json: string | null;
    created_at: string;
  }>
> {
  const { results } = await db
    .prepare(
      `SELECT id, role, content, meta_json, created_at FROM messages
       WHERE user_id = ? AND role != 'system'
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .bind(userId, limit)
    .all<{
      id: string;
      role: MessageRole;
      content: string;
      meta_json: string | null;
      created_at: string;
    }>();
  return results ?? [];
}

export async function insertMessage(
  db: D1Database,
  userId: string,
  role: MessageRole,
  content: string,
  meta?: unknown,
): Promise<string> {
  const id = uuid();
  await db
    .prepare(
      `INSERT INTO messages (id, user_id, role, content, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, userId, role, content, meta ? JSON.stringify(meta) : null, nowIso())
    .run();
  return id;
}

export async function getShelf(
  db: D1Database,
  userId: string,
  shelfKey: string,
): Promise<string> {
  const row = await db
    .prepare(
      `SELECT content FROM memory_shelves WHERE user_id = ? AND shelf_key = ?`,
    )
    .bind(userId, shelfKey)
    .first<{ content: string }>();
  return row?.content ?? "";
}

export async function setShelf(
  db: D1Database,
  userId: string,
  shelfKey: string,
  content: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO memory_shelves (user_id, shelf_key, content, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, shelf_key) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, shelfKey, content, nowIso())
    .run();
}

export async function listShelves(
  db: D1Database,
  userId: string,
): Promise<Array<{ shelf_key: string; content: string; updated_at: string }>> {
  const { results } = await db
    .prepare(
      `SELECT shelf_key, content, updated_at FROM memory_shelves
       WHERE user_id = ? ORDER BY shelf_key ASC`,
    )
    .bind(userId)
    .all<{ shelf_key: string; content: string; updated_at: string }>();
  return results ?? [];
}

export async function createReminder(
  db: D1Database,
  userId: string,
  body: string,
  fireAt: string,
): Promise<ReminderRow> {
  const id = uuid();
  const created = nowIso();
  await db
    .prepare(
      `INSERT INTO reminders (id, user_id, body, fire_at, status, created_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?)`,
    )
    .bind(id, userId, body, fireAt, created)
    .run();
  return {
    id,
    user_id: userId,
    body,
    fire_at: fireAt,
    status: "scheduled",
    created_at: created,
    fired_at: null,
  };
}

export async function listReminders(
  db: D1Database,
  userId: string,
): Promise<ReminderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM reminders WHERE user_id = ? ORDER BY fire_at ASC LIMIT 50`,
    )
    .bind(userId)
    .all<ReminderRow>();
  return results ?? [];
}

export async function updateReminderStatus(
  db: D1Database,
  id: string,
  status: ReminderRow["status"],
  firedAt?: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE reminders SET status = ?, fired_at = COALESCE(?, fired_at) WHERE id = ?`,
    )
    .bind(status, firedAt ?? null, id)
    .run();
}

export async function dueReminders(db: D1Database): Promise<ReminderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM reminders
       WHERE status = 'scheduled' AND fire_at <= datetime('now')
       ORDER BY fire_at ASC
       LIMIT 100`,
    )
    .all<ReminderRow>();
  return results ?? [];
}

export async function createPendingAction(
  db: D1Database,
  userId: string,
  toolName: string,
  summary: string,
  payload: unknown,
): Promise<PendingActionRow> {
  const id = uuid();
  const created = nowIso();
  await db
    .prepare(
      `INSERT INTO pending_actions
         (id, user_id, tool_name, summary, payload_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(id, userId, toolName, summary, JSON.stringify(payload), created)
    .run();
  return {
    id,
    user_id: userId,
    tool_name: toolName,
    summary,
    payload_json: JSON.stringify(payload),
    status: "pending",
    created_at: created,
    resolved_at: null,
  };
}

export async function listPendingActions(
  db: D1Database,
  userId: string,
): Promise<PendingActionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM pending_actions
       WHERE user_id = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(userId)
    .all<PendingActionRow>();
  return results ?? [];
}

export async function resolvePendingAction(
  db: D1Database,
  userId: string,
  id: string,
  status: "approved" | "rejected" | "executed",
): Promise<PendingActionRow | null> {
  const row = await db
    .prepare(`SELECT * FROM pending_actions WHERE id = ? AND user_id = ?`)
    .bind(id, userId)
    .first<PendingActionRow>();
  if (!row) return null;
  await db
    .prepare(
      `UPDATE pending_actions SET status = ?, resolved_at = ? WHERE id = ?`,
    )
    .bind(status, nowIso(), id)
    .run();
  return { ...row, status, resolved_at: nowIso() };
}

export async function memorySnapshot(
  db: D1Database,
  userId: string,
): Promise<string> {
  const user = await getShelf(db, userId, "USER");
  const persona = await getShelf(db, userId, "PERSONA");
  const memory = await getShelf(db, userId, "MEMORY");
  const daily = await getShelf(db, userId, todayKey());
  return [
    "=== USER ===",
    user.slice(0, 2000),
    "=== PERSONA ===",
    persona.slice(0, 1500),
    "=== MEMORY ===",
    memory.slice(0, 2000),
    `=== DAILY ${todayKey()} ===`,
    daily.slice(0, 1500),
  ].join("\n");
}

export type { Env };
