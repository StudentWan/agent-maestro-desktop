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
  for (const item of items) {
    appendItem(messages, item);
  }

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

/**
 * Translate one Responses input item into the equivalent ChatCompletions
 * messages and append them. Function-call output items become `tool` role
 * messages — they MUST follow the assistant message carrying the matching
 * `tool_calls`, which the upstream Codex CLI already orders correctly, so we
 * preserve the source order.
 */
function appendItem(
  messages: CopilotMessage[],
  item: ResponsesInputItem,
): void {
  switch (item.type) {
    case "function_call": {
      const call: CopilotToolCall = {
        id: item.call_id,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments ?? "",
        },
      };
      // Tool-call items live as their own assistant turn in the Responses
      // wire format. ChatCompletions requires the calls to be attached to
      // an assistant message — emit one with empty content per turn so we
      // don't accidentally merge separate tool-call rounds.
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [call],
      });
      return;
    }

    case "function_call_output": {
      messages.push({
        role: "tool",
        content: item.output ?? "",
        tool_call_id: item.call_id,
      });
      return;
    }

    case "message":
    case undefined: {
      // Plain message: role + content (string or content parts array).
      const role = item.role;
      const text = stringifyMessageContent(item.content);
      // System / developer roles in Responses both map to the OpenAI
      // "system" role since Copilot's ChatCompletions doesn't model
      // "developer" separately.
      const mappedRole: CopilotMessage["role"] =
        role === "developer" ? "system" : role;
      messages.push({ role: mappedRole, content: text });
      return;
    }

    default: {
      // Unknown item type — ignore rather than blow up. Future Responses
      // additions (e.g. image_url, refusal) will be transparent to us.
      return;
    }
  }
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
    switch (part.type) {
      case "input_text":
      case "output_text":
        out += part.text;
        break;
      case "input_image":
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
