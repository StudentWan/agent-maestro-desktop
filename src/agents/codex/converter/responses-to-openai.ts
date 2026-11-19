import type {
  CopilotCompletionRequest,
  CopilotMessage,
  CopilotToolCall,
} from "../../../copilot/types";
import {
  convertResponsesToolChoiceToOpenAI,
  convertResponsesToolsToOpenAI,
} from "./tool-converter";
import type {
  ResponsesContentPart,
  ResponsesCustomToolCallInput,
  ResponsesCustomToolCallOutputInput,
  ResponsesFunctionCallInput,
  ResponsesFunctionCallOutputInput,
  ResponsesInputItem,
  ResponsesMessageInput,
  ResponsesRequest,
} from "./types";

/**
 * Thrown by the converter when the request asks for behaviour we deliberately
 * don't support. The route handler catches this and returns HTTP 400 with the
 * carried message — see `routes/responses.ts`.
 */
export class ResponsesRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "ResponsesRequestError";
  }
}

/**
 * Convert a Codex-style OpenAI Responses request into the OpenAI
 * ChatCompletions request shape that Copilot accepts.
 *
 * The wire-format gap is moderate:
 *   - Responses sends `instructions` (system prompt) + an `input` that is
 *     either a plain string OR an ordered list of typed items (messages,
 *     function_call, function_call_output). ChatCompletions wants a flat
 *     `messages: { role, content, ... }[]` with `tool` role messages
 *     immediately following the assistant message that produced the call.
 *   - Responses tools/tool_choice live one level shallower than
 *     ChatCompletions (`{type:"function", name, parameters}` vs.
 *     `{type:"function", function:{name, parameters}}`).
 *   - `max_output_tokens` → `max_tokens`.
 *   - `previous_response_id` / `conversation` are server-side state we do
 *     not maintain — reject with HTTP 400 so Codex CLI falls back to
 *     stateless mode instead of silently dropping turns.
 *   - `reasoning.summary` is a Responses-only concept; drop it.
 *     `reasoning.effort` is currently informational only — Copilot doesn't
 *     surface a `reasoning_effort` field on ChatCompletions, so we leave
 *     it out of the request and rely on the model's default behaviour.
 */
export function convertResponsesToOpenAI(
  request: ResponsesRequest,
  options?: { reasoningEffort?: string },
): CopilotCompletionRequest {
  if (request.previous_response_id) {
    throw new ResponsesRequestError(
      "previous_response_id is not supported by this proxy — Agent Maestro Desktop is stateless. Disable Codex's stored-conversation mode.",
    );
  }
  if (request.conversation !== undefined && request.conversation !== null) {
    throw new ResponsesRequestError(
      "conversation is not supported by this proxy — Agent Maestro Desktop is stateless. Disable Codex's stored-conversation mode.",
    );
  }

  const messages: CopilotMessage[] = [];

  // Top-level `instructions` becomes a leading system message. Codex sends
  // this on every turn in stateless mode, so we always honour it.
  if (request.instructions && request.instructions.length > 0) {
    messages.push({ role: "system", content: request.instructions });
  }

  const items = normalizeInput(request.input);
  appendInputItems(messages, items);

  // If after flattening we somehow ended up with zero messages, emit a
  // placeholder user turn rather than 400'ing — matches Claude's converter
  // behaviour (`convertUserMessage` falls back to an empty user message).
  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  const result: CopilotCompletionRequest = {
    model: request.model,
    messages,
    stream: request.stream === true,
  };

  if (request.max_output_tokens !== undefined) {
    result.max_tokens = request.max_output_tokens;
  }
  if (request.temperature !== undefined) {
    result.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    result.top_p = request.top_p;
  }
  if (options?.reasoningEffort) {
    result.reasoning_effort = options.reasoningEffort;
  }

  const tools = convertResponsesToolsToOpenAI(request.tools);
  if (tools && tools.length > 0) {
    result.tools = tools;
    const toolChoice = convertResponsesToolChoiceToOpenAI(request.tool_choice);
    if (toolChoice !== undefined) {
      result.tool_choice = toolChoice;
    }
  }

  return result;
}

/**
 * Normalise the polymorphic `input` field. Older OpenAI clients send a
 * plain string; Codex CLI sends an array of typed items. We always work
 * with arrays internally.
 */
function normalizeInput(input: ResponsesRequest["input"]): ResponsesInputItem[] {
  if (typeof input === "string") {
    return [
      {
        role: "user",
        content: input,
      } satisfies ResponsesMessageInput,
    ];
  }
  return input;
}

type ToolCallInputItem =
  | ResponsesFunctionCallInput
  | ResponsesCustomToolCallInput;

type ToolOutputInputItem =
  | ResponsesFunctionCallOutputInput
  | ResponsesCustomToolCallOutputInput;

/**
 * Translate Responses `input` items into ChatCompletions `messages` while
 * strictly preserving ChatCompletions tool-call invariants:
 *   1. Every `role: "tool"` message has a non-empty `tool_call_id` matching an
 *      immediately preceding `assistant.tool_calls` entry (1-to-1).
 *   2. Standalone/orphaned `function_call_output` items (such as Codex App
 *      Desktop's `agent/browser_tabs` context items without `call_id`) degrade
 *      to plain user context messages instead of invalid `role: "tool"` turns.
 *   3. Unanswered tool calls (e.g. from interrupted turns or subagent forks)
 *      receive a synthetic tool response so call/response counts always match.
 *   4. Intervening messages injected while a tool was executing never split an
 *      `assistant.tool_calls` message from its `role: "tool"` responses.
 */
function appendInputItems(
  messages: CopilotMessage[],
  items: ResponsesInputItem[],
): void {
  const outputIndicesByCallId = new Map<string, number[]>();
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    if (!isToolOutputItem(item)) continue;
    const callId = normalizeCallId(item.call_id);
    if (!callId) continue;
    const existing = outputIndicesByCallId.get(callId);
    if (existing) {
      existing.push(idx);
    } else {
      outputIndicesByCallId.set(callId, [idx]);
    }
  }

  const consumedOutputIndices = new Set<number>();

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== "object") continue;

    if (isToolCallItem(item)) {
      const batchCalls: Array<{ index: number; item: ToolCallInputItem }> = [];
      let cursor = i;
      while (cursor < items.length) {
        const candidate = items[cursor];
        if (isToolCallItem(candidate)) {
          batchCalls.push({ index: cursor, item: candidate });
          cursor++;
          continue;
        }
        if (isIgnorableBetweenToolCalls(candidate)) {
          cursor++;
          continue;
        }
        break;
      }

      const usedIdsInBatch = new Set<string>();
      const toolCalls: CopilotToolCall[] = [];
      const toolResponses: CopilotMessage[] = [];

      for (const { index: callIdx, item: callItem } of batchCalls) {
        const rawCallId = normalizeCallId(callItem.call_id);
        let matchedOutputIdx: number | undefined;
        if (rawCallId) {
          const queue = outputIndicesByCallId.get(rawCallId);
          if (queue) {
            while (
              queue.length > 0 &&
              (queue[0] <= callIdx || consumedOutputIndices.has(queue[0]))
            ) {
              queue.shift();
            }
            if (queue.length > 0) {
              matchedOutputIdx = queue.shift();
              if (matchedOutputIdx !== undefined) {
                consumedOutputIndices.add(matchedOutputIdx);
              }
            }
          }
        }

        let effectiveCallId = rawCallId ?? `call_missing_${callIdx}`;
        if (usedIdsInBatch.has(effectiveCallId)) {
          effectiveCallId = `${effectiveCallId}_${callIdx}`;
        }
        usedIdsInBatch.add(effectiveCallId);

        const toolName =
          typeof callItem.name === "string" && callItem.name.trim().length > 0
            ? callItem.name.trim()
            : "unknown_tool";
        const toolArguments =
          callItem.type === "custom_tool_call"
            ? serializeCustomToolInput(callItem.input)
            : typeof callItem.arguments === "string"
              ? callItem.arguments
              : JSON.stringify(callItem.arguments ?? {});

        toolCalls.push({
          id: effectiveCallId,
          type: "function",
          function: {
            name: toolName,
            arguments: toolArguments,
          },
        });

        const outputContent =
          matchedOutputIdx !== undefined
            ? stringifyToolOutput(
                (items[matchedOutputIdx] as ToolOutputInputItem).output,
              )
            : "[No tool output recorded]";

        toolResponses.push({
          role: "tool",
          content: outputContent,
          tool_call_id: effectiveCallId,
        });
      }

      messages.push({
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
      });
      messages.push(...toolResponses);

      i = cursor - 1;
      continue;
    }

    if (isToolOutputItem(item)) {
      if (consumedOutputIndices.has(i)) {
        continue;
      }
      const standaloneText = formatStandaloneToolOutput(item);
      if (standaloneText !== null) {
        messages.push({
          role: "user",
          content: standaloneText,
        });
      }
      continue;
    }

    if (item.type === "message" || item.type === undefined) {
      const role = item.role;
      const text = stringifyMessageContent(item.content);
      // Skip empty assistant text items left behind by empty/aborted turns;
      // Gemini ChatCompletions rejects or stalls on empty model turns.
      if (role === "assistant" && text === "") {
        continue;
      }
      // System / developer roles in Responses both map to the OpenAI
      // "system" role since Copilot's ChatCompletions doesn't model
      // "developer" separately.
      const mappedRole: CopilotMessage["role"] =
        role === "developer" ? "system" : role;
      messages.push({ role: mappedRole, content: text });
      continue;
    }

    // Unknown item type — ignore rather than blow up. Future Responses
    // additions (e.g. reasoning, additional_tools, refusal) remain transparent.
  }
}

function isToolCallItem(item: ResponsesInputItem): item is ToolCallInputItem {
  return (
    Boolean(item) &&
    typeof item === "object" &&
    (item.type === "function_call" || item.type === "custom_tool_call")
  );
}

function isToolOutputItem(
  item: ResponsesInputItem,
): item is ToolOutputInputItem {
  return (
    Boolean(item) &&
    typeof item === "object" &&
    (item.type === "function_call_output" ||
      item.type === "custom_tool_call_output")
  );
}

function isIgnorableBetweenToolCalls(item: ResponsesInputItem): boolean {
  if (!item || typeof item !== "object") return true;
  if (isToolCallItem(item) || isToolOutputItem(item)) return false;
  if (item.type === "message" || item.type === undefined) {
    return (
      item.role === "assistant" &&
      stringifyMessageContent(item.content) === ""
    );
  }
  return true;
}

function normalizeCallId(callId: unknown): string | undefined {
  if (typeof callId !== "string") return undefined;
  const trimmed = callId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function serializeCustomToolInput(
  input:
    | string
    | ResponsesContentPart[]
    | Record<string, unknown>
    | undefined
    | null,
): string {
  if (input === undefined || input === null) {
    return "{}";
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return JSON.stringify(input);
  }
  return JSON.stringify({ input: stringifyToolOutput(input) });
}

function formatStandaloneToolOutput(item: ToolOutputInputItem): string | null {
  const body = stringifyToolOutput(item.output);
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const namespace =
    typeof item.namespace === "string" ? item.namespace.trim() : "";
  const callId = normalizeCallId(item.call_id) ?? "";

  const qualifier =
    namespace && name
      ? `${namespace}/${name}`
      : name || namespace || callId;

  if (!body && !qualifier) {
    return null;
  }

  const header = qualifier ? `[Tool output: ${qualifier}]` : "[Tool output]";
  return body ? `${header}\n${body}` : header;
}

function stringifyToolOutput(
  output: string | ResponsesContentPart[] | Record<string, unknown> | undefined | null,
): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const text = stringifyMessageContent(output);
    return text || JSON.stringify(output);
  }
  if (typeof output === "object") {
    return JSON.stringify(output);
  }
  return String(output);
}

/**
 * Flatten a `content` field (string or content-parts array) into a single
 * string for the ChatCompletions side. Copilot's `chat/completions` accepts
 * plain string content; we drop image parts with a placeholder so the
 * surrounding text isn't lost.
 */
function stringifyMessageContent(
  content: string | ResponsesContentPart[] | undefined,
): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;

  let out = "";
  for (const part of content) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        out += part.text ?? "";
        break;
      case "input_image":
      case "image_url":
        // Copilot's chat completions endpoint doesn't accept inline images
        // for every model — drop with a marker so we don't silently change
        // the prompt's meaning.
        out += "[Image content omitted]";
        break;
      default:
        // Unknown part type — skip.
        break;
    }
  }
  return out;
}
