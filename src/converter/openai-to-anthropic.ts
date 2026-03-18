import type { CopilotCompletionResponse } from "../copilot/types";
import type { AnthropicResponse, AnthropicResponseBlock } from "./types";

/**
 * Convert a non-streaming OpenAI/Copilot response to Anthropic Messages format
 */
export function convertOpenAIToAnthropic(
  copilotResponse: CopilotCompletionResponse,
  originalModel: string,
): AnthropicResponse {
  const choice = copilotResponse.choices[0];
  if (!choice?.message) {
    return buildEmptyResponse(originalModel);
  }

  const content: AnthropicResponseBlock[] = [];

  // Convert text content
  if (choice.message.content) {
    content.push({
      type: "text",
      text: choice.message.content,
      citations: null,
    });
  }

  // Convert tool calls
  if (choice.message.tool_calls) {
    for (const toolCall of choice.message.tool_calls) {
      if (toolCall.type === "function") {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(toolCall.function.arguments);
        } catch {
          input = { raw: toolCall.function.arguments };
        }

        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input,
        });
      }
    }
  }

  const hasToolUse = content.some((b) => b.type === "tool_use");
  const stopReason = mapFinishReason(choice.finish_reason, hasToolUse);

  return {
    id: `msg_${copilotResponse.id || Date.now()}`,
    type: "message",
    role: "assistant",
    model: originalModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: copilotResponse.usage?.prompt_tokens ?? 0,
      output_tokens: copilotResponse.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

function mapFinishReason(
  finishReason: string | null,
  hasToolUse: boolean,
): string {
  if (hasToolUse) return "tool_use";

  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}

function buildEmptyResponse(model: string): AnthropicResponse {
  return {
    id: `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
  };
}
