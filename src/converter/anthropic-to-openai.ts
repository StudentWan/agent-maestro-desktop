import type { CopilotCompletionRequest, CopilotMessage } from "../copilot/types";
import { mapModelName, getModelMaxTokens } from "./model-mapper";
import { convertToolsToOpenAI, convertToolChoiceToOpenAI } from "./tool-converter";
import type { AnthropicRequest, AnthropicMessage, AnthropicContentBlock } from "./types";

/**
 * Convert an Anthropic Messages API request to a Copilot/OpenAI ChatCompletion request
 */
export function convertAnthropicToOpenAI(request: AnthropicRequest): CopilotCompletionRequest {
  const copilotModel = mapModelName(request.model);
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
    max_tokens: Math.min(request.max_tokens, getModelMaxTokens(copilotModel)),
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
 * Convert a single Anthropic message to one or more OpenAI messages
 */
function convertMessage(msg: AnthropicMessage): CopilotMessage[] {
  // Simple string content
  if (typeof msg.content === "string") {
    return [{ role: msg.role, content: msg.content }];
  }

  // Array content — need to handle tool_use/tool_result blocks specially
  const messages: CopilotMessage[] = [];
  let textAccum = "";
  const toolCalls: CopilotMessage["tool_calls"] = [];

  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        textAccum += block.text;
        break;

      case "image":
        // Skip images for now — Copilot may not support vision
        textAccum += "[Image content omitted]";
        break;

      case "thinking":
      case "redacted_thinking":
        // Filter out thinking blocks — not supported by Copilot
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

      case "tool_result":
        // Tool results become separate "tool" role messages
        // Flush any accumulated text first
        if (textAccum) {
          messages.push({ role: msg.role, content: textAccum });
          textAccum = "";
        }

        const resultContent = getToolResultContent(block);
        messages.push({
          role: "tool",
          content: resultContent,
          tool_call_id: block.tool_use_id,
        });
        break;
    }
  }

  // Handle assistant message with tool calls
  if (msg.role === "assistant" && toolCalls.length > 0) {
    messages.push({
      role: "assistant",
      content: textAccum || null,
      tool_calls: toolCalls,
    });
  } else if (textAccum) {
    messages.push({ role: msg.role, content: textAccum });
  }

  // If no messages were generated, add an empty one to avoid dropping the turn
  if (messages.length === 0) {
    messages.push({ role: msg.role, content: "" });
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
