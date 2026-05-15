import type { CopilotCompletionResponse } from "../../../copilot/types";
import type {
  ResponsesOutputItem,
  ResponsesResponse,
} from "./types";

/**
 * Convert a non-streaming OpenAI ChatCompletions response into the
 * OpenAI Responses API shape that Codex CLI expects. Streaming uses the
 * `stream-transformer.ts` instead — this is the simple, single-shot path.
 *
 * The mapping is mostly mechanical:
 *   - `id` is reused (Codex doesn't care about prefix conventions, but keep
 *     `resp_` for clarity).
 *   - `usage.{prompt_tokens, completion_tokens, total_tokens}`
 *     → `usage.{input_tokens, output_tokens, total_tokens}`.
 *   - The single OpenAI choice's text + tool_calls become two kinds of
 *     output items: `message` for any text and one `function_call` per
 *     tool call. Codex CLI iterates `output[]` in order, so we keep text
 *     first to match its expectations.
 */
export function convertOpenAIToResponses(
  copilotResponse: CopilotCompletionResponse,
  originalModel: string,
): ResponsesResponse {
  const choice = copilotResponse.choices[0];
  const output: ResponsesOutputItem[] = [];
  let messageCounter = 0;
  let callCounter = 0;

  if (choice?.message) {
    if (choice.message.content && choice.message.content.length > 0) {
      output.push({
        id: `msg_${copilotResponse.id || Date.now()}_${messageCounter++}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: choice.message.content,
          },
        ],
      });
    }

    if (choice.message.tool_calls) {
      for (const call of choice.message.tool_calls) {
        if (call.type !== "function") continue;
        output.push({
          id: `fc_${copilotResponse.id || Date.now()}_${callCounter++}`,
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments ?? "",
          status: "completed",
        });
      }
    }
  }

  return {
    id: `resp_${copilotResponse.id || Date.now()}`,
    object: "response",
    created_at: copilotResponse.created || Math.floor(Date.now() / 1000),
    status: "completed",
    model: originalModel,
    output,
    usage: {
      input_tokens: copilotResponse.usage?.prompt_tokens ?? 0,
      output_tokens: copilotResponse.usage?.completion_tokens ?? 0,
      total_tokens: copilotResponse.usage?.total_tokens,
    },
    error: null,
    conversation_id: null,
  };
}
