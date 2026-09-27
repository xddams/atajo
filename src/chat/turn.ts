import type { Env } from "../lib/types";
import { insertMessage, listMessages, memorySnapshot } from "../db/queries";
import { buildSystemPrompt } from "./system-prompt";
import { runTool, toolsForAi } from "../tools/registry";

export interface TurnEvent {
  type: "progress" | "final" | "error" | "tool";
  text?: string;
  tool?: string;
  pendingActionId?: string;
}

export interface TurnResult {
  reply: string;
  events: TurnEvent[];
  usedTools: string[];
}

type AiMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: ToolCall[];
};

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type AiChatResponse = {
  response?: string;
  tool_calls?: ToolCall[];
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
};

function extractAssistant(res: AiChatResponse): {
  content: string;
  toolCalls: ToolCall[];
} {
  const choice = res.choices?.[0]?.message;
  if (choice) {
    return {
      content: (choice.content ?? "").toString(),
      toolCalls: choice.tool_calls ?? [],
    };
  }
  return {
    content: (res.response ?? "").toString(),
    toolCalls: res.tool_calls ?? [],
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Heuristic fallback when Workers AI is unavailable or returns no tool calls. */
async function heuristicTurn(
  env: Env,
  userId: string,
  text: string,
  events: TurnEvent[],
): Promise<TurnResult | null> {
  const lower = text.toLowerCase();
  const remind =
    /\b(remind|reminder|acord[ae]|lembra|avis[ae]|record[aá])\b/i.test(text);
  const minutesMatch = text.match(/(\d+)\s*(min|minute|minutes|minuto|minutos)/i);
  if (remind) {
    events.push({ type: "progress", text: "Setting reminder…" });
    const mins = minutesMatch ? Number(minutesMatch[1]) : 1;
    const body =
      text
        .replace(/remind me( to| about)?/i, "")
        .replace(/lembr[ae]( de)?/i, "")
        .replace(/avis[ae]( me)?/i, "")
        .replace(/in \d+\s*min(ute)?s?/i, "")
        .replace(/em \d+\s*minutos?/i, "")
        .trim() || text;
    const result = await runTool(
      "reminder_create",
      { body, in_minutes: mins },
      { env, userId, now: () => new Date() },
    );
    const fireAt =
      result.ok && result.data && typeof result.data === "object"
        ? (result.data as { fire_at?: string }).fire_at
        : undefined;
    const reply = fireAt
      ? `Got it — I'll remind you in about ${mins} minute(s): “${body}”. Scheduled for ${fireAt}.`
      : `I tried to set that reminder but hit a snag: ${result.error ?? "unknown"}`;
    return { reply, events, usedTools: ["reminder_create"] };
  }

  if (/\b(remember|lembra|guarde|anota)\b/i.test(lower) && text.length > 12) {
    events.push({ type: "progress", text: "Saving memory…" });
    await runTool(
      "memory_write",
      { shelf_key: "MEMORY", content: `- ${text}`, mode: "append" },
      { env, userId, now: () => new Date() },
    );
    return {
      reply: "Noted — I saved that to your long-term memory.",
      events,
      usedTools: ["memory_write"],
    };
  }

  // External / connector intents → confirm gate (never claim sent)
  const wantsWhatsapp = /\bwhatsapp\b|\bwpp\b|\bzap\b/i.test(text);
  const wantsSend =
    /\b(send|enviar|manda|mande|email|e-mail|message|mensagem)\b/i.test(text);
  if (wantsWhatsapp || wantsSend) {
    const tool = wantsWhatsapp ? "whatsapp" : "request_external_action";
    events.push({ type: "progress", text: "Drafting for confirmation…" });
    const result = await runTool(
      tool,
      wantsWhatsapp
        ? { action: "send", target: "unknown", body: text }
        : {
            channel: "message",
            summary: text.slice(0, 160),
            draft: text,
          },
      { env, userId, now: () => new Date() },
    );
    const reply = wantsWhatsapp
      ? "WhatsApp isn’t connected yet. I queued a draft for your confirmation — nothing was sent."
      : "I drafted that external action and need your confirmation before doing anything.";
    if (result.pendingActionId) {
      events.push({
        type: "progress",
        text: "Waiting for confirmation…",
        pendingActionId: result.pendingActionId,
      });
    }
    return { reply, events, usedTools: [tool] };
  }

  return null;
}

export async function runChatTurn(
  env: Env,
  userId: string,
  userText: string,
): Promise<TurnResult> {
  const events: TurnEvent[] = [];
  const usedTools: string[] = [];

  await insertMessage(env.DB, userId, "user", userText);

  const memory = await memorySnapshot(env.DB, userId);
  const history = await listMessages(env.DB, userId, 40);
  const system = buildSystemPrompt(memory, env.APP_NAME || "Atajo");

  const messages: AiMessage[] = [
    { role: "system", content: system },
    ...history
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-20)
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
  ];

  const model = env.AI_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const maxLoops = 4;

  try {
    for (let i = 0; i < maxLoops; i++) {
      const raw = (await env.AI.run(model as Parameters<Ai["run"]>[0], {
        messages,
        tools: toolsForAi(),
        max_tokens: 1024,
      } as Record<string, unknown>)) as AiChatResponse;

      const { content, toolCalls } = extractAssistant(raw);

      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: content || "",
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          const name = call.function.name;
          const args = parseArgs(call.function.arguments);
          events.push({ type: "progress", text: `Running ${name}…`, tool: name });
          events.push({ type: "tool", tool: name });
          usedTools.push(name);

          const result = await runTool(name, args, {
            env,
            userId,
            now: () => new Date(),
          });
          events.push({
            type: "progress",
            text: result.progressLabel,
            tool: name,
            pendingActionId: result.pendingActionId,
          });

          await insertMessage(env.DB, userId, "progress", result.progressLabel, {
            tool: name,
            result,
          });

          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: JSON.stringify(result),
          });
        }
        continue;
      }

      const reply =
        content.trim() ||
        "I'm here — tell me what you need (reminders, memory, or a draft to confirm).";
      await insertMessage(env.DB, userId, "assistant", reply);
      events.push({ type: "final", text: reply });
      return { reply, events, usedTools };
    }

    const fallback =
      "I hit the tool-loop limit. Try a shorter request, or ask me to set a reminder.";
    await insertMessage(env.DB, userId, "assistant", fallback);
    events.push({ type: "final", text: fallback });
    return { reply: fallback, events, usedTools };
  } catch (err) {
    // Local/dev without AI binding, or model error — heuristic path.
    // Skip heuristics if any tool already ran to avoid duplicating side effects.
    if (usedTools.length === 0) {
      const heur = await heuristicTurn(env, userId, userText, events);
      if (heur) {
        await insertMessage(env.DB, userId, "assistant", heur.reply);
        events.push({ type: "final", text: heur.reply });
        return heur;
      }
    }
    const msg =
      err instanceof Error
        ? usedTools.length > 0
          ? `I ran ${usedTools.join(", ")} but the model loop failed (${err.message}). Check your chat for results — I did not retry those tools.`
          : `AI unavailable (${err.message}). You can still set reminders like “remind me in 1 minute to stretch”.`
        : "AI unavailable.";
    await insertMessage(env.DB, userId, "assistant", msg);
    events.push({ type: "error", text: msg });
    events.push({ type: "final", text: msg });
    return { reply: msg, events, usedTools };
  }
}
