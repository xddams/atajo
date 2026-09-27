import type { Env } from "../lib/types";
import { dueReminders, fireReminderAtomically } from "../db/queries";

/** Cron: fire due reminders into the user's HOME chat as assistant messages. */
export async function fireDueReminders(env: Env): Promise<number> {
  const due = await dueReminders(env.DB);
  let n = 0;
  for (const r of due) {
    const fired = await fireReminderAtomically(env.DB, r);
    if (fired) n++;
  }
  return n;
}

/**
 * Radar-lite (MAPA §8 item 6): only speak when there is something to say.
 * Returns null → stay silent (NO_REPLY equivalent).
 */
export async function radarLiteDigest(
  env: Env,
  userId: string,
): Promise<string | null> {
  const { results: pending } = await env.DB.prepare(
    `SELECT COUNT(*) as c FROM pending_actions WHERE user_id = ? AND status = 'pending'`,
  )
    .bind(userId)
    .all<{ c: number }>();

  const { results: upcoming } = await env.DB.prepare(
    `SELECT body, fire_at FROM reminders
     WHERE user_id = ? AND status = 'scheduled'
       AND fire_at <= datetime('now', '+2 hours')
     ORDER BY fire_at ASC LIMIT 3`,
  )
    .bind(userId)
    .all<{ body: string; fire_at: string }>();

  const pendingCount = Number(pending?.[0]?.c ?? 0);
  const soon = upcoming ?? [];

  if (pendingCount === 0 && soon.length === 0) return null;

  const parts: string[] = ["Morning check —"];
  if (soon.length) {
    parts.push(
      `upcoming: ${soon.map((r) => `“${r.body}” @ ${r.fire_at}`).join("; ")}.`,
    );
  }
  if (pendingCount) {
    parts.push(`${pendingCount} action(s) waiting for your confirmation.`);
  }
  return parts.join(" ");
}
