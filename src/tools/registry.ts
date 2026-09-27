import type { ToolContext, ToolDefinition, ToolResult } from "../lib/types";
import {
  createPendingAction,
  createReminder,
  getShelf,
  listPendingActions,
  listReminders,
  setShelf,
} from "../db/queries";
import { addMinutes, nowIso, toSqliteUtc, todayKey, uuid } from "../lib/util";

function notConnected(service: string): ToolResult {
  return {
    ok: false,
    status: "not_connected",
    data: {
      status: "not_connected",
      service,
      hint: `Connect ${service} later — for now tell the user it's not linked and offer a draft or alternative.`,
    },
  };
}

function parseFireAt(args: Record<string, unknown>, now: Date): string {
  if (typeof args.fire_at === "string" && args.fire_at) {
    const d = new Date(args.fire_at);
    if (!Number.isNaN(d.getTime())) return toSqliteUtc(d);
  }
  const minutes = Number(args.in_minutes ?? args.delay_minutes ?? 1);
  return toSqliteUtc(addMinutes(Number.isFinite(minutes) ? minutes : 1, now));
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "memory_read",
    description:
      "Read a memory shelf. Keys: USER, PERSONA, MEMORY, or YYYY-MM-DD daily notes.",
    parameters: {
      type: "object",
      properties: {
        shelf_key: { type: "string", description: "USER | PERSONA | MEMORY | YYYY-MM-DD" },
      },
      required: ["shelf_key"],
    },
    progressLabel: "Reading memory…",
    async execute(args, ctx) {
      const key = String(args.shelf_key || "USER");
      const content = await getShelf(ctx.env.DB, ctx.userId, key);
      return { ok: true, data: { shelf_key: key, content } };
    },
  },
  {
    name: "memory_write",
    description:
      "Write or append to a memory shelf. Prefer append for MEMORY and daily notes.",
    parameters: {
      type: "object",
      properties: {
        shelf_key: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["replace", "append"] },
      },
      required: ["shelf_key", "content"],
    },
    progressLabel: "Saving memory…",
    async execute(args, ctx) {
      const key = String(args.shelf_key || todayKey());
      const mode = String(args.mode || "append");
      const incoming = String(args.content || "");
      const existing = await getShelf(ctx.env.DB, ctx.userId, key);
      const next =
        mode === "replace"
          ? incoming
          : existing
            ? `${existing.trimEnd()}\n${incoming}`
            : incoming;
      await setShelf(ctx.env.DB, ctx.userId, key, next);
      return { ok: true, data: { shelf_key: key, bytes: next.length } };
    },
  },
  {
    name: "reminder_create",
    description:
      "Schedule a reminder. Pass fire_at (ISO) or in_minutes (default 1).",
    parameters: {
      type: "object",
      properties: {
        body: { type: "string" },
        fire_at: { type: "string" },
        in_minutes: { type: "number" },
      },
      required: ["body"],
    },
    progressLabel: "Setting reminder…",
    async execute(args, ctx) {
      const body = String(args.body || "").trim();
      if (!body) return { ok: false, error: "body required" };
      const fireAt = parseFireAt(args, ctx.now());
      const row = await createReminder(ctx.env.DB, ctx.userId, body, fireAt);
      return {
        ok: true,
        data: { id: row.id, body: row.body, fire_at: row.fire_at },
      };
    },
  },
  {
    name: "reminder_list",
    description: "List the user's reminders.",
    parameters: { type: "object", properties: {} },
    progressLabel: "Checking reminders…",
    async execute(_args, ctx) {
      const rows = await listReminders(ctx.env.DB, ctx.userId);
      return { ok: true, data: { reminders: rows } };
    },
  },
  {
    name: "web_search",
    description: "Search the web for current facts (weather, prices, news).",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    progressLabel: "Searching the web…",
    async execute(args, ctx) {
      const query = String(args.query || "").trim();
      if (!query) return { ok: false, error: "query required" };
      const key = ctx.env.TAVILY_API_KEY;
      if (!key) {
        return {
          ok: true,
          status: "stub",
          data: {
            query,
            results: [],
            note: "web_search stub — set TAVILY_API_KEY secret for live results.",
          },
        };
      }
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: key,
          query,
          max_results: 5,
          search_depth: "basic",
        }),
      });
      if (!res.ok) {
        return { ok: false, error: `Tavily HTTP ${res.status}` };
      }
      const data = (await res.json()) as { results?: unknown[] };
      return { ok: true, data: { query, results: data.results ?? [] } };
    },
  },
  {
    name: "request_external_action",
    description:
      "Queue an external action (email, message, post) for user confirmation. Never claim it was sent.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string", description: "email | message | post | other" },
        summary: { type: "string" },
        draft: { type: "string" },
        recipient: { type: "string" },
      },
      required: ["summary", "draft"],
    },
    progressLabel: "Drafting for confirmation…",
    confirmGated: true,
    async execute(args, ctx) {
      const summary = String(args.summary || "External action");
      const pending = await createPendingAction(
        ctx.env.DB,
        ctx.userId,
        "request_external_action",
        summary,
        {
          channel: args.channel ?? "other",
          draft: args.draft,
          recipient: args.recipient ?? null,
          created_at: nowIso(),
        },
      );
      return {
        ok: true,
        needsConfirmation: true,
        pendingActionId: pending.id,
        data: {
          pending_action_id: pending.id,
          summary,
          status: "awaiting_confirmation",
        },
      };
    },
  },
  {
    name: "list_pending_actions",
    description: "List actions waiting for user confirmation.",
    parameters: { type: "object", properties: {} },
    progressLabel: "Checking pending actions…",
    async execute(_args, ctx) {
      const rows = await listPendingActions(ctx.env.DB, ctx.userId);
      return { ok: true, data: { pending: rows } };
    },
  },
  {
    name: "whatsapp",
    description:
      "WhatsApp connector stub. Actions: status, find_contact, send, etc. Sends are confirm-gated.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        target: { type: "string" },
        body: { type: "string" },
      },
      required: ["action"],
    },
    progressLabel: "Checking WhatsApp…",
    confirmGated: true,
    async execute(args, ctx) {
      const action = String(args.action || "status");
      if (action === "status" || action === "whoami") {
        return notConnected("whatsapp");
      }
      if (action === "send" || action === "send_media") {
        const summary = `WhatsApp ${action} → ${args.target ?? "?"} : ${String(args.body ?? "").slice(0, 120)}`;
        const pending = await createPendingAction(
          ctx.env.DB,
          ctx.userId,
          "whatsapp",
          summary,
          { ...args, stub: true },
        );
        return {
          ok: true,
          status: "not_connected",
          needsConfirmation: true,
          pendingActionId: pending.id,
          data: {
            status: "not_connected",
            service: "whatsapp",
            pending_action_id: pending.id,
            note: "WhatsApp not connected — draft queued for confirmation only.",
          },
        };
      }
      return notConnected("whatsapp");
    },
  },
  {
    name: "google",
    description:
      "Google connector stub (mail|calendar|drive|contacts). Outbound send/create is confirm-gated.",
    parameters: {
      type: "object",
      properties: {
        service: { type: "string" },
        action: { type: "string" },
        query: { type: "string" },
        draft: { type: "string" },
      },
      required: ["service", "action"],
    },
    progressLabel: "Checking Google…",
    confirmGated: true,
    async execute(args, ctx) {
      const action = String(args.action || "status");
      if (["send", "create", "share"].includes(action)) {
        const summary = `Google ${args.service}/${action}: ${String(args.draft ?? args.query ?? "").slice(0, 120)}`;
        const pending = await createPendingAction(
          ctx.env.DB,
          ctx.userId,
          "google",
          summary,
          { ...args, stub: true },
        );
        return {
          ok: true,
          status: "not_connected",
          needsConfirmation: true,
          pendingActionId: pending.id,
          data: {
            status: "not_connected",
            service: "google",
            pending_action_id: pending.id,
          },
        };
      }
      return notConnected("google");
    },
  },
  {
    name: "places",
    description: "Local places search stub (search, nearby, details, resolve).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        query: { type: "string" },
        lat: { type: "number" },
        lng: { type: "number" },
      },
      required: ["action"],
    },
    progressLabel: "Looking up places…",
    async execute() {
      return notConnected("places");
    },
  },
  {
    name: "ifood",
    description:
      "iFood ordering stub (BR). Cart/checkout are confirm-gated; never place an order.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        query: { type: "string" },
      },
      required: ["action"],
    },
    progressLabel: "Checking iFood…",
    confirmGated: true,
    async execute(args, ctx) {
      const action = String(args.action || "status");
      if (action === "cart_create" || action === "checkout_link") {
        const pending = await createPendingAction(
          ctx.env.DB,
          ctx.userId,
          "ifood",
          `iFood ${action}: ${String(args.query ?? "")}`,
          { ...args, stub: true },
        );
        return {
          ok: true,
          status: "not_connected",
          needsConfirmation: true,
          pendingActionId: pending.id,
          data: {
            status: "not_connected",
            service: "ifood",
            pending_action_id: pending.id,
          },
        };
      }
      return notConnected("ifood");
    },
  },
  {
    name: "share_file",
    description: "File share stub (create/list/get/delete). Creating a link is confirm-gated.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string" },
        path: { type: "string" },
      },
      required: ["action"],
    },
    progressLabel: "Checking file share…",
    confirmGated: true,
    async execute(args, ctx) {
      if (String(args.action) === "create") {
        const pending = await createPendingAction(
          ctx.env.DB,
          ctx.userId,
          "share_file",
          `Share link for ${args.path ?? "file"}`,
          { ...args, stub: true },
        );
        return {
          ok: true,
          status: "not_connected",
          needsConfirmation: true,
          pendingActionId: pending.id,
          data: {
            status: "not_connected",
            service: "share_file",
            pending_action_id: pending.id,
          },
        };
      }
      return notConnected("share_file");
    },
  },
];

export function toolsForAi(): Array<{
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult & { progressLabel: string }> {
  const def = TOOL_DEFINITIONS.find((t) => t.name === name);
  if (!def) {
    return {
      ok: false,
      error: `Unknown tool: ${name}`,
      progressLabel: "Unknown tool",
    };
  }
  try {
    const result = await def.execute(args ?? {}, ctx);
    return { ...result, progressLabel: def.progressLabel };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      progressLabel: def.progressLabel,
    };
  }
}

export function connectorCatalog() {
  return [
    { id: "whatsapp", name: "WhatsApp", status: "not_connected", mvp: "stub" },
    { id: "google", name: "Google (Mail / Calendar / Drive)", status: "not_connected", mvp: "stub" },
    { id: "places", name: "Places", status: "not_connected", mvp: "stub" },
    { id: "ifood", name: "iFood", status: "not_connected", mvp: "stub" },
    { id: "share_file", name: "File share", status: "not_connected", mvp: "stub" },
  ];
}

export { uuid };
