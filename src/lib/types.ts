/** Shared Env / types. Prefer regenerating via `wrangler types` after deploy. */

export interface Env {
  DB: D1Database;
  AI: Ai;
  ASSETS: Fetcher;
  APP_NAME: string;
  SESSION_TTL_DAYS: string;
  AI_MODEL: string;
  /**
   * AI Gateway id for Workers AI / third-party models (Unified Billing credits).
   * Defaults to `default` when unset.
   */
  AI_GATEWAY_ID?: string;
  /**
   * HMAC secret for signing session cookies. When set, cookies are
   * `sessionId.signature` and must validate before D1 lookup.
   */
  SESSION_SECRET?: string;
  /** Comma-separated extra origins allowed for credentialed CORS (same-origin always allowed). */
  ALLOWED_ORIGINS?: string;
  /** Optional Tavily key for live web_search. */
  TAVILY_API_KEY?: string;
}

export type MessageRole = "user" | "assistant" | "system" | "tool" | "progress";

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  expires_at: string;
  created_at: string;
}

export interface MessageRow {
  id: string;
  user_id: string;
  role: MessageRole;
  content: string;
  meta_json: string | null;
  created_at: string;
}

export interface ReminderRow {
  id: string;
  user_id: string;
  body: string;
  fire_at: string;
  status: "scheduled" | "fired" | "cancelled";
  created_at: string;
  fired_at: string | null;
}

export interface PendingActionRow {
  id: string;
  user_id: string;
  tool_name: string;
  summary: string;
  payload_json: string;
  status: "pending" | "approved" | "rejected" | "executed";
  created_at: string;
  resolved_at: string | null;
}

export type ShelfKey = "USER" | "PERSONA" | "MEMORY" | string;

export interface ToolResult {
  ok: boolean;
  status?: string;
  progressLabel?: string;
  data?: unknown;
  error?: string;
  /** When true, UI should show a confirm card (action not executed). */
  needsConfirmation?: boolean;
  pendingActionId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  progressLabel: string;
  confirmGated?: boolean;
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>;
}

export interface ToolContext {
  env: Env;
  userId: string;
  now: () => Date;
}
