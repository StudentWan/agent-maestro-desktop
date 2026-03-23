import type { CopilotCompletionRequest, CopilotMessage } from "../copilot/types";
import { mapModelName } from "./model-mapper";
import { convertToolsToOpenAI, convertToolChoiceToOpenAI } from "./tool-converter";
import type { AnthropicRequest, AnthropicMessage, AnthropicContentBlock } from "./types";

/**
 * Convert an Anthropic Messages API request to a Copilot/OpenAI ChatCompletion request.
 *
 * When `headers` are provided, the `anthropic-beta` header is inspected for
 * `context-1m` to resolve the correct 1M-context model variant.
 */
export function convertAnthropicToOpenAI(
  request: AnthropicRequest,
  headers?: Record<string, string | undefined>,
): CopilotCompletionRequest {
  const resolvedModel = resolveModelFromHeaders(request.model, headers);
  const copilotModel = mapModelName(resolvedModel);
  const messages: CopilotMessage[] = [];

  // Convert system prompt to system message
  if (request.system) {
    const systemText = typeof request.system === "string"
      ? request.system
      : request.system.map((block) => block.text).join("\n\n");

    messages.push({ role: "system", content: systemText });
  }

  // Convert messages
  for (const msg of request.messages) {
    const converted = convertMessage(msg);
    messages.push(...converted);
  }

  const result: CopilotCompletionRequest = {
    model: copilotModel,
    messages,
    stream: request.stream ?? false,
    max_tokens: request.max_tokens,
  };

  if (request.temperature !== undefined) {
    result.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    result.top_p = request.top_p;
  }
  if (request.stop_sequences) {
    result.stop = request.stop_sequences;
  }

  const tools = convertToolsToOpenAI(request.tools);
  if (tools && tools.length > 0) {
    result.tools = tools;
    const toolChoice = convertToolChoiceToOpenAI(request.tool_choice);
    if (toolChoice) {
      result.tool_choice = toolChoice;
    }
  }

  return result;
}

/**
 * Convert a single Anthropic message to one or more OpenAI messages.
 *
 * In the Anthropic API, tool_result blocks live inside user messages.
 * In the OpenAI API, tool results are separate "tool" role messages that
 * MUST immediately follow the assistant message containing the corresponding
 * tool_calls. Therefore, for user messages we emit tool results first,
 * then any remaining text content.
 */
function convertMessage(msg: AnthropicMessage): CopilotMessage[] {
  // Simple string content
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  if (msg.role === "assistant") {
    return convertAssistantMessage(msg.content);
  }

  return convertUserMessage(msg.content);
}

/**
 * Convert an assistant message's content blocks.
 * Collects text and tool_use blocks into a single assistant message.
 */
function convertAssistantMessage(content: AnthropicContentBlock[]): CopilotMessage[] {
  let textAccum = "";
  const toolCalls: NonNullable<CopilotMessage["tool_calls"]> = [];

  for (const block of content) {
    switch (block.type) {
      case "text":
        textAccum += block.text;
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
        break;
      case "thinking":
      case "redacted_thinking":
        // Filter out thinking blocks — not supported by Copilot
        break;
    }
  }

  if (toolCalls.length > 0) {
    return [{
      role: "assistant",
      content: textAccum || null,
      tool_calls: toolCalls,
    }];
  }

  return [{ role: "assistant", content: textAccum || "" }];
}

/**
 * Convert a user message's content blocks.
 *
 * OpenAI requires that "tool" role messages immediately follow the assistant
 * message that produced the tool_calls. So we emit tool results FIRST,
 * then any remaining text as a user message.
 */
function convertUserMessage(content: AnthropicContentBlock[]): CopilotMessage[] {
  const toolResults: CopilotMessage[] = [];
  let textAccum = "";

  for (const block of content) {
    switch (block.type) {
      case "text":
        textAccum += block.text;
        break;
      case "image":
        textAccum += "[Image content omitted]";
        break;
      case "tool_result": {
        const resultContent = getToolResultContent(block);
        toolResults.push({
          role: "tool",
          content: resultContent,
          tool_call_id: block.tool_use_id,
        });
        break;
      }
      case "thinking":
      case "redacted_thinking":
        break;
    }
  }

  // Emit tool results first (they must follow the assistant's tool_calls),
  // then text content as a user message
  const messages: CopilotMessage[] = [...toolResults];

  if (textAccum) {
    messages.push({ role: "user", content: textAccum });
  }

  // If no messages were generated, add an empty one to avoid dropping the turn
  if (messages.length === 0) {
    messages.push({ role: "user", content: "" });
  }

  return messages;
}

function getToolResultContent(block: AnthropicContentBlock & { type: "tool_result" }): string {
  if (!block.content) return "";

  if (typeof block.content === "string") {
    return block.content;
  }

  return block.content
    .map((c) => {
      if (c.type === "text" && c.text) return c.text;
      return JSON.stringify(c);
    })
    .join("\n");
}

/**
 * Resolve the model ID based on the `anthropic-beta` header.
 *
 * Claude Code signals that it wants the 1M-context variant via the
 * `anthropic-beta` header (e.g. `context-1m-2025-08-07`). The Copilot LM API
 * exposes these as separate model IDs (e.g. `claude-opus-4.6-1m`), so we
 * append `-1m` when the beta header is present.
 *
 * This function is idempotent: if the model already ends with `-1m`, it is
 * returned unchanged.
 */
function resolveModelFromHeaders(
  model: string,
  headers?: Record<string, string | undefined>,
): string {
  if (!headers) {
    return model;
  }

  const betaHeader = headers["anthropic-beta"];
  if (betaHeader && /\bcontext-1m\b/.test(betaHeader)) {
    if (model.endsWith("-1m")) {
      return model;
    }
    return `${model}-1m`;
  }

  return model;
}
