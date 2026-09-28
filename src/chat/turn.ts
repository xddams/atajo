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
  output_text?: string;
  tool_calls?: ToolCall[];
  id?: string;
  output?: Array<Record<string, unknown>>;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
};

type AiRunOptions = {
  gateway?: { id: string };
};

function gatewayOptions(env: Env): AiRunOptions | undefined {
  const id = (env.AI_GATEWAY_ID || "default").trim();
  if (!id) return undefined;
  return { gateway: { id } };
}

function extractAssistant(res: AiChatResponse): {
  content: string;
  toolCalls: ToolCall[];
  responseId?: string;
} {
  const choice = res.choices?.[0]?.message;
  if (choice) {
    return {
      content: (choice.content ?? "").toString(),
      toolCalls: choice.tool_calls ?? [],
      responseId: res.id,
    };
  }

  // Responses API: walk output[] for message + function_call items
  if (Array.isArray(res.output)) {
    const texts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const item of res.output) {
      const type = String(item.type || "");
      if (type === "message") {
        const content = item.content;
        if (Array.isArray(content)) {
          for (const part of content) {
            if (
              part &&
              typeof part === "object" &&
              (part as { type?: string }).type === "output_text" &&
              typeof (part as { text?: string }).text === "string"
            ) {
              texts.push((part as { text: string }).text);
            }
          }
        } else if (typeof content === "string") {
          texts.push(content);
        }
      } else if (type === "function_call") {
        const name = String(item.name || "");
        const args =
          typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {});
        const id = String(item.call_id || item.id || `call_${toolCalls.length}`);
        if (name) {
          toolCalls.push({
            id,
            type: "function",
            function: { name, arguments: args },
          });
        }
      }
    }
    if (texts.length > 0 || toolCalls.length > 0) {
      return {
        content: texts.join("\n").trim(),
        toolCalls,
        responseId: res.id,
      };
    }
  }

  return {
    content: (res.output_text ?? res.response ?? "").toString(),
    toolCalls: res.tool_calls ?? [],
    responseId: res.id,
  };
}

function responsesTools(): Array<Record<string, unknown>> {
  return toolsForAi().map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

/** Build Responses API payload (primary for openai/gpt-6-luna). */
function responsesParams(
  messages: AiMessage[],
  previousResponseId?: string,
  toolOutputs?: Array<{ call_id: string; output: string }>,
): Record<string, unknown> {
  const system = messages.find((m) => m.role === "system")?.content;
  const nonSystem = messages.filter((m) => m.role !== "system");

  if (previousResponseId && toolOutputs && toolOutputs.length > 0) {
    return {
      previous_response_id: previousResponseId,
      input: toolOutputs.map((o) => ({
        type: "function_call_output",
        call_id: o.call_id,
        output: o.output,
      })),
      tools: responsesTools(),
      max_output_tokens: 1024,
      ...(system ? { instructions: system } : {}),
    };
  }

  const input = nonSystem.map((m) => {
    if (m.role === "tool") {
      return {
        type: "function_call_output",
        call_id: m.tool_call_id || "unknown",
        output: m.content,
      };
    }
    return {
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    };
  });

  return {
    ...(system ? { instructions: system } : {}),
    input,
    tools: responsesTools(),
    max_output_tokens: 1024,
  };
}

/** Chat Completions payload (Luna also supports this). */
function chatCompletionsParams(
  messages: AiMessage[],
  includeTools: boolean,
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    messages,
    max_completion_tokens: 1024,
  };
  if (includeTools) {
    params.tools = toolsForAi();
  }
  return params;
}

function workersAiParams(messages: AiMessage[]): Record<string, unknown> {
  return {
    messages,
    tools: toolsForAi(),
    max_tokens: 1024,
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isUserInputError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b7003\b/.test(msg) || /user input error/i.test(msg);
}

async function runModel(
  env: Env,
  model: string,
  messages: AiMessage[],
  previousResponseId?: string,
  toolOutputs?: Array<{ call_id: string; output: string }>,
): Promise<AiChatResponse> {
  const opts = gatewayOptions(env);
  const run = (params: Record<string, unknown>) =>
    env.AI.run(
      model as Parameters<Ai["run"]>[0],
      params,
      opts as Parameters<Ai["run"]>[2],
    ) as Promise<AiChatResponse>;

  if (!model.startsWith("openai/")) {
    return run(workersAiParams(messages));
  }

  // Prefer Responses API for Luna (documented primary path).
  try {
    return await run(responsesParams(messages, previousResponseId, toolOutputs));
  } catch (err) {
    // If we're mid tool-loop, don't silently switch formats.
    if (previousResponseId || (toolOutputs && toolOutputs.length > 0)) {
      throw err;
    }
    if (!isUserInputError(err)) throw err;
  }

  // Fallback: Chat Completions with tools, then without tools.
  try {
    return await run(chatCompletionsParams(messages, true));
  } catch (err) {
    if (!isUserInputError(err)) throw err;
    return run(chatCompletionsParams(messages, false));
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

  const model = env.AI_MODEL || "openai/gpt-6-luna";
  const maxLoops = 4;
  let previousResponseId: string | undefined;
  let pendingToolOutputs: Array<{ call_id: string; output: string }> | undefined;

  try {
    for (let i = 0; i < maxLoops; i++) {
      const raw = await runModel(
        env,
        model,
        messages,
        previousResponseId,
        pendingToolOutputs,
      );
      pendingToolOutputs = undefined;

      const { content, toolCalls, responseId } = extractAssistant(raw);
      if (responseId) previousResponseId = responseId;

      if (toolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: content || "",
          tool_calls: toolCalls,
        });

        const outputs: Array<{ call_id: string; output: string }> = [];
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

          const serialized = JSON.stringify(result);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name,
            content: serialized,
          });
          outputs.push({ call_id: call.id, output: serialized });
        }
        pendingToolOutputs = outputs;
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
