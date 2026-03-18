import type { CopilotStreamChoice } from "../copilot/types";

/**
 * Transform a Copilot SSE stream (OpenAI format) into Anthropic SSE events.
 * Ensures prompt, agent-maestro-style message_start event as soon as stream starts.
 *
 * Tool calls are emitted immediately as content blocks (matching the original
 * agent-maestro behaviour) rather than being deferred until [DONE].
 */
export function createStreamTransformer(
  originalModel: string,
  inputTokenEstimate: number,
): TransformStream<Uint8Array, string> {
  let contentBlockIndex = -1;
  let currentBlockType: "text" | "tool_use" | null = null;
  let outputTokens = 0;
  let messageSent = false;
  let finishReason: string | null = null;
  let hasToolUse = false;

  // Track which OpenAI tool_call indices have already been emitted as
  // Anthropic content blocks (content_block_start sent).
  const emittedToolCalls: Set<number> = new Set();

  function formatSSE(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function emitMessageStart(): string {
    messageSent = true;
    return formatSSE("message_start", {
      type: "message_start",
      message: {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        model: originalModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokenEstimate,
          output_tokens: 1,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          server_tool_use: null,
          service_tier: "standard",
        },
      },
    });
  }

  function emitContentBlockStart(type: "text" | "tool_use", tool?: { id: string; name: string }): string {
    contentBlockIndex++;
    currentBlockType = type;
    if (type === "text") {
      return formatSSE("content_block_start", {
        type: "content_block_start",
        index: contentBlockIndex,
        content_block: { type: "text", text: "", citations: null },
      });
    }
    return formatSSE("content_block_start", {
      type: "content_block_start",
      index: contentBlockIndex,
      content_block: {
        type: "tool_use",
        id: tool?.id || "",
        name: tool?.name || "",
        input: {},
      },
    });
  }

  function emitTextDelta(text: string): string {
    outputTokens++;
    return formatSSE("content_block_delta", {
      type: "content_block_delta",
      index: contentBlockIndex,
      delta: { type: "text_delta", text },
    });
  }

  function emitToolInputDelta(json: string): string {
    return formatSSE("content_block_delta", {
      type: "content_block_delta",
      index: contentBlockIndex,
      delta: { type: "input_json_delta", partial_json: json },
    });
  }

  function emitContentBlockStop(): string {
    return formatSSE("content_block_stop", {
      type: "content_block_stop",
      index: contentBlockIndex,
    });
  }

  function emitMessageEnd(reason: string | null): string {
    const stopReason = hasToolUse ? "tool_use" : mapFinishReasonToAnthropic(reason);

    let output = "";
    if (currentBlockType) {
      output += emitContentBlockStop();
      currentBlockType = null;
    }
    output += formatSSE("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: {
        input_tokens: inputTokenEstimate,
        output_tokens: Math.max(outputTokens, 1),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
      },
    });
    output += formatSSE("message_stop", { type: "message_stop" });
    return output;
  }

  // Buffer to collect raw SSE text, then parse synchronously per transform call
  let sseBuffer = "";
  let done = false;
  let sentInitialMessageStart = false;

  function processSSEBuffer(controller: TransformStreamDefaultController<string>): void {
    // Split buffer into complete SSE frames (delimited by double newline)
    while (true) {
      const frameEnd = sseBuffer.indexOf("\n\n");
      if (frameEnd === -1) break;
      const frame = sseBuffer.slice(0, frameEnd).trim();
      sseBuffer = sseBuffer.slice(frameEnd + 2);
      if (!frame) continue;
      const lines = frame.split("\n");
      let data = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          data += line.slice(6);
        } else if (line.startsWith("data:")) {
          data += line.slice(5);
        }
      }
      if (!data) continue;
      if (data === "[DONE]") {
        if (!done) {
          let output = "";
          if (!sentInitialMessageStart) {
            output += emitMessageStart();
            sentInitialMessageStart = true;
          }
          output += emitMessageEnd(finishReason);
          if (output) {
            controller.enqueue(output);
          }
          done = true;
        }
        return;
      }
      try {
        const chunk = JSON.parse(data) as {
          choices: CopilotStreamChoice[];
        };
        if (!chunk.choices || chunk.choices.length === 0) continue;
        const choice = chunk.choices[0];
        let output = "";
        // Ensure message_start is sent first
        if (!sentInitialMessageStart) {
          output += emitMessageStart();
          sentInitialMessageStart = true;
        }
        if (choice.delta.content != null && choice.delta.content !== "") {
          if (currentBlockType !== "text") {
            if (currentBlockType) {
              output += emitContentBlockStop();
            }
            output += emitContentBlockStart("text");
          }
          output += emitTextDelta(choice.delta.content);
        }
        // Emit tool_calls immediately as Anthropic content blocks
        if (choice.delta.tool_calls) {
          for (const tc of choice.delta.tool_calls) {
            if (!emittedToolCalls.has(tc.index)) {
              // First chunk for this tool call — emit content_block_start
              hasToolUse = true;
              emittedToolCalls.add(tc.index);

              // Close previous block if open
              if (currentBlockType) {
                output += emitContentBlockStop();
              }

              const id = tc.id || `tool_${Date.now()}_${tc.index}`;
              const name = tc.function?.name || "";
              output += emitContentBlockStart("tool_use", { id, name });

              // Emit initial arguments chunk if present
              if (tc.function?.arguments) {
                output += emitToolInputDelta(tc.function.arguments);
              }
            } else {
              // Subsequent chunks — stream arguments as input_json_delta
              if (tc.function?.arguments) {
                output += emitToolInputDelta(tc.function.arguments);
              }
            }
          }
        }
        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }
        if (output) {
          controller.enqueue(output);
        }
      } catch {
        // Skip malformed chunks
      }
    }
  }

  return new TransformStream<Uint8Array, string>({
    transform(chunk, controller) {
      if (!sentInitialMessageStart) {
        controller.enqueue(emitMessageStart());
        sentInitialMessageStart = true;
      }
      if (done) return;
      sseBuffer += new TextDecoder().decode(chunk);
      processSSEBuffer(controller);
    },
    flush(controller) {
      if (done) return;
      if (sseBuffer.trim()) {
        sseBuffer += "\n\n";
        processSSEBuffer(controller);
      }
      if (!done) {
        let output = "";
        if (!sentInitialMessageStart) {
          output += emitMessageStart();
          sentInitialMessageStart = true;
        }
        output += emitMessageEnd(finishReason);
        if (output) {
          controller.enqueue(output);
        }
      }
    },
  });
}

function mapFinishReasonToAnthropic(reason: string | null): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return "end_turn";
  }
}
