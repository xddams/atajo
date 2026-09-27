import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./lib/types";
import type { AppVariables } from "./auth/session";
import {
  AuthError,
  clearSessionCookie,
  login,
  logout,
  register,
  requireUser,
  setSessionCookie,
} from "./auth/session";
import {
  listMessages,
  listPendingActions,
  listReminders,
  listShelves,
  resolvePendingAction,
  insertMessage,
} from "./db/queries";
import { runChatTurn } from "./chat/turn";
import { connectorCatalog } from "./tools/registry";
import { fireDueReminders, radarLiteDigest } from "./reminders/cron";
import { nowIso } from "./lib/util";

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("/api/*", cors({ origin: (o) => o || "*", credentials: true }));

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    app: c.env.APP_NAME || "Atajo",
    time: nowIso(),
    checklist: [
      "chat_thread",
      "auth_session",
      "http_gateway",
      "ws_progress",
      "scheduled_reminders",
      "connectors_stub",
      "radar_lite",
    ],
  }),
);

app.post("/api/auth/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    display_name?: string;
  };
  if (!body.email || !body.password) {
    return c.json({ error: "email and password required" }, 400);
  }
  try {
    const { user, sessionId } = await register(
      c.env,
      body.email,
      body.password,
      body.display_name,
    );
    setSessionCookie(c, sessionId);
    return c.json({
      user: { id: user.id, email: user.email, display_name: user.display_name },
    });
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.post("/api/auth/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  if (!body.email || !body.password) {
    return c.json({ error: "email and password required" }, 400);
  }
  try {
    const { user, sessionId } = await login(c.env, body.email, body.password);
    setSessionCookie(c, sessionId);
    return c.json({
      user: { id: user.id, email: user.email, display_name: user.display_name },
    });
  } catch (e) {
    if (e instanceof AuthError) return c.json({ error: e.message }, 401);
    throw e;
  }
});

app.post("/api/auth/logout", async (c) => {
  await logout(c.env, c);
  return c.json({ ok: true });
});

app.get("/api/me", requireUser, (c) => {
  const u = c.get("user");
  return c.json({
    user: { id: u.id, email: u.email, display_name: u.display_name },
  });
});

app.get("/api/messages", requireUser, async (c) => {
  const rows = await listMessages(c.env.DB, c.get("user").id, 100);
  return c.json({
    messages: rows.filter((m) => m.role === "user" || m.role === "assistant"),
  });
});

app.post("/api/chat", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string };
  const text = (body.text || "").trim();
  if (!text) return c.json({ error: "text required" }, 400);
  const result = await runChatTurn(c.env, c.get("user").id, text);
  return c.json(result);
});

/** WebSocket progress channel for a single chat turn (MAPA §8 gateway/WS). */
app.get("/api/chat/ws", requireUser, async (c) => {
  const upgrade = c.req.header("Upgrade");
  if (upgrade !== "websocket") {
    return c.text("Expected WebSocket", 426);
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  const userId = c.get("user").id;
  const env = c.env;

  server.addEventListener("message", async (evt) => {
    try {
      const data = JSON.parse(String(evt.data)) as { type?: string; text?: string };
      if (data.type !== "chat" || !data.text?.trim()) {
        server.send(JSON.stringify({ type: "error", text: "Send {type:'chat', text}" }));
        return;
      }
      server.send(JSON.stringify({ type: "ack" }));
      const result = await runChatTurn(env, userId, data.text.trim());
      for (const ev of result.events) {
        server.send(JSON.stringify(ev));
      }
      server.send(JSON.stringify({ type: "done", reply: result.reply }));
    } catch (err) {
      server.send(
        JSON.stringify({
          type: "error",
          text: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  });

  return new Response(null, { status: 101, webSocket: client });
});

app.get("/api/memory", requireUser, async (c) => {
  const shelves = await listShelves(c.env.DB, c.get("user").id);
  return c.json({ shelves });
});

app.get("/api/reminders", requireUser, async (c) => {
  const reminders = await listReminders(c.env.DB, c.get("user").id);
  return c.json({ reminders });
});

app.get("/api/pending", requireUser, async (c) => {
  const pending = await listPendingActions(c.env.DB, c.get("user").id);
  return c.json({ pending });
});

app.post("/api/pending/:id/resolve", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    decision?: "approve" | "reject";
  };
  const decision = body.decision;
  if (decision !== "approve" && decision !== "reject") {
    return c.json({ error: "decision must be approve|reject" }, 400);
  }
  const actionId = c.req.param("id");
  if (!actionId) return c.json({ error: "missing id" }, 400);
  const status = decision === "approve" ? "approved" : "rejected";
  const row = await resolvePendingAction(
    c.env.DB,
    c.get("user").id,
    actionId,
    status,
  );
  if (!row) return c.json({ error: "not found" }, 404);

  // MVP: approval marks executed for stubs without calling external APIs.
  if (status === "approved") {
    await resolvePendingAction(
      c.env.DB,
      c.get("user").id,
      actionId,
      "executed",
    );
    await insertMessage(
      c.env.DB,
      c.get("user").id,
      "assistant",
      `Confirmed: “${row.summary}”. (Connector still stubbed — nothing was sent externally.)`,
      { pending_action_id: row.id, decision: "approved_stub" },
    );
  } else {
    await insertMessage(
      c.env.DB,
      c.get("user").id,
      "assistant",
      `Cancelled: “${row.summary}”.`,
      { pending_action_id: row.id, decision: "rejected" },
    );
  }
  return c.json({ ok: true, status: status === "approved" ? "executed" : "rejected" });
});

app.get("/api/connectors", requireUser, (c) => c.json({ connectors: connectorCatalog() }));

app.get("/api/radar/lite", requireUser, async (c) => {
  const digest = await radarLiteDigest(c.env, c.get("user").id);
  return c.json({
    speak: digest !== null,
    digest,
    note: "Radar-lite stays silent when there is nothing useful to say.",
  });
});

app.all("*", async (c) => {
  if (c.env.ASSETS) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.text("Atajo API — open / for the chat UI", 404);
});

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      fireDueReminders(env).then((n) => {
        console.log(`atajo cron: fired ${n} reminder(s)`);
      }),
    );
  },
};
